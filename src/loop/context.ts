import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ActionId } from '../core/authority.js';
import type { DispatchCommandResult } from '../commands.js';
import type { OutcomeKind } from '../core/outcome.js';
import type { LoopRecord } from '../eval/scorecard.js';
import type { PullRequest } from './github.js';
import type { Family, ResolvedStopLine, Tier } from './policy.js';
import { familyOf, resolveStopLine, stageOptions, tierLabel } from './policy.js';
import { loopName } from './markers.js';
import { promptDigest } from './prompts.js';
import type { PromptStage } from './prompts.js';
import { rankOptions, renderChoice, weeklyRoom } from './ranking.js';
import type { OptionReport, WeeklyRoom } from './ranking.js';
import type { ActResult, Item, PassContext, PassStage } from './types.js';

// The whole label vocabulary is declared in one place; re-exported here so the
// stages that already read HUMAN through this module keep their import.
export { HUMAN_LABEL } from './labels.js';

/** A filesystem-safe name for the target repository. */
export function slugDir(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** The ticket a pull request was opened for, from its `ticket/<n>` branch. */
export function ticketOf(pr: Pick<PullRequest, 'headRefName'>): number | undefined {
  const m = /^ticket\/(\d+)$/.exec(pr.headRefName);
  return m ? Number(m[1]) : undefined;
}

/**
 * A ticket's stop-line, or the default for a pull request that is not ticket work.
 *
 * The stop-line itself comes from the ticket's labels, since `type:` and
 * `effort:` are ticket properties. `labels` is the wider set the stages read to
 * see whether a person has spoken — a pull request's own labels join it, so
 * `HUMAN` stops a pull request whether or not it has a ticket to carry it.
 */
export async function stopLineOfPull(ctx: PassContext, pr: PullRequest): Promise<ResolvedStopLine & { ticket?: number; labels: string[] }> {
  const own = pr.labels ?? [];
  const ticket = ticketOf(pr);
  if (ticket === undefined) return { ...resolveStopLine(ctx.policy, []), labels: [...own] };
  const issue = ctx.issues.find((i) => i.number === ticket) ?? await ctx.issue(ticket);
  const ticketLabels = issue?.labels ?? [];
  return {
    ...resolveStopLine(ctx.policy, ticketLabels),
    ticket,
    labels: [...new Set([...ticketLabels, ...own])],
  };
}

/**
 * Which family wrote a pull request, read from its newest commit.
 *
 * The store configuration states the rule: a `Co-Authored-By:` trailer naming a
 * Claude model means claude, one naming a GPT model means pi, and neither means
 * the family of the first sweep row in the table.
 */
/**
 * The Co-Authored-By line a loop stage stamps on its commits. It names the
 * family `authorFamily` reads back, so the independent reviewer is chosen by
 * the model that actually ran, whichever runtime the stage tier names.
 */
export function modelTrailer(tier: Tier, stage: 'sweep' | 'fix'): string {
  return familyOf(tier.runtime) === 'claude'
    ? `Co-Authored-By: Claude ${tier.model} (${loopName()} ${stage} stage) <noreply@anthropic.com>`
    : `Co-Authored-By: GPT ${tier.model} (${loopName()} ${stage} stage) <noreply@openai.com>`;
}

export async function authorFamily(ctx: PassContext, pr: PullRequest): Promise<{ family: Family; basis: string }> {
  const commits = await ctx.commits(pr.number);
  const newest = commits[commits.length - 1];
  const trailers = (newest?.message ?? '').split('\n').filter((l) => /^co-authored-by:/i.test(l.trim()));
  if (trailers.some((l) => /claude/i.test(l))) return { family: 'claude', basis: 'newest commit carries a Claude Co-Authored-By trailer' };
  if (trailers.some((l) => /\bgpt/i.test(l))) return { family: 'pi', basis: 'newest commit carries a GPT Co-Authored-By trailer' };
  const sweep = stageOptions(ctx.policy, 'sweep')[0]!;
  const family = familyOf(sweep.runtime);
  return { family, basis: `no model trailer on the newest commit; the first sweep row runs on ${sweep.runtime}` };
}

const setupStarts = new Map<string, string>();

export function isolatedWorktreeDir(stateDir: string, name: string): string {
  // Never nest a target beneath the controller's package/config ancestors. The
  // old state/worktrees tree is deliberately left untouched for recovery.
  const namespace = createHash('sha256').update(stateDir).digest('hex').slice(0, 20);
  const root = join('/var/tmp', `agentsys-workers-${process.getuid?.() ?? 'local'}`, namespace);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, slugDir(name));
  setupStarts.set(dir, new Date().toISOString());
  return dir;
}

export function worktreeDir(ctx: PassContext, name: string): string {
  return isolatedWorktreeDir(ctx.stateDir, name);
}

export function outputPath(ctx: PassContext, taskId: string): string {
  const dir = join(ctx.stateDir, 'out');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${slugDir(taskId)}-${randomUUID()}.md`);
}

/**
 * The text a run produced: the file it was told to write, or, failing that, the
 * final answer a `claude-local` run leaves in its stdout.
 */
export function readOutput(path: string | undefined, result: DispatchCommandResult): string | undefined {
  // An interrupted runtime's file is retained evidence, never a finished answer.
  if (result.outcome.kind !== 'completed') return undefined;
  path = result.run?.outputPath ?? path;
  if (path !== undefined && existsSync(path)) {
    const text = readFileSync(path, 'utf8').trim();
    if (text !== '') return text;
  }
  const evidenceDir = result.run?.evidenceDir;
  const stdout = evidenceDir ? join(evidenceDir, 'claude-local-stdout.json') : undefined;
  if (stdout && existsSync(stdout)) {
    try {
      const parsed = JSON.parse(readFileSync(stdout, 'utf8')) as { result?: unknown };
      if (typeof parsed.result === 'string' && parsed.result.trim() !== '') return parsed.result.trim();
    } catch { /* no readable final answer */ }
  }
  const piEvents = evidenceDir ? join(evidenceDir, 'pi-rpc-events.jsonl') : undefined;
  if (piEvents && existsSync(piEvents)) {
    const lines = readFileSync(piEvents, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]!) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
        if (!['message', 'message_end'].includes(String(event.type)) || event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) continue;
        const text = event.message.content.map((block) => {
          if (!block || typeof block !== 'object') return '';
          const value = block as { type?: unknown; text?: unknown };
          return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
        }).filter(Boolean).join('');
        if (text.trim() !== '') return text.trim();
      } catch { /* keep looking for the last readable assistant message */ }
    }
  }
  return undefined;
}

export interface ModelRun {
  stage: PassStage;
  /** The versioned template the prompt was rendered from. */
  template: PromptStage;
  /** The store-config tier the run is dispatched at. */
  tier: Tier;
  taskId: string;
  prompt: string;
  cwd: string;
  actions: ActionId[];
  entry?: 'skill' | 'review-pr' | 'prompt';
  timeoutMs: number;
  outputPath?: string;
  loop?: LoopRecord;
}

/**
 * Dispatch one model run through the coordinator.
 *
 * Every model run the loop makes goes through here and so through `dispatchTask`:
 * authority, then admission, then the adapter, with a scorecard written whatever
 * the outcome. The tier is the store configuration's; the estimate is the bound
 * the same row states, cited by line.
 */
export async function runModel(ctx: PassContext, run: ModelRun): Promise<DispatchCommandResult> {
  const setupStartedAt = setupStarts.get(run.cwd) ?? new Date().toISOString();
  setupStarts.delete(run.cwd);
  // Ask first. A dispatch admission refuses is still a recorded run, and a loop
  // retrying blocked work every pass would fill the record with refusals.
  const available = await tierAvailability(ctx, run.stage, run.tier, run.taskId, run.actions, run.entry ?? 'prompt');
  if (!available.ok) {
    return {
      outcome: { kind: available.kind, taskId: run.taskId, summary: `not dispatched: ${available.reason}`, nextAction: 'The next pass asks again.' },
      recovered: [],
      runtimeDispatched: false,
    };
  }
  return ctx.commands.dispatch({
    taskId: run.taskId,
    repo: ctx.slug,
    workClass: `loop-${run.stage}`,
    runtime: run.tier.runtime,
    profile: 'default',
    actions: run.actions,
    triggerSource: ctx.triggerSource,
    ...(run.actions.includes('open-pr') ? { prBase: ctx.base } : {}),
    prompt: run.prompt,
    repoPath: run.cwd,
    ...(run.outputPath ? { outputPath: run.outputPath } : {}),
    loop: run.loop ?? { stage: run.stage, item: run.taskId, workType: 'unknown' },
    setupStartedAt,
    settings: { model: run.tier.model, effort: run.tier.effort },
    estimate: {
      fiveHourPercent: run.tier.fiveHourPercent,
      weeklyPercent: run.tier.weeklyPercent,
      basis: 'operator-bound',
      uncertaintyPercent: 1,
      detail: `operator-set bound, ${run.tier.line}`,
    },
    timeoutMs: run.timeoutMs,
    entry: run.entry ?? 'prompt',
    promptVersion: { template: run.template, digest: promptDigest(run.template) },
  });
}

/**
 * Whether a tier could run this task now: authority, runtime readiness, and
 * admission, asked without dispatching or reserving anything. Whenever admission
 * was asked it also reports the weekly window's room, which is what ranks a
 * stage's options against each other.
 *
 * `alsoAuthorized` names actions the task takes after the run — a merge — that
 * the tier's runtime must hold authority for too, so a tier that could run but
 * not finish is not chosen.
 */
export async function tierAvailability(
  ctx: PassContext, stage: PassStage, tier: Tier, taskId: string, actions: ActionId[], entry: 'skill' | 'review-pr' | 'prompt' = 'prompt',
  alsoAuthorized: ActionId[] = [],
): Promise<{ ok: true; room?: WeeklyRoom } | { ok: false; reason: string; kind: OutcomeKind; room?: WeeklyRoom }> {
  const authority = ctx.commands.authorize({
    repo: ctx.slug, workClass: `loop-${stage}`, runtime: tier.runtime, profile: 'default', actions,
    triggerSource: ctx.triggerSource, taskId, settings: { model: tier.model, effort: tier.effort },
    ...(actions.includes('open-pr') ? { prBase: ctx.base } : {}),
  });
  if (!authority.allowed) {
    const floor = (authority.outcome.details?.['violations'] as string[] | undefined)?.join('; ');
    return { ok: false, kind: authority.outcome.kind, reason: `no authority on ${tier.runtime}: ${authority.outcome.summary}${floor ? ` (${floor})` : ''}` };
  }
  if (alsoAuthorized.length > 0) {
    const after = ctx.commands.authorize({
      repo: ctx.slug, workClass: `loop-${stage}`, runtime: tier.runtime, profile: 'default', actions: alsoAuthorized,
      triggerSource: ctx.triggerSource, taskId,
    });
    if (!after.allowed) return { ok: false, kind: after.outcome.kind, reason: `no authority for ${alsoAuthorized.join(', ')} on ${tier.runtime}: ${after.outcome.summary}` };
  }
  const notReady = await ctx.commands.readiness(tier.runtime, entry);
  if (notReady) return { ok: false, kind: notReady.kind, reason: `${tier.runtime} not ready: ${notReady.summary}` };
  const admission = await ctx.commands.admissionPreview(tier.runtime, taskId, {
    fiveHourPercent: tier.fiveHourPercent, weeklyPercent: tier.weeklyPercent, basis: 'operator-bound',
    uncertaintyPercent: 1, detail: `operator-set bound, ${tier.line}`,
  });
  const room = weeklyRoom(admission.windows?.find((w) => w.kind === 'weekly'));
  if (!admission.admitted) return { ok: false, kind: 'quota-waiting', reason: `admission refused on ${tier.runtime}: ${admission.reason ?? 'no reason given'}`, ...(room ? { room } : {}) };
  return { ok: true, ...(room ? { room } : {}) };
}

/** What a stage asks of its options: the same task the dispatch would be, so the answer is the dispatch's. */
export interface ChoiceRequest {
  stage: PassStage;
  /** The item the choice is for, named in the pass log. */
  subject: string;
  taskId: string;
  actions: ActionId[];
  entry?: 'skill' | 'review-pr' | 'prompt';
  alsoAuthorized?: ActionId[];
}

export interface Choice {
  /** The option to run; absent when none could start. */
  tier?: Tier;
  /** Why none could start, each option named with its own reason. */
  reason?: string;
  kind?: OutcomeKind;
  reports: OptionReport[];
}

/**
 * Pick which of a stage's options runs this one task.
 *
 * Every option the policy lists for the stage is asked whether it could start —
 * authority, readiness and admission, as a dispatch would meet them — and the
 * ones that could are ranked by weekly room divided by hours until that window
 * resets, highest first. The first is returned. One pass-log line names the
 * choice and every option's numbers or reason.
 */
export async function chooseOption(ctx: PassContext, request: ChoiceRequest): Promise<Choice> {
  const options = stageOptions(ctx.policy, request.stage);
  const reports: OptionReport[] = [];
  const kinds = new Map<Tier, OutcomeKind>();
  for (const tier of options) {
    const available = await tierAvailability(ctx, request.stage, tier, request.taskId, request.actions, request.entry ?? 'prompt', request.alsoAuthorized);
    if (available.ok) {
      reports.push({ tier, ...(available.room ? { room: available.room } : {}) });
    } else {
      kinds.set(tier, available.kind);
      reports.push({ tier, unavailable: available.reason, ...(available.room ? { room: available.room } : {}) });
    }
  }
  const [best] = rankOptions(reports);
  ctx.log(renderChoice(request.stage, request.subject, best?.tier, reports));
  if (best) return { tier: best.tier, reports };
  const reason = reports.length === 1
    ? reports[0]!.unavailable!
    : reports.map((r) => `${tierLabel(r.tier)}: ${r.unavailable}`).join('; ');
  return { reason, kind: kinds.get(options[0]!) ?? 'quota-waiting', reports };
}

/** The options a stage lists, for a plan's detail line. */
export const optionsLabel = (options: readonly Tier[]): string => options.map((t) => `${t.model}·${t.effort}`).join(' | ');

/** What an item reports when none of its stage's options could start. */
export function noOption(choice: Choice): ActResult {
  const why = `not dispatched: ${choice.reason ?? 'no option could start'}`;
  return { produced: false, summary: why, blocked: `${choice.kind ?? 'quota-waiting'}: ${why}` };
}

/**
 * In a dry run, turn a dispatch decision into `blocked` when none of its options
 * could run now, and otherwise say which one would — the same authority,
 * readiness and admission a real dispatch meets, asked without dispatching. A
 * real pass lets the choice at dispatch time answer.
 */
export async function previewDispatch(ctx: PassContext, item: Item, request: ChoiceRequest): Promise<void> {
  if (!ctx.options.dryRun || item.decision.kind !== 'dispatch') return;
  const choice = await chooseOption(ctx, request);
  item.decision = choice.tier
    ? { kind: 'dispatch', detail: `${item.decision.detail}; would run on ${tierLabel(choice.tier)}` }
    : { kind: 'blocked', reason: `tier unavailable: ${choice.reason}` };
}

/** Why a dispatch did not produce a finished run, in one line for the pass log. */
export function whyNot(result: DispatchCommandResult): string {
  return `${result.outcome.kind}: ${result.outcome.summary}`;
}

export const short = (sha: string): string => sha.slice(0, 8);
