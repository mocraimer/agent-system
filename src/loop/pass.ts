import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { admit } from '../core/admission.js';
import { authorizeDispatch } from '../core/authorize.js';
import { integrationBase } from '../core/floor.js';
import type { Outcome } from '../core/outcome.js';
import { listRuns } from '../core/run.js';
import { alive, killGroup } from '../core/proc.js';
import { newId, readJson, stateRoot, writeJson } from '../core/store.js';
import type { AdapterFactory } from '../commands.js';
import { adapterFor, dispatchTask, recoverUnsettled } from '../commands.js';
import { listScorecards, recordLoop, recordRepairCycle, recordReview } from '../eval/scorecard.js';
import { short, slugDir, ticketOf } from './context.js';
import { answerAsks, answerKey, answerOnce } from './operator-answer.js';
import { ACCEPT_FINDINGS_LABEL, REVIEW_AGAIN_LABEL, syncStatusLabels } from './labels.js';
import {
  findingsAcceptedAt, LOOP_SIGNATURE, newestReviewRestart, parseFaultMarker, renderAcceptedMarker, renderReviewAgainMarker, ticketsNamedBy, useMarkerPrefix,
} from './markers.js';
import type { Repo } from './git.js';
import type { Comment, Issue, PullCommit, PullRequest, Store } from './github.js';
import { buildBoard } from '../console/facts.js';
import { readPauses } from '../console/pauses.js';
import type { SnapshotSource } from '../console/snapshot.js';
import { renderMessage, transition } from './notify.js';
import type { Messenger } from './notify.js';
import { limit, numericLimit, parseStoreConfig, rung, STORE_CONFIG_PATH } from './policy.js';
import { loadQueueRules } from './queues.js';
import type { QueueRules } from './queues.js';
import { planAssess } from './stages/assess.js';
import { planFix } from './stages/fix.js';
import { planClose } from './stages/close.js';
import { planMerge } from './stages/merge.js';
import { planRelease } from './stages/release.js';
import { outsideReviewRules, planReview } from './stages/review.js';
import { planShape } from './stages/shape.js';
import { planSweep } from './stages/sweep.js';
import { planVerify } from './stages/verify.js';
import { improveDue, improveSettings, planImprove } from './stages/improve.js';
import type { ImproveDeps } from './stages/improve.js';
import type { LoopState, PassReport, StageReport } from './supervisor.js';
import {
  classify, emptyState, postStatus, renderPassLog, renderStatus, reportFaults, stageReport,
} from './supervisor.js';
import type { ActResult, Fault, LoopCommands, PassContext, PassOptions, ReviewedState, StageName, StagePlan } from './types.js';
import { STAGES } from './types.js';

const PLANNERS: Record<StageName, (ctx: PassContext) => Promise<StagePlan>> = {
  shape: planShape,
  assess: planAssess,
  sweep: planSweep,
  review: planReview,
  fix: planFix,
  merge: planMerge,
  close: planClose,
  release: planRelease,
  verify: planVerify,
};

/** Where the loop keeps its state for one target repository. */
export const loopDir = (slug: string): string => join(stateRoot(), 'loop', slugDir(slug));

export function readState(slug: string): LoopState {
  return readJson<LoopState>(join(loopDir(slug), 'state.json')) ?? emptyState(slug);
}

function writeState(state: LoopState): void {
  writeJson(join(loopDir(state.repo), 'state.json'), state);
}

/* --------------------------------------------------------------------- lock */

export class LoopBusyError extends Error {
  override readonly name = 'LoopBusyError';
}

const lockPath = (slug: string): string => join(stateRoot(), 'locks', `loop-${slugDir(slug)}.pid`);


/**
 * One loop per target repository, held for the life of the loop process.
 *
 * Not the store's short-section lock, which breaks after a minute unrefreshed: a
 * pass can run for an hour. This lock names its holder's pid, and a holder that
 * is no longer running has no claim to it — which is how a loop killed mid-pass
 * leaves nothing that blocks the next one.
 */
export function acquireLoopLock(slug: string): () => void {
  const path = lockPath(slug);
  mkdirSync(join(stateRoot(), 'locks'), { recursive: true });
  const held = readJson<{ pid: number; host: string; startedAt: string }>(path);
  if (held && held.pid !== process.pid && held.host === hostname() && alive(held.pid)) {
    throw new LoopBusyError(`A loop for ${slug} is already running as process ${held.pid} (since ${held.startedAt}). Stop it before starting another.`);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), 'utf8');
  return () => {
    const current = readJson<{ pid: number }>(path);
    if (current?.pid === process.pid) rmSync(path, { force: true });
  };
}

/* ------------------------------------------------------------ production wiring */

/** The coordinator's own dispatch, authority, admission and scorecard paths, as the loop uses them. */
export function coordinatorCommands(factory: AdapterFactory = adapterFor, log: (line: string) => void = () => {}): LoopCommands {
  const readiness = new Map<string, Promise<Outcome | undefined>>();
  const guarded = (what: string, fn: () => unknown): void => {
    try {
      fn();
    } catch (err) {
      log(`scorecard: could not record ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    dispatch: (input) => dispatchTask(input, factory),
    authorize: authorizeDispatch,
    readiness: (runtime, entry = 'prompt') => {
      const key = `${runtime}:${entry}`;
      if (!readiness.has(key)) readiness.set(key, factory(runtime).checkReadiness(entry));
      return readiness.get(key)!;
    },
    admissionPreview: async (runtime, taskId, estimate) => {
      const adapter = factory(runtime);
      const decision = await admit({
        subscriptionId: adapter.capabilities.subscriptionId, taskId, runId: `preview-${taskId}`, estimate,
        readUsage: () => adapter.readUsage(), preview: true,
      });
      return decision.admitted
        ? { admitted: true, windows: decision.windows }
        : { admitted: false, reason: decision.outcome?.summary ?? 'refused', windows: decision.windows };
    },
    recover: async () => { await recoverUnsettled(undefined, factory); },
    inFlight: (taskId) => listRuns().some((r) => r.taskId === taskId && r.status === 'running'),
    wroteComment: (commentId) => listScorecards().some((c) => c.loop?.wrote === `comment ${commentId}`),
    reviewsRun: (repo, pr) => {
      const reviews = listRuns().filter((r) => r.repo === repo && r.workClass === 'loop-review' && r.loop?.stage === 'review' && r.loop.item === `PR #${pr}`
        && r.loop.head !== undefined
        // A run the runtime never started, or whose prompt was never sent, reviewed nothing.
        && r.runtimeDispatched !== false && r.promptNotSent !== true && r.status !== 'quota-waiting')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const seen = new Set<string>();
      return reviews.flatMap((r): ReviewedState[] => {
        const state = { head: r.loop!.head!.toLowerCase(), ...(r.loop!.bodyDigest ? { bodyDigest: r.loop!.bodyDigest.toLowerCase() } : {}) };
        const key = `${state.head}:${state.bodyDigest ?? ''}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [state];
      });
    },
    attestedDescription: (repo, pr, head) => {
      const attested = listRuns().filter((r) => r.repo === repo && r.delivery?.status === 'delivered' &&
        r.delivery.source === 'operator-attested')
        .map((r) => r.loop?.attestedDelivery)
        .filter((d) => d?.kind === 'description' && d.pr === pr && d.head === head)
        .sort((a, b) => b!.at.localeCompare(a!.at))[0];
      return attested ? { ...(attested.reviewCommentAtAttestation ? { reviewCommentAtAttestation: attested.reviewCommentAtAttestation } : {}),
        ...(attested.round ? { round: attested.round } : {}), ...(attested.bodyDigest ? { bodyDigest: attested.bodyDigest } : {}) } : undefined;
    },
    recordLoop: (taskId, record) => guarded(`the loop record for ${taskId}`, () => recordLoop(`card_${taskId}`, record)),
    recordReview: (taskId, input) => guarded(`the review for ${taskId}`, () => recordReview(`card_${taskId}`, input)),
    recordRepair: (taskId, input) => guarded(`the repair for ${taskId}`, () => recordRepairCycle(`card_${taskId}`, input)),
    exec: (command, args, options) => new Promise((resolve) => {
      // Its own process group, so a timeout stops a test runner's browsers too.
      const proc = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      const timer = setTimeout(() => { if (proc.pid !== undefined) killGroup(proc.pid); }, options.timeoutMs);
      proc.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    }),
  };
}

export interface PassDeps {
  repo: Repo;
  store: Store;
  commands: LoopCommands;
  /** Queue rules; loaded from the repository when absent. */
  rules?: QueueRules;
  log?: (line: string) => void;
  now?: () => Date;
  /** Aborted when the loop is asked to stop: the pass finishes the item in hand and goes no further. */
  signal?: AbortSignal;
  /** Pulls the operator in when something new needs them; absent, the pass notifies nobody. */
  notify?: NotifyDeps;
  /** What the improve stage proposes through; absent, it ranks and reports but cannot propose. */
  improve?: ImproveDeps;
}

export interface NotifyDeps {
  /** A fresh read of the store, from which the pass works out what needs the operator. */
  snapshots: SnapshotSource;
  /** The GitHub login the status comment mentions. */
  mention?: string;
  messenger: Messenger | { skipped: string };
}

/** The refs on the board's Needs-you column, read fresh. */
async function needsYouNow(ctx: PassContext, source: SnapshotSource): Promise<string[]> {
  const snapshot = await source.read({ issues: [], pulls: [] });
  const board = buildBoard({
    read: { snapshot },
    coordinator: {
      runsInFlight: listRuns().filter((r) => r.status === 'running').map((r) => ({ runId: r.id, taskId: r.taskId, runtime: r.runtime, startedAt: r.startedAt })),
      scorecards: [],
      paused: readPauses(ctx.slug),
    },
    rules: ctx.rules,
    policy: ctx.policy,
  });
  return board.items.filter((i) => i.column === 'Needs you').map((i) => i.ref);
}

/**
 * One pass over every stage.
 *
 * Reads the store, the policy and the queue rules once; plans each stage in
 * order and, unless this is a dry run, acts on what it planned. Anything a stage
 * throws is caught, reported as that stage's fault, and does not stop the stages
 * after it. The supervisor then classifies the pass, updates the status comment,
 * and opens or updates one issue per fault — none of which a dry run does.
 */
export async function runPass(deps: PassDeps, options: PassOptions): Promise<PassReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const passId = newId('pass');
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); deps.log?.(line); };
  const slug = await deps.repo.slug();
  const state = readState(slug);
  const stages: StageReport[] = [];
  const faults: Fault[] = [];
  let statusHome: string | undefined;
  let stallAfter = Number.POSITIVE_INFINITY;
  let ctx: PassContext | undefined;

  try {
    ctx = await buildContext(deps, options, { slug, passId, startedAt, state, log });
    statusHome = limit(ctx.policy, 'status home').value;
    stallAfter = numericLimit(ctx.policy, 'stalled after passes');
    if (!options.dryRun) await deps.commands.recover();
  } catch (err) {
    faults.push({ stage: 'setup', kind: 'error', subject: 'pass setup', detail: 'the pass could not read its policy or the store', evidence: err instanceof Error ? err.message : String(err) });
  }

  let ranImprove = false;
  /** Act on a stage's plan, unless this is a dry run, and report it. */
  const act = async (c: PassContext, plan: StagePlan): Promise<void> => {
    if (!options.dryRun) {
      for (const item of plan.items) {
        if (item.decision.kind !== 'dispatch' || !item.act) continue;
        if (deps.signal?.aborted) {
          item.result = { produced: false, summary: 'not started: the loop was asked to stop' };
          continue;
        }
        try {
          item.result = await item.act();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          item.result = { produced: false, summary: `error: ${message}`, blocked: `error: ${message}` };
          plan.faults.push({ stage: plan.stage, kind: 'error', subject: item.ref, detail: 'acting on the item threw', evidence: err instanceof Error ? err.stack ?? message : message });
        }
        plan.faults.push(...(item.result.faults ?? []));
        const n = Number(/#(\d+)/.exec(item.ref)?.[1]);
        if (Number.isInteger(n)) c.forget(n);
      }
      // After the items have acted: what an operator's label came to is told on the pull request.
      if (!deps.signal?.aborted) await answerAsks(c, plan);
    }
    faults.push(...plan.faults);
    stages.push(stageReport(plan));
  };

  if (ctx) {
    // Before any stage reads it: an acceptance is about the head the person was
    // looking at, so it is written down against that head and the label taken
    // back. Left as a label it would go on accepting whatever got pushed next.
    if (!options.dryRun) {
      try {
        for (const line of await pinAcceptances(ctx)) log(line);
      } catch (err) {
        // This runs before any stage. Letting it throw would cost the whole pass
        // over one label, so whatever is left waits for the next one instead.
        log(`pass ${passId}: stopped pinning acceptances: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        for (const line of await restartReviews(ctx)) log(line);
      } catch (err) {
        log(`pass ${passId}: stopped restarting reviews: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const wanted = options.stages ?? STAGES.map((s) => s.name);
    const planned: StagePlan[] = [];
    const paused = readPauses(slug);
    for (const { name, rung: rungName } of STAGES) {
      if (!wanted.includes(name)) continue;
      if (deps.signal?.aborted) {
        log(`pass ${passId}: asked to stop; ${name} and the stages after it were not started`);
        break;
      }
      const pause = paused[name];
      if (pause) {
        const note = `stage paused by operator ${pause.by} since ${pause.at}; nothing dispatched from it`;
        log(`pass ${passId}: ${name} ${note}`);
        const r = rung(ctx.policy, rungName);
        stages.push({ stage: name, rung: `${r.number} ${r.name}`, counts: { queue: 0, dispatched: 0, produced: 0, blocked: 0, waiting: 0 }, items: [], notes: [note] });
        continue;
      }
      let plan: StagePlan;
      try {
        plan = await PLANNERS[name](ctx);
      } catch (err) {
        faults.push({ stage: name, kind: 'error', subject: `${name} stage`, detail: 'planning the stage threw', evidence: err instanceof Error ? err.stack ?? err.message : String(err) });
        continue;
      }
      planned.push(plan);
      await act(ctx, plan);
    }

    // The improve stage runs on its own, longer interval, or when named.
    if (!deps.signal?.aborted) {
      try {
        const settings = improveSettings(ctx.policy);
        const wantImprove = options.stages
          ? options.stages.includes('improve')
          : !('missing' in settings) && improveDue(settings, state.lastImprove, startedAt);
        if (wantImprove) {
          await act(ctx, await planImprove(ctx, deps.improve));
          ranImprove = true;
        }
      } catch (err) {
        faults.push({ stage: 'improve', kind: 'error', subject: 'improve stage', detail: 'planning the stage threw', evidence: err instanceof Error ? err.stack ?? err.message : String(err) });
      }
    }

    // After every stage, because a pull request's status is the strongest thing
    // any of them said about it, and a partial pass saw only part of that.
    const wholePass = !options.stages && !deps.signal?.aborted;
    if (!options.dryRun && wholePass) {
      try {
        for (const line of await syncStatusLabels(ctx.store, ctx.pulls, ctx.base, planned)) log(line);
      } catch (err) {
        // A label is how the pass is read, not how it acts: failing to write one
        // must not discard the work the pass already did.
        log(`pass ${passId}: status labels not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // A pass cut short by a stop request is not evidence about the stages: the items
  // it did not start would read as a stall, and a process killed by the stop as an
  // error. It keeps the streaks it found and reports only breaches, which are real
  // whenever they are seen.
  const stopped = deps.signal?.aborted === true;
  const counted = classify(stages, faults, state.streaks, ctx && !stopped ? stallAfter : Number.POSITIVE_INFINITY, options.dryRun);
  const { classification, stalls } = counted;
  const because = stopped ? `stopped early by request — ${counted.because}` : counted.because;
  const streaks = stopped ? state.streaks : counted.streaks;
  faults.push(...stalls);
  const reportable = stopped ? faults.filter((f) => f.kind === 'breach') : faults;
  if (stopped) log(`pass ${passId}: stopped early; stall streaks kept as they were and ${faults.length - reportable.length} fault(s) from the stop not reported`);
  const report: PassReport = {
    passId, repo: slug, dryRun: options.dryRun, startedAt: startedAt.toISOString(), endedAt: now().toISOString(),
    // A pass that cannot read its policy has work it cannot see; that is not idle.
    classification: ctx ? classification : 'stalled', because: ctx ? because : `the pass could not start: ${faults[0]?.evidence ?? 'unknown'}`,
    stages, faults,
  };

  log(renderPassLog(report));

  if (!options.dryRun) {
    const next: LoopState = {
      ...state, faults: { ...state.faults }, passes: state.passes + 1, streaks, lastPass: report,
      ...(ranImprove ? { lastImprove: startedAt.toISOString() } : {}),
    };
    const at = report.endedAt;
    try {
      const faultLabels = statusHome ? [statusHome] : [];
      const isCompletePass = !options.stages && !stopped;
      for (const line of await reportFaults(deps.store, next, reportable, passId, at, faultLabels, isCompletePass)) log(line);
    } catch (err) {
      log(`supervisor: could not report faults: ${err instanceof Error ? err.message : String(err)}`);
    }
    let notice: string | undefined;
    if (ctx && deps.notify) {
      try {
        const known = new Set(Object.values(state.faults).map((f) => f.issue));
        const newFaults = Object.values(next.faults).filter((f) => !known.has(f.issue)).map((f) => ({ issue: f.issue, title: f.title }));
        const t = transition(state.needsYou, await needsYouNow(ctx, deps.notify.snapshots), newFaults);
        next.needsYou = t.remember;
        notice = t.reason;
      } catch (err) {
        // Without a fresh read the pass cannot tell a transition, so it keeps what it knew and says nothing.
        log(`notify: could not read what needs you: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let tracking: number | undefined;
    try {
      if (ctx && statusHome) {
        tracking = ctx.rules.trackingIssue(ctx.issues, statusHome).number;
        const mention = notice && deps.notify?.mention ? `@${deps.notify.mention} — ${notice}` : undefined;
        const id = await postStatus(deps.store, tracking, renderStatus(report, next, tracking, mention));
        log(`supervisor: status comment ${id} on #${tracking} updated${mention ? `, mentioning @${deps.notify!.mention}` : ''}`);
      }
    } catch (err) {
      log(`supervisor: could not update the status comment: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (notice && deps.notify) {
      const messenger = deps.notify.messenger;
      if ('skipped' in messenger) {
        log(`notification skipped: ${messenger.skipped}`);
      } else {
        try {
          await messenger.send(renderMessage(slug, notice, tracking));
          log(`notify: sent — ${notice}`);
        } catch (err) {
          log(`notify: the message was not sent: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    writeState(next);
    appendPassLog(slug, `${lines.join('\n')}\n\n`);
  }
  return report;
}

/**
 * Plan one stage and act on one item of it, as a pass would.
 *
 * What the console's merge action runs: the stage's own conditions decide, read
 * from GitHub now, and a skipped or blocked item is refused with the stage's own
 * reason. It holds the loop lock, so it never runs beside a pass.
 */
export async function actOnStageItem(deps: PassDeps, stage: StageName, ref: string): Promise<ActResult> {
  const slug = await deps.repo.slug();
  const release = acquireLoopLock(slug);
  try {
    const lines: string[] = [];
    const ctx = await buildContext(deps, { dryRun: false, stages: [stage] }, {
      slug, passId: newId('act'), startedAt: (deps.now ?? (() => new Date()))(), state: readState(slug), log: (l) => { lines.push(l); deps.log?.(l); },
    });
    const plan = await PLANNERS[stage](ctx);
    const item = plan.items.find((i) => i.ref === ref);
    if (!item) throw new StageRefusal(`The ${stage} stage does not list ${ref} in this pass: none of its conditions hold for it.`);
    if (item.decision.kind !== 'dispatch' || !item.act) {
      throw new StageRefusal(`The ${stage} stage passes over ${ref}: ${item.decision.kind === 'dispatch' ? 'nothing to act on' : item.decision.reason}`);
    }
    const result = await item.act();
    if (!result.produced) throw new StageRefusal(`The ${stage} stage acted on ${ref} and produced nothing: ${result.blocked ?? result.summary}`);
    return result;
  } finally {
    release();
  }
}

/** A stage's own refusal to act on an item, carrying its reason verbatim. */
export class StageRefusal extends Error {
  override readonly name = 'StageRefusal';
}

async function buildContext(
  deps: PassDeps, options: PassOptions,
  meta: { slug: string; passId: string; startedAt: Date; state: LoopState; log: (line: string) => void },
): Promise<PassContext> {
  const { slug } = meta;
  const base = integrationBase(slug);
  await deps.repo.fetch([base]);
  const policyRef = options.policyRef ?? `origin/${base}`;
  if (options.policyRef) await deps.repo.fetch([options.policyRef.replace(/^origin\//, '')]).catch(() => {});
  const policyCommit = await deps.repo.revParse(policyRef);
  const policy = parseStoreConfig(await deps.repo.show(policyRef, STORE_CONFIG_PATH), `${STORE_CONFIG_PATH} at ${policyRef} ${policyCommit}`);
  useMarkerPrefix(policy.protocol.markerPrefix.value);
  const rules = deps.rules ?? await loadQueueRules(deps.repo, policyRef, policy.protocol.markerPrefix.value);
  const baseSha = await deps.repo.revParse(`origin/${base}`);
  const [open, pulls] = await Promise.all([deps.store.listOpenIssues(), deps.store.listOpenPulls()]);
  // The loop's own fault issues are reports to a person, not tickets: shaping or
  // assessing them would have the loop working on its own complaints.
  const tickets = open.filter((i) => parseFaultMarker(i.body) === undefined);
  // A ticket whose work merged is done or waiting on a person; working it again
  // would repeat merged work. Only the close step sees it.
  const mergedBy = new Map<number, PullRequest>();
  // A pull request that completes an open ticket merged after that ticket was
  // opened, so the oldest open ticket bounds how far back to look.
  const opened = tickets.map((i) => i.createdAt).filter((d): d is string => typeof d === 'string').sort();
  for (const pr of await deps.store.mergedPulls(base, undefined, opened[0])) {
    for (const n of ticketsNamedBy(pr)) {
      const known = mergedBy.get(n);
      if (!known || Date.parse(pr.mergedAt ?? '') > Date.parse(known.mergedAt ?? '')) mergedBy.set(n, pr);
    }
  }
  const merged = tickets.filter((i) => mergedBy.has(i.number)).map((issue) => ({ issue, pr: mergedBy.get(issue.number)! }));
  const issues = tickets.filter((i) => !mergedBy.has(i.number));
  meta.log(`pass ${meta.passId}: ${slug}, base ${base} at ${baseSha.slice(0, 8)}, policy from ${policy.source}; ${issues.length} open issues to work (${open.length - tickets.length} of the loop's own fault issues and ${merged.length} ticket(s) whose work merged set aside), ${pulls.length} open pull requests`);

  const comments = new Map<number, Promise<Comment[]>>();
  const commits = new Map<number, Promise<PullCommit[]>>();
  const issueCache = new Map<number, Promise<Issue | undefined>>();
  const memo = <T>(cache: Map<number, Promise<T>>, n: number, read: () => Promise<T>): Promise<T> => {
    if (!cache.has(n)) cache.set(n, read());
    return cache.get(n)!;
  };
  return {
    passId: meta.passId,
    startedAt: meta.startedAt,
    options,
    slug,
    base,
    baseSha,
    policyRef,
    policy,
    rules,
    repo: deps.repo,
    store: deps.store,
    commands: deps.commands,
    issues,
    merged,
    pulls,
    triggerSource: `agentsys-loop:${slug}`,
    stateDir: loopDir(slug),
    comments: (n) => memo(comments, n, () => deps.store.comments(n)),
    commits: (n) => memo(commits, n, () => deps.store.pullCommits(n)),
    issue: (n) => memo(issueCache, n, () => deps.store.issue(n)),
    forget: (n) => { comments.delete(n); commits.delete(n); issueCache.delete(n); },
    log: meta.log,
  };
}

/** The pass log is rotated past this size, keeping one previous file, so an armed loop cannot fill the disk. */
export const PASS_LOG_MAX_BYTES = 5 * 1024 * 1024;

function appendPassLog(slug: string, text: string): void {
  const path = join(loopDir(slug), 'passes.log');
  mkdirSync(loopDir(slug), { recursive: true });
  try {
    if (statSync(path).size > PASS_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch { /* no log yet */ }
  appendFileSync(path, text, 'utf8');
}

/** Read the last pass a loop recorded for a repository, for `agentsys status --repo`. */
export function lastPass(slug: string): PassReport | undefined {
  return readState(slug).lastPass;
}

export function passLogTail(slug: string, lines = 200): string {
  try {
    return readFileSync(join(loopDir(slug), 'passes.log'), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Turn each `accept-findings` label into a record of which head was accepted.
 *
 * Runs once per real pass, ahead of the stages, so they rely on a marker naming
 * a head. A dry run does not consume the bare label or treat it as merge authority.
 */
async function pinAcceptances(ctx: PassContext): Promise<string[]> {
  const lines: string[] = [];
  for (const pr of ctx.pulls) {
    if (!(pr.labels ?? []).includes(ACCEPT_FINDINGS_LABEL)) continue;
    const head = pr.headRefOid;
    const comments = await ctx.comments(pr.number);
    let line = `accepted: PR #${pr.number} findings at ${head.slice(0, 8)}`;
    if (!findingsAcceptedAt(comments, head)) {
      await ctx.store.createComment(pr.number, [
        `The findings standing against \`${head.slice(0, 8)}\` are accepted, on the \`${ACCEPT_FINDINGS_LABEL}\` label.`,
        'They no longer hold this pull request back. A push past this head puts it back under review.',
        '',
        renderAcceptedMarker(head),
        `— ${LOOP_SIGNATURE} in pass ${ctx.passId}`,
      ].join('\n'));
    } else {
      try {
        await answerOnce(ctx, pr.number, ACCEPT_FINDINGS_LABEL, answerKey('accepted', head),
          `The findings standing against \`${short(head)}\` were already accepted, so the \`${ACCEPT_FINDINGS_LABEL}\` label changes nothing. It has been taken back.`);
      } catch (err) {
        // Left on and tried again next pass; an answer that cannot be written must not strand the pull requests after it.
        lines.push(`accepted: PR #${pr.number} not answered this pass: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      line = `accepted: PR #${pr.number} findings at ${head.slice(0, 8)} were already accepted; the label was taken back`;
    }
    await ctx.store.removeLabel(pr.number, ACCEPT_FINDINGS_LABEL);
    ctx.forget(pr.number);
    lines.push(line);
  }
  return lines;
}

/**
 * Turn each `review-again` label into a record of where that pull request's review count starts over.
 *
 * Runs once per real pass, ahead of the stages, so the review stage reads the restart as a
 * marker. The count lives in the loop's run records and the status labels are recomputed on every
 * pass, so a person could not bring a pull request back by clearing `loop:stopped`. A dry run
 * leaves the label where it is and posts nothing.
 */
async function restartReviews(ctx: PassContext): Promise<string[]> {
  const lines: string[] = [];
  const rules = outsideReviewRules(ctx.policy);
  /** Tell the operator why the label did nothing, then take it back: nothing here will ever change that. */
  const refuse = async (pr: PullRequest, why: string, line: string): Promise<void> => {
    try {
      await answerOnce(ctx, pr.number, REVIEW_AGAIN_LABEL, answerKey('refused', why),
        `${why} The \`${REVIEW_AGAIN_LABEL}\` label has been taken back.`);
    } catch (err) {
      lines.push(`review-again: PR #${pr.number} not answered this pass: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await ctx.store.removeLabel(pr.number, REVIEW_AGAIN_LABEL);
    ctx.forget(pr.number);
    lines.push(line);
  };
  for (const pr of ctx.pulls) {
    if (!(pr.labels ?? []).includes(REVIEW_AGAIN_LABEL)) continue;
    if (pr.baseRefName !== ctx.base) {
      await refuse(pr, `\`${REVIEW_AGAIN_LABEL}\` does nothing here: this pull request targets \`${pr.baseRefName}\`, and this loop reviews only pull requests against \`${ctx.base}\`.`,
        `review-again: PR #${pr.number} targets ${pr.baseRefName}, not ${ctx.base}; the label was taken back`);
      continue;
    }
    if (ticketOf(pr) !== undefined) {
      await refuse(pr, `\`${REVIEW_AGAIN_LABEL}\` is not needed here: the loop opened this pull request, so no review limit applies to it.`,
        `review-again: PR #${pr.number} is a pull request the loop opened, so no review limit applies; the label was taken back`);
      continue;
    }
    const head = pr.headRefOid;
    const counted = ctx.commands.reviewsRun(ctx.slug, pr.number).length;
    const standing = newestReviewRestart(await ctx.comments(pr.number));
    let line = `review-again: PR #${pr.number} reviews restart at ${short(head)}; up to ${rules.reviews} more`;
    // A restart already stands at this count when nothing has been reviewed since it.
    if (standing?.counted !== counted) {
      await ctx.store.createComment(pr.number, [
        `Reviews of this pull request start counting again from \`${short(head)}\`, on the \`${REVIEW_AGAIN_LABEL}\` label.`,
        `The loop reviews it up to ${rules.reviews} more times, each once its newest commit is ${rules.quietMinutes} minutes old, and then leaves it for a person again.`,
        '',
        renderReviewAgainMarker({ head, counted }),
        `— ${LOOP_SIGNATURE} in pass ${ctx.passId}`,
      ].join('\n'));
    } else {
      try {
        await answerOnce(ctx, pr.number, REVIEW_AGAIN_LABEL, answerKey('standing', standing.head, counted),
          `Reviews of this pull request already start counting again from \`${short(standing.head)}\`, and the loop has run none since, so there is nothing to restart. The \`${REVIEW_AGAIN_LABEL}\` label has been taken back.`);
      } catch (err) {
        lines.push(`review-again: PR #${pr.number} not answered this pass: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      line = `review-again: PR #${pr.number} reviews already restart at ${short(standing.head)}; nothing to restart, the label was taken back`;
    }
    await ctx.store.removeLabel(pr.number, REVIEW_AGAIN_LABEL);
    ctx.forget(pr.number);
    lines.push(line);
  }
  return lines;
}
