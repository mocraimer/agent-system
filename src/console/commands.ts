import { createHash } from 'node:crypto';
import type { Actor } from '../core/authority.js';
import { assertOperator } from '../core/authority.js';
import type { CoordinatorCommands, DispatchCommandResult, RunStopResult } from '../commands.js';
import { attemptEvidencePins, listRuns } from '../core/run.js';
import type { RunRecord } from '../core/run.js';
import { isolatedWorktreeDir } from '../loop/context.js';
import { listScorecards } from '../eval/scorecard.js';
import type { FeedbackVerdict, Scorecard } from '../eval/scorecard.js';
import type { Store } from '../loop/github.js';
import { markerAt, newestReview, parseFaultMarker, parseReviewMarkers, reviewMatchesBody } from '../loop/markers.js';
import { promptDigest } from '../loop/prompts.js';
import { freezeIncidentCase } from '../eval/cases.js';
import type { EvalCase } from '../eval/oracle.js';
import { loopDir } from '../loop/pass.js';
import type { LoopPolicy } from '../loop/policy.js';
import { parseStoreConfig, resolveStopLine, STORE_CONFIG_PATH } from '../loop/policy.js';
import type { TrustRow } from '../loop/trust.js';
import { trustReport } from '../loop/trust.js';
import { STAGES } from '../loop/types.js';
import type { ActResult } from '../loop/types.js';
import type { ActionKind, Board, BoardItem } from './facts.js';
import { setPaused } from './pauses.js';
import type { Pauses } from './pauses.js';
import type { BoardRead, ConsoleTarget } from './service.js';
import { readBoard } from './service.js';
import type { PolicyChange, ProposalGit, ProposalResult } from './steer.js';
import { branchFor, currentValue, proposePolicy } from './steer.js';
import type { VerdictCounts } from './verdicts.js';
import { countVerdicts } from './verdicts.js';

/**
 * What the console can do, as the command layer: every write checks that the
 * actor is the configured operator before touching anything, and every GitHub
 * write goes through the store on this machine under the operator's own login.
 * The browser names an item and an action; it never names who acts, which
 * repository, or where on disk.
 */

export class ConsoleRefusal extends Error {
  override readonly name = 'ConsoleRefusal';
}

export interface ConsoleDeps {
  target: ConsoleTarget;
  /** Writes to the target store. */
  store: Store;
  /** The target repository's git, for policy proposals. */
  git: ProposalGit;
  coordinator: CoordinatorCommands;
  /** Run the loop's merge-dev stage for one pull request, with the stage's own conditions. */
  mergeStage(ref: string): Promise<ActResult>;
  /** Read a board, and any closed items named; injectable so a test can drive the console without GitHub. */
  read?(target: ConsoleTarget, extra?: { issues: number[]; pulls: number[] }, requireFresh?: boolean): Promise<BoardRead>;
}

export interface PolicyRow {
  /** `type:chore`, `default`, a stage and runtime (`shape · pi-local`), or a limit's setting. */
  key: string;
  kind: PolicyChange['kind'];
  /** A tier row's stage; a stage lists one row per runtime. */
  stage?: string;
  live: string;
  /** The value an open policy pull request proposes, when one does. */
  proposed?: { value: string; pr: number; branch: string };
}

export interface ConsoleView {
  board: Board;
  /** Legacy active runs without a repo or a scorecard link cannot be assigned to this board. */
  unattributedRuns: number;
  policy: { source: string; stopLines: PolicyRow[]; tiers: PolicyRow[]; limits: PolicyRow[]; ladder: string[] };
}

export interface TrustView {
  workType: string;
  stopLine: number;
  stopLineSource: string;
  rows: Array<TrustRow & { verdicts: VerdictCounts }>;
}

export interface InspectView {
  item: BoardItem;
  cards: Array<Pick<Scorecard, 'id' | 'taskId' | 'runtime' | 'finalStatus' | 'checks' | 'reviews' | 'repairs' | 'runIds' | 'createdAt' | 'feedback' | 'stops' | 'loop'> & {
    tier: string;
    prompt?: { template: string; digest: string; short: string };
  }>;
  review?: { commentId: number; marker: string; text: string };
  evidence: Array<{ kind: 'proposal' | 'assessment' | 'review'; text: string; commentId: number; createdAt: string; current: boolean | null; fingerprint?: string; head?: string }>;
  itemAge?: string;
  /** Token binds an offered action to the exact facts displayed in Inspect. */
  actionToken?: string;
  /** Every linked attempt, including incomplete and interrupted ones, newest first. */
  attempts: RunRecord[];
  /** The newest run for the item, whose evidence Inspect lists. */
  run?: Pick<RunRecord, 'id' | 'status' | 'build' | 'delivery' | 'runtimeDispatched' | 'outputPath' | 'timing'>;
  trust: TrustView;
  buildIdentity: ReturnType<CoordinatorCommands['version']>['identity'];
}

export interface SteerView {
  policy: ConsoleView['policy'];
  paused: Pauses;
  stages: string[];
  unattributedRuns: number;
  runs: Array<Pick<RunRecord, 'id' | 'taskId' | 'runtime' | 'status' | 'startedAt' | 'endedAt' | 'build' | 'delivery' | 'runtimeDispatched'>>;
}

export interface ConsoleActionInput {
  ref: string;
  action: ActionKind;
  /** Opaque fingerprint returned by Inspect; a stale or unreadable decision cannot act. */
  expected: string;
  /** The answer, for an escalation. */
  text?: string;
  verdict?: { cardId: string; verdict: FeedbackVerdict; reason: string };
}

export interface ConsoleActionResult {
  ref: string;
  action: ActionKind;
  did: string;
  buildIdentity: ReturnType<CoordinatorCommands['version']>['identity'];
  verdict?: { cardId: string; verdict: FeedbackVerdict };
}

export interface ConsoleCommands {
  view(): Promise<ConsoleView>;
  inspect(ref: string): Promise<InspectView>;
  steer(): Promise<SteerView>;
  act(actor: Actor, input: ConsoleActionInput): Promise<ConsoleActionResult>;
  propose(actor: Actor, change: PolicyChange): Promise<ProposalResult & { live: string; proposed: string }>;
  pause(actor: Actor, stage: string, paused: boolean): Pauses;
  stopRun(actor: Actor, runId: string): Promise<RunStopResult>;
  redispatchRun(actor: Actor, runId: string): Promise<DispatchCommandResult>;
  freezeCase(actor: Actor, input: FreezeCaseInput): Promise<FreezeCaseResult>;
}

export interface FreezeCaseInput {
  ref: string;
  kind: EvalCase['kind'];
  expected: string;
  words: string;
  /** For a reviewer case: the words a finding must contain to count as reporting the defect. */
  defectPattern?: string;
  /** An attempt shown by this item's Inspect, or the newest linked attempt. */
  runId?: string;
}

export interface FreezeCaseResult {
  version: string;
  caseId: string;
  oracleDigest: string;
  cases: number;
  pins: Record<string, string>;
}

/** The actions an item accepts besides its primary one. */
const ALTERNATIVES: Partial<Record<ActionKind, ActionKind[]>> = {
  'apply-shaped': ['close-not-planned'],
  'apply-auto': ['close-not-planned'],
};

const numberOf = (ref: string): number => Number(/#(\d+)$/.exec(ref)?.[1]);

async function policyRows(deps: ConsoleDeps, live: LoopPolicy): Promise<ConsoleView['policy']> {
  const proposals: Array<{ pr: number; branch: string; policy: LoopPolicy }> = [];
  // The open pull requests from the console's and the improve stage's own branches, read at their heads.
  const pulls = (await deps.store.listOpenPulls()).filter((p) => p.baseRefName === deps.target.base && /^(console|improve)\//.test(p.headRefName));
  for (const pr of pulls) {
    try {
      await deps.target.repo.fetch([`+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);
      proposals.push({ pr: pr.number, branch: pr.headRefName, policy: parseStoreConfig(await deps.target.repo.show(`origin/${pr.headRefName}`, STORE_CONFIG_PATH)) });
    } catch {
      // A proposal branch whose file does not parse proposes nothing the loop could read.
    }
  }
  const row = (key: string, change: PolicyChange): PolicyRow => {
    const liveValue = currentValue(live, change);
    const proposal = proposals.find((p) => p.branch === branchFor(change) && currentValue(p.policy, change) !== liveValue)
      ?? proposals.find((p) => p.branch.startsWith('improve/') && currentValue(p.policy, change) !== liveValue);
    return {
      key, kind: change.kind, live: liveValue,
      ...(proposal ? { proposed: { value: currentValue(proposal.policy, change), pr: proposal.pr, branch: proposal.branch } } : {}),
    };
  };
  const types = [...new Set([...live.typeStopLines.keys(), ...proposals.flatMap((p) => [...p.policy.typeStopLines.keys()])])].sort();
  const options = (policy: LoopPolicy): Array<[stage: string, runtime: string]> => [...policy.stageTiers].flatMap(([stage, tiers]) => tiers.map((t): [string, string] => [stage, t.runtime]));
  const tierRows = new Map(
    [...options(live), ...proposals.flatMap((p) => options(p.policy))].map(([stage, runtime]) => [`${stage} · ${runtime}`, { stage, runtime }]),
  );
  const limits = [...new Set([...live.limits.keys(), ...proposals.flatMap((p) => [...p.policy.limits.keys()])])];
  return {
    source: live.source,
    stopLines: [
      ...types.map((t) => row(t, { kind: 'stop-line', label: t, value: 0 })),
      row('default', { kind: 'stop-line', label: 'default', value: 0 }),
    ],
    tiers: [...tierRows].map(([key, { stage, runtime }]) => ({ ...row(key, { kind: 'tier', stage, runtime, model: '', effort: '', fiveHourPercent: 0, weeklyPercent: 0 }), stage })),
    limits: limits.map((l) => row(l, { kind: 'limit', setting: l, value: '' })),
    ladder: live.reviewLadder.map((t) => `${t.author} ${t.order}: ${t.runtime} ${t.model} ${t.effort}`),
  };
}

export function createConsoleCommands(deps: ConsoleDeps): ConsoleCommands {
  const read = deps.read ?? readBoard;
  const findItem = async (ref: string): Promise<{ item: BoardItem; read: BoardRead }> => {
    let r: BoardRead;
    try { r = await read(deps.target, undefined, true); }
    catch { throw new ConsoleRefusal('The current policy or store could not be read. Refresh Inspect when the connection recovers; no action was taken.'); }
    if (r.board.stale || !r.snapshot) throw new ConsoleRefusal('The store read failed. Refresh Inspect when the store is available; no action was taken.');
    const item = r.board.items.find((i) => i.ref === ref);
    if (!item) throw new ConsoleRefusal(`${ref} is not an open item of ${deps.target.slug}.`);
    return { item, read: r };
  };
  /** An open item from the board, or a closed one read for the asking: Inspect and cases reach past incidents. */
  const findAny = async (ref: string, requireFresh = false): Promise<{ item: BoardItem; read: BoardRead }> => {
    const n = numberOf(ref);
    const pull = ref.startsWith('PR #');
    const r = await read(deps.target, pull ? { issues: [], pulls: [n] } : { issues: [n], pulls: [] }, requireFresh);
    const open = r.board.items.find((i) => i.ref === ref);
    if (open) return { item: open, read: r };
    const base = `https://github.com/${deps.target.slug}`;
    const closed = pull ? r.snapshot?.referencedPulls.find((p) => p.number === n) : r.snapshot?.referencedIssues.find((i) => i.number === n);
    if (!closed) throw new ConsoleRefusal(`${ref} is not an item of ${deps.target.slug} the console can read.`);
    const because = 'mergedAt' in closed && closed.mergedAt ? `merged ${closed.mergedAt}${closed.mergedBy ? ` by ${closed.mergedBy}` : ''}` : 'closed';
    const cards = cardsOfRepo(deps.target.slug).filter((c) => c.loop?.item === ref).map((c) => c.id);
    return { item: { ref, kind: pull ? 'pull' : 'issue', number: n, title: closed.title, column: 'not in play', because, cards, url: `${base}/${pull ? 'pull' : 'issues'}/${n}` }, read: r };
  };

  return {
    async view() {
      const r = await read(deps.target);
      return { board: r.board, unattributedRuns: unattributedRuns(), policy: await policyRows(deps, r.policy) };
    },

    async inspect(ref) {
      const { item, read: r } = await findAny(ref);
      const byId = new Map(cardsOfRepo(deps.target.slug).map((c) => [c.id, c]));
      const cards = item.cards.map((id) => byId.get(id)).filter((c): c is Scorecard => c !== undefined);
      const snapshotComments = r.board.stale ? [] : commentsOf(item, r);
      const reviewComment = [...snapshotComments].reverse().find((c) => parseReviewMarkers(c.body).length > 0);
      const marker = newestReview(snapshotComments);
      // The ticket's own labels decide its work type; with the ticket not open, its
      // scorecards say what type it was when the loop ran.
      const recorded = cards.find((c) => c.loop)?.loop?.workType;
      const open = item.kind === 'issue' ? issueLabels(r, item.number) : pullTicketLabels(r, item.number);
      const labels = open.length > 0 || recorded === undefined || recorded === 'untyped' || recorded === 'tracking' ? open : [`type:${recorded}`];
      const stop = resolveStopLine(r.policy, labels);
      const rows = trustReport([...byId.values()], r.policy, deps.target.slug).filter((row) => row.workType === stop.workType);
      const runs = listRuns().filter((run) => run.repo === deps.target.slug && (cards.some((c) => c.runIds.includes(run.id)) || run.loop?.item === item.ref)
        || run.repo === undefined && cards.some((c) => c.runIds.includes(run.id))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const evidence = evidenceFor(item, r);
      const assessment = evidence.find((entry) => entry.kind === 'assessment');
      if (assessment) {
        try { assessment.current = await currentAssessment(deps, item, r, assessment); }
        catch { assessment.current = null; } // The evidence remains visible, but an unreadable queue cannot authorize a grant.
      }
      return {
        item,
        cards: cards.map((c) => ({
          id: c.id, taskId: c.taskId, runtime: c.runtime, finalStatus: c.finalStatus, checks: c.checks,
          repairs: c.repairs, runIds: c.runIds, createdAt: c.createdAt,
          ...(c.reviews ? { reviews: c.reviews } : {}), ...(c.feedback ? { feedback: c.feedback } : {}),
          ...(c.stops ? { stops: c.stops } : {}), ...(c.loop ? { loop: c.loop } : {}),
          tier: `${c.settings.resolved.model}·${c.settings.resolved.effort} on ${c.runtime}`,
          ...(c.settings.prompt ? { prompt: { ...c.settings.prompt, short: c.settings.prompt.digest.slice(0, 12) } } : {}),
        })),
        ...(reviewComment && marker ? {
          review: {
            commentId: reviewComment.id,
            marker: `findings=${marker.findings} independent=${marker.independent ? 'yes' : 'no'} sha=${marker.sha.slice(0, 8)}${marker.reviewer ? ` reviewer=${marker.reviewer}` : ''}`,
            text: reviewComment.body.slice(0, 20_000),
          },
        } : {}),
        evidence,
        ...itemAge(item, r),
        ...(!r.board.stale && r.snapshot && item.action ? { actionToken: actionToken(item, r) } : {}),
        attempts: runs,
        ...(runs[0] ? { run: { id: runs[0].id, status: runs[0].status, build: runs[0].build ?? null,
          ...(runs[0].delivery ? { delivery: runs[0].delivery } : {}),
          ...(runs[0].runtimeDispatched !== undefined ? { runtimeDispatched: runs[0].runtimeDispatched } : {}),
          ...(runs[0].outputPath ? { outputPath: runs[0].outputPath } : {}),
          ...(runs[0].timing ? { timing: runs[0].timing } : {}) } } : {}),
        buildIdentity: deps.coordinator.version().identity,
        trust: {
          workType: stop.workType, stopLine: stop.rung, stopLineSource: stop.line,
          rows: rows.map((row) => ({
            ...row,
            verdicts: countVerdicts(r.board.verdicts.filter((v) => v.workType === row.workType && v.stage === row.stage)),
          })),
        },
      };
    },

    async steer() {
      const r = await read(deps.target);
      return {
        policy: await policyRows(deps, r.policy),
        paused: r.board.paused,
        stages: STAGES.map((s) => s.name),
        unattributedRuns: unattributedRuns(),
        runs: listRuns().filter((run) => run.repo === deps.target.slug && run.taskId.startsWith('loop-'))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 25)
          .map((run) => ({ id: run.id, taskId: run.taskId, runtime: run.runtime, status: run.status, startedAt: run.startedAt,
            ...(run.endedAt ? { endedAt: run.endedAt } : {}), build: run.build ?? null,
            ...(run.delivery ? { delivery: run.delivery } : {}), ...(run.runtimeDispatched !== undefined ? { runtimeDispatched: run.runtimeDispatched } : {}) })),
      };
    },

    async act(actor, input) {
      assertOperator(actor);
      const { item, read: fresh } = await findItem(input.ref);
      const ready = item.column === 'Ready to merge' && item.action === 'merge';
      if ((item.column !== 'Needs you' && !ready) || !item.action) throw new ConsoleRefusal(`${input.ref} is not waiting on you (${item.column}: ${item.because}). Refresh Inspect before trying again; no action was taken.`);
      if (input.action !== item.action && !(ALTERNATIVES[item.action] ?? []).includes(input.action)) {
        throw new ConsoleRefusal(`${input.ref} waits for ${item.waitsFor}; its action is ${item.action}, not ${input.action}.`);
      }
      if (input.verdict && !item.cards.includes(input.verdict.cardId)) {
        throw new ConsoleRefusal(`Scorecard ${input.verdict.cardId} is not about ${input.ref}.`);
      }
      if (!/^[a-f0-9]{64}$/.test(input.expected) || input.expected !== actionToken(item, fresh)) {
        throw new ConsoleRefusal('This decision changed since Inspect. Refresh the item, read the current evidence, and try again; no action was taken.');
      }
      const assessment = input.action === 'apply-auto' ? evidenceFor(item, fresh).find((entry) => entry.kind === 'assessment') : undefined;
      if (input.action === 'apply-auto' && !assessment) {
        throw new ConsoleRefusal('No assessment is available for this decision. Refresh Inspect or read the current assessment before granting auto; no action was taken.');
      }
      await confirmLiveItem(deps, item, fresh);
      if (assessment) {
        let current = false;
        try { current = await currentAssessment(deps, item, fresh, assessment); }
        catch { /* A failed live read cannot establish a current assessment. */ }
        if (!current) throw new ConsoleRefusal('No current assessment names this ticket. Refresh Inspect and read the current queue verdict before granting auto; no action was taken.');
      }
      const n = numberOf(item.ref);
      const did = await perform(deps, actor, item, input, n);
      // The verdict is recorded after the act it accompanies succeeded, so a refused
      // act never leaves a verdict about work the operator did not act on.
      const verdict = input.verdict ? deps.coordinator.feedbackRecord(actor, input.verdict.cardId, { verdict: input.verdict.verdict, reason: input.verdict.reason }) : undefined;
      return { ref: item.ref, action: input.action, did, buildIdentity: deps.coordinator.version().identity,
        ...(verdict && input.verdict ? { verdict: { cardId: verdict.id, verdict: input.verdict.verdict } } : {}) };
    },

    async propose(actor, change) {
      assertOperator(actor);
      return proposePolicy({
        git: deps.git, store: deps.store, base: deps.target.base,
        worktree: isolatedWorktreeDir(loopDir(deps.target.slug), branchFor(change).replace(/\//g, '-')),
      }, change, actor.id);
    },

    pause(actor, stage, paused) {
      assertOperator(actor);
      if (!STAGES.some((s) => s.name === stage)) throw new ConsoleRefusal(`"${stage}" is not a stage of the loop.`);
      return setPaused(deps.target.slug, stage, paused, actor.id);
    },

    stopRun: (actor, runId) => deps.coordinator.runStop(actor, runId),
    redispatchRun: (actor, runId) => deps.coordinator.runRedispatch(actor, runId),

    async freezeCase(actor, input) {
      assertOperator(actor);
      let found: Awaited<ReturnType<typeof findAny>>;
      try { found = await findAny(input.ref, true); }
      catch (err) {
        if (err instanceof ConsoleRefusal) throw err;
        throw new ConsoleRefusal('The current policy or store could not be read. Refresh Inspect when the connection recovers; no case was frozen.');
      }
      const { item, read: r } = found;
      if (r.board.stale || !r.snapshot) throw new ConsoleRefusal('The store could not be read. Refresh Inspect before freezing this case.');
      const pins = pinsFor(item, r, deps.target.slug, input.defectPattern, input.runId);
      const { suite, caseId } = freezeIncidentCase({ kind: input.kind, expected: input.expected, words: input.words, subject: item.ref, pins, by: actor.id });
      return { version: suite.version, caseId, oracleDigest: suite.oracleDigest, cases: suite.cases.length, pins };
    },
  };
}

/**
 * What a case pins about its incident: the head and base a review saw, the
 * ticket body's hash, the review's marker, and the prompt and tier behind the run
 * — from the run's scorecard where the loop recorded them, else the stage's
 * current template, said as such.
 */
function pinsFor(item: BoardItem, r: BoardRead, slug: string, defectPattern: string | undefined, runId?: string): Record<string, string> {
  const pins: Record<string, string> = { repo: slug };
  if (defectPattern?.trim()) pins['defectPattern'] = defectPattern.trim();
  const snapshot = r.snapshot;
  const issueBody = (n: number): string | undefined => [...(snapshot?.issues ?? []), ...(snapshot?.referencedIssues ?? [])].find((i) => i.number === n)?.body;
  if (item.kind === 'pull') {
    const pr = [...(snapshot?.pulls ?? []), ...(snapshot?.referencedPulls ?? [])].find((p) => p.number === item.number);
    if (!pr) throw new ConsoleRefusal(`${item.ref} could not be read, so there is nothing to pin.`);
    pins['pr'] = String(pr.number);
    pins['head'] = pr.headRefOid;
    if (pr.baseRefOid) pins['base'] = pr.baseRefOid;
    const ticket = /^ticket\/(\d+)$/.exec(pr.headRefName)?.[1];
    if (ticket) {
      pins['issue'] = ticket;
      const body = issueBody(Number(ticket));
      if (body !== undefined) pins['issueBodyHash'] = r.rules.issueBodyHash(body);
    }
    const marker = newestReview(pr.comments);
    if (marker) pins['reviewMarker'] = `sha=${marker.sha} findings=${marker.findings} independent=${marker.independent ? 'yes' : 'no'}${marker.reviewer ? ` reviewer=${marker.reviewer}` : ''}`;
    const card = cardsOfRepo(slug).filter((c) => c.loop?.item === item.ref && c.loop.stage === 'review').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (card?.settings.prompt) {
      pins['promptTemplate'] = card.settings.prompt.template;
      pins['promptDigest'] = card.settings.prompt.digest;
      pins['promptDigestSource'] = `scorecard ${card.id}`;
    } else {
      pins['promptTemplate'] = 'review';
      pins['promptDigest'] = promptDigest('review');
      pins['promptDigestSource'] = 'the current review template: no scorecard recorded the prompt behind this review';
    }
    pins['tier'] = card ? `${card.runtime}/${card.settings.resolved.model}/${card.settings.resolved.effort}` : marker?.reviewer ?? 'not recorded';
  } else {
    pins['issue'] = String(item.number);
    const body = issueBody(item.number);
    if (body !== undefined) {
      pins['issueBodyHash'] = r.rules.issueBodyHash(body);
      const fingerprint = parseFaultMarker(body);
      if (fingerprint) pins['faultFingerprint'] = fingerprint;
    }
  }
  const cards = cardsOfRepo(slug).filter((c) => c.loop?.item === item.ref);
  const runs = listRuns().filter((run) => run.repo === slug && run.loop?.item === item.ref || cards.some((c) => c.runIds.includes(run.id)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected = runId ? runs.find((run) => run.id === runId) : runs[0];
  if (runId && !selected) throw new ConsoleRefusal(`Run ${runId} is not a recorded attempt for ${item.ref}; no case was frozen.`);
  if (selected) Object.assign(pins, attemptEvidencePins(selected));
  return pins;
}

/** Only the selected item's facts bind a click; other tickets changing do not invalidate it. */
function actionToken(item: BoardItem, read: BoardRead): string {
  const snapshot = read.snapshot;
  if (!snapshot || read.board.stale) throw new ConsoleRefusal('The current store could not be read. Refresh Inspect before acting.');
  const issue = snapshot.issues.find((i) => i.number === item.number);
  const pull = snapshot.pulls.find((p) => p.number === item.number);
  const ticket = pull ? /^ticket\/(\d+)$/.exec(pull.headRefName)?.[1] : undefined;
  const linked = ticket ? [...snapshot.issues, ...snapshot.referencedIssues].find((i) => i.number === Number(ticket)) : undefined;
  const digest = createHash('sha256').update(JSON.stringify({ repo: snapshot.repo, policy: read.policy.source, item, issue, pull, linked,
    evidence: evidenceFor(item, read) })).digest('hex');
  return digest;
}

function evidenceFor(item: BoardItem, read: BoardRead): InspectView['evidence'] {
  if (read.board.stale || !read.snapshot) return [];
  if (item.kind === 'pull') {
    const pr = [...read.snapshot.pulls, ...read.snapshot.referencedPulls].find((p) => p.number === item.number);
    if (!pr) return [];
    return pr.comments.filter((c) => parseReviewMarkers(c.body).length > 0).slice(-1).map((c) => {
      const review = newestReview([c]);
      return { kind: 'review', text: c.body, commentId: c.id, createdAt: c.createdAt,
        current: markerAt(review, pr.headRefOid) && reviewMatchesBody(review, pr.body ?? '', true), head: pr.headRefOid };
    });
  }
  const issue = [...read.snapshot.issues, ...read.snapshot.referencedIssues].find((i) => i.number === item.number);
  if (!issue) return [];
  const proposal = issue.comments.filter((c) => c.body.includes(read.rules.SHAPE_MARKER)).slice(-1).map((c) => {
    const fingerprint = read.rules.readShapeFingerprint(c.body);
    return { kind: 'proposal' as const, text: c.body, commentId: c.id, createdAt: c.createdAt,
      current: fingerprint === read.rules.issueBodyHash(issue.body), ...(fingerprint ? { fingerprint } : {}) };
  });
  const effort = issue.labels.find((l) => l.startsWith('effort:'));
  const tracking = effort ? read.snapshot.issues.find((i) => i.labels.includes('effort') && i.labels.includes(effort)) : undefined;
  const marker = (read.rules as typeof read.rules & { MARKER?: string }).MARKER;
  const assessment = marker ? tracking?.comments.filter((c) => c.body.includes(marker)).slice(-1).map((c) => {
    const fingerprint = /[a-f0-9]{64}/.exec(c.body)?.[0];
    return { kind: 'assessment' as const, text: c.body, commentId: c.id, createdAt: c.createdAt,
      current: null, // Resolved using the target repository's queue rules and live state.
      ...(fingerprint ? { fingerprint } : {}) };
  }) ?? [] : [];
  return [...proposal, ...assessment];
}

/** A marked comment is evidence, not an instruction. Check the target repo's queue decision
 * for this exact ticket against the live base, open issues and dependency states. */
async function currentAssessment(deps: ConsoleDeps, item: BoardItem, read: BoardRead, assessment: InspectView['evidence'][number]): Promise<boolean> {
  if (item.kind !== 'issue' || !read.snapshot || read.board.stale) return false;
  const issue = read.snapshot.issues.find((i) => i.number === item.number);
  const effort = issue?.labels.find((label) => label.startsWith('effort:'));
  if (!effort) return false;
  await deps.target.repo.fetch([deps.target.base]);
  const baseSha = await deps.target.repo.revParse(`origin/${deps.target.base}`);
  if (baseSha !== read.baseSha) return false;
  const issues = await deps.store.listOpenIssues();
  const live = issues.find((candidate) => candidate.number === item.number);
  if (!live || !live.labels.includes('shaped') || live.labels.includes('question') || live.labels.includes('escalated') || live.assignees.length > 0) return false;
  const tracking = read.rules.trackingIssue(issues, effort);
  const comments = await deps.store.comments(tracking.number);
  const latest = comments.filter((c) => c.body.includes(read.rules.MARKER)).at(-1);
  if (!latest || latest.id !== assessment.commentId || latest.body !== assessment.text) return false;
  const candidates = read.rules.candidates(issues, effort);
  const dependencyStates: Record<number, string> = {};
  for (const n of new Set(candidates.flatMap((candidate) => read.rules.dependsOn(candidate.body)))) {
    dependencyStates[n] = await deps.store.issueState(n);
  }
  const decision = read.rules.decide({ issues, effortLabel: effort, dependencyStates, devHead: baseSha, priorComment: latest.body });
  return !decision.shouldRun && decision.trackingNumber === tracking.number && decision.candidateNumbers.includes(item.number) &&
    read.rules.dependsOn(live.body).every((n) => dependencyStates[n] === 'CLOSED') &&
    assessmentGrantsTicket(latest.body, item.number);
}

/** Grouped assessment prose is evidence, not a grant. Accept only an explicit positive verdict for this ticket. */
export function assessmentGrantsTicket(body: string, number: number): boolean {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const ticket = new RegExp(`^\\s*(?:[-*]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?#${number}(?!\\d)\\b`, 'i');
  const tableTicket = new RegExp(`^\\s*\\|\\s*(?:\\*\\*)?#${number}(?!\\d)(?:\\*\\*)?\\s*\\|`, 'i');
  // Accept an affirmative verdict at its start, not the same words inside a
  // negative sentence such as "isn't ready to grant".
  const positive = /^(?:\*{1,2})?(?:is\s+)?(?:ready to grant|grantable now|ready for auto)\b/;
  // Match dispositions at the start of a group or ticket label. A negative word
  // later in a defect title ("cannot read the checks") is not a queue verdict.
  const negative = /^(?:\*{1,2})?(?:is\s+)?(?:not yet\b|not(?:\s+\w+){0,2}\s+(?:ready|grantable|eligible)\b|no longer\s+(?:ready|grantable|eligible)\b|never\s+ready\b|unready\b|(?:cannot|can['’]?t|isn['’]?t|won['’]?t|doesn['’]?t)\b.*\b(?:ready|grant|qualify)\b|no(?:\s*[-—–]\s*|\s+)ready\b|(?:do not|don['’]?t|must not|should not|shouldn['’]?t)\s+grant\b|should not be granted\b|should be closed\b|needs? reshaping\b|must remain manual\b|ineligible for auto\b|on hold\b|blocked\b|duplicate\b|already done\b|queue (?:is )?clear\b)/;
  // A verdict that begins positive can still withdraw the grant later in the
  // same field. Fail closed on correction words there, but don't scan ordinary
  // defect titles (such as "cannot read the checks") for a queue verdict.
  const denialWithinVerdict = new RegExp(`(?:^|\\b)${negative.source.slice(1)}`);
  const correction = /\b(?:not|never|but|however|though|except|blocked|hold|ineligible|no longer|withdrawn|retracted|denied|false|wrong)\b|\b\w+n['’]t\b/;
  const denied = (text: string): boolean => negative.test(text) || (positive.test(text) && (denialWithinVerdict.test(text) || correction.test(text)));
  const afterTicket = (line: string): string => line.replace(ticket, '').trim().replace(/^\*{1,2}\s*/, '').replace(/^[:—–-]\s*/, '').trim();
  let group = '';
  const verdicts: boolean[] = [];
  for (const line of lines) {
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line) ?? /^\s*\*\*(.+)\*\*\s*$/.exec(line);
    if (heading) {
      const title = heading[1]!.toLowerCase();
      if (ticket.test(title)) {
        const label = afterTicket(title);
        verdicts.push(!denied(group) && !denied(label) && (positive.test(group) || positive.test(label)));
      } else group = title;
      continue;
    }
    if (tableTicket.test(line)) {
      const cells = line.split('|').map((cell) => cell.trim().toLowerCase());
      const verdict = cells[2]!;
      const extraCells = cells.slice(3).filter(Boolean);
      verdicts.push(!denied(group) && !denied(verdict) && extraCells.every((cell) => !denialWithinVerdict.test(cell) && !correction.test(cell)) && positive.test(verdict));
    } else if (ticket.test(line)) {
      const verdict = line.toLowerCase();
      const label = afterTicket(verdict);
      verdicts.push(!denied(group) && !denied(label) && (positive.test(group) || positive.test(label)));
    }
  }
  return verdicts.length > 0 && verdicts.every(Boolean);
}

function itemAge(item: BoardItem, read: BoardRead): { itemAge?: string } {
  const source = item.kind === 'pull' ? read.snapshot?.pulls.find((p) => p.number === item.number)
    ?? read.snapshot?.referencedPulls.find((p) => p.number === item.number)
    : read.snapshot?.issues.find((i) => i.number === item.number) ?? read.snapshot?.referencedIssues.find((i) => i.number === item.number);
  return source?.createdAt ? { itemAge: source.createdAt } : {};
}

async function confirmLiveItem(deps: ConsoleDeps, item: BoardItem, read: BoardRead): Promise<void> {
  const snapshot = read.snapshot!;
  try {
    if (item.kind === 'issue') {
      const was = snapshot.issues.find((i) => i.number === item.number);
      const now = await deps.store.issue(item.number);
      if (!was || !now || now.state.toUpperCase() !== 'OPEN' || now.body !== was.body ||
          JSON.stringify(now.labels) !== JSON.stringify(was.labels) || JSON.stringify(now.assignees) !== JSON.stringify(was.assignees)) throw new Error('the ticket changed');
      // The snapshot may include only GitHub's most recent comments. Every comment
      // it did include must still be present and unchanged when this click writes.
      const comments = await deps.store.comments(item.number);
      if (was.comments.some((c) => !comments.some((live) => live.id === c.id && live.body === c.body)) ||
          was.comments.at(-1)?.id !== comments.at(-1)?.id) throw new Error('the discussion changed');
      const assessment = evidenceFor(item, read).find((e) => e.kind === 'assessment');
      const effort = was.labels.find((label) => label.startsWith('effort:'));
      const tracking = effort ? snapshot.issues.find((i) => i.labels.includes('effort') && i.labels.includes(effort)) : undefined;
      if (assessment && tracking) {
        const comments = await deps.store.comments(tracking.number);
        const marker = (read.rules as typeof read.rules & { MARKER?: string }).MARKER;
        if (!marker || !comments.some((c) => c.id === assessment.commentId && c.body === assessment.text) ||
            comments.filter((c) => c.body.includes(marker)).at(-1)?.id !== assessment.commentId) {
          throw new Error('the assessment changed');
        }
      }
    } else {
      const was = snapshot.pulls.find((p) => p.number === item.number);
      const now = (await deps.store.listOpenPulls()).find((p) => p.number === item.number);
      if (!was || !now || now.headRefOid !== was.headRefOid || now.headRefName !== was.headRefName || now.baseRefName !== was.baseRefName ||
        JSON.stringify(now.labels ?? []) !== JSON.stringify(was.labels ?? [])) throw new Error('the pull request changed');
      const head = await deps.store.branchHead(now.headRefName);
      if (head !== was.headRefOid) throw new Error('the branch head changed');
      const ticket = /^ticket\/(\d+)$/.exec(was.headRefName)?.[1];
      const linked = ticket ? [...snapshot.issues, ...snapshot.referencedIssues].find((i) => i.number === Number(ticket)) : undefined;
      if (linked) {
        const current = await deps.store.issue(linked.number);
        if (!current || current.body !== linked.body || JSON.stringify(current.labels) !== JSON.stringify(linked.labels)) throw new Error('the ticket changed');
      }
      const comments = await deps.store.comments(item.number);
      if (was.comments.some((c) => !comments.some((live) => live.id === c.id && live.body === c.body)) ||
          was.comments.at(-1)?.id !== comments.at(-1)?.id) throw new Error('the review discussion changed');
    }
  } catch {
    throw new ConsoleRefusal('The item or its evidence changed or cannot be read. Refresh Inspect before acting; no action was taken.');
  }
}

async function perform(deps: ConsoleDeps, actor: Actor, item: BoardItem, input: ConsoleActionInput, n: number): Promise<string> {
  const { store } = deps;
  switch (input.action) {
    case 'apply-shaped':
      await store.addLabels(n, ['shaped']);
      return `labeled #${n} shaped`;
    case 'apply-auto':
      await store.addLabels(n, ['auto']);
      return `labeled #${n} auto`;
    case 'merge': {
      const result = await deps.mergeStage(item.ref);
      if (!result.produced) throw new ConsoleRefusal(`The merge stage did not merge ${item.ref}: ${result.summary}. Refresh Inspect and check the current head and checks.`);
      return result.summary;
    }
    case 'close-not-planned':
      await store.closeIssue(n, 'not planned');
      return `closed #${n} as not planned`;
    case 'close-completed':
      await store.closeIssue(n, 'completed');
      return `closed #${n} as completed`;
    case 'release-claim': {
      const assignees = /^assignee:(.+)$/.exec(item.actionTarget ?? '')?.[1]?.split(',') ?? [];
      if (assignees.length === 0) throw new ConsoleRefusal(`${item.ref} has no claim to release.`);
      await store.removeAssignees(n, assignees);
      return `unassigned ${assignees.join(', ')} from #${n}`;
    }
    case 'dismiss-fault':
      await store.createComment(n, `Read and dismissed by ${actor.id} from the agentsys console.`);
      await store.closeIssue(n, 'completed');
      return `closed fault issue #${n}`;
    case 'answer-escalation': {
      const text = input.text?.trim();
      if (!text) throw new ConsoleRefusal('An answer to an escalation needs its text.');
      await store.createComment(n, `${text}\n\n— ${actor.id}, answering the escalation from the agentsys console.`);
      await store.removeOperatorLabel(n, 'escalated');
      return `answered #${n} and removed \`escalated\``;
    }
    case 'open':
      throw new ConsoleRefusal(`${item.ref} has nothing the console can do about it: ${item.waitsFor}. Open it on GitHub: ${item.url}`);
  }
}

/* -------------------------------------------------------------- helpers */

function unattributedRuns(): number {
  const linked = new Set(listScorecards().flatMap((card) => card.runIds));
  return listRuns().filter((run) => run.status === 'running' && run.repo === undefined && !linked.has(run.id)).length;
}

function cardsOfRepo(slug: string): Scorecard[] {
  return listScorecards().filter((c) => c.repo === slug);
}

function commentsOf(item: BoardItem, r: BoardRead): Array<{ id: number; body: string }> {
  return item.kind === 'pull' ? r.snapshot?.pulls.find((p) => p.number === item.number)?.comments ?? [] : r.snapshot?.issues.find((i) => i.number === item.number)?.comments ?? [];
}

function issueLabels(r: BoardRead, n: number): string[] {
  return r.snapshot?.issues.find((i) => i.number === n)?.labels ?? [];
}

function pullTicketLabels(r: BoardRead, n: number): string[] {
  const pr = r.snapshot?.pulls.find((p) => p.number === n);
  const ticket = pr ? /^ticket\/(\d+)$/.exec(pr.headRefName)?.[1] : undefined;
  return ticket ? issueLabels(r, Number(ticket)) : [];
}
