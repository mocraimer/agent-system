import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scorecard } from '../../eval/scorecard.js';
import { listScorecards } from '../../eval/scorecard.js';
import { latestIncidentSuite } from '../../eval/cases.js';
import { compareConfigurations, listTrials } from '../../eval/oracle.js';
import type { Configuration } from '../../eval/replay-run.js';
import { renderConfiguration, replaySuite, STAGE_KIND } from '../../eval/replay-run.js';
import { referencedNumbers } from '../../console/facts.js';
import type { SnapshotSource } from '../../console/snapshot.js';
import type { ProposalGit } from '../../console/steer.js';
import { applyChange, proposeFileChange } from '../../console/steer.js';
import type { VerdictTally } from '../../console/verdicts.js';
import { derivationContext, verdictsFor } from '../../console/verdicts.js';
import type { RuntimeId } from '../../core/authority.js';
import { getRun } from '../../core/run.js';
import type { Store } from '../github.js';
import { chooseOption, noOption, outputPath, readOutput, runModel, whyNot, worktreeDir } from '../context.js';
import type { LoopPolicy, Sourced, Tier } from '../policy.js';
import { parseStoreConfig, PolicyError, STORE_CONFIG_PATH, tierRowsOf } from '../policy.js';
import type { PromptStage } from '../prompts.js';
import { improvePrompt, promptDigestOf, promptTemplate, promptTemplatePath, PROMPT_STAGES, renderTemplate } from '../prompts.js';
import type { Item, PassContext, StagePlan } from '../types.js';

/**
 * The improve stage: from the loop's own scorecards, pick the one knob — a stage
 * on a tier with a prompt version — that the store's rule ranks worst, draft one
 * bounded change to it, measure the change against the frozen cases where it can
 * be measured, and propose it as a pull request. It never edits live
 * configuration: the change is a branch and a pull request, in the repository
 * that owns what it changes, for a person to merge or close. A prompt change with
 * no repository named for it in the floor stays a draft in the state directory.
 */

/** What the improve stage reads besides the pass context. */
export interface ImproveDeps {
  /** A read of the store, for the verdicts derived from what the operator did. */
  snapshots?: SnapshotSource;
  /** The target repository's git, for a tier proposal against its base branch. */
  targetGit: ProposalGit;
  /** The coordinator's own repository, for a prompt proposal; absent, the draft is saved in the state directory. */
  coordinator?: { git: ProposalGit; store: Pick<Store, 'openPulls' | 'createPull' | 'updatePullBody'>; slug: string; base: string; path: string; commit: string };
  /** How the stage was started, said in the pull request body. */
  command: string;
  /** A pull request's title and body, for the review a replay quotes. */
  pull(number: number): Promise<{ title: string; body: string }>;
}

/* ---------------------------------------------------------------- settings */

export const CRITERIA = ['explicit-not-accepted', 'derived-not-accepted', 'escalations', 'repairs', 'findings', 'weekly-bound'] as const;
export type Criterion = typeof CRITERIA[number];

export interface ImproveSettings {
  minimumSample: Sourced<number>;
  intervalHours: Sourced<number>;
  rankBy: Sourced<Criterion[]>;
}

/** The improve rows of the store's Loop limits, or why the stage cannot run. */
export function improveSettings(policy: LoopPolicy): ImproveSettings | { missing: string } {
  const row = (name: string): Sourced<string> | undefined => policy.limits.get(name);
  const sample = row('improve minimum sample');
  const interval = row('improve interval hours');
  const rank = row('improve rank by');
  const absent = [['improve minimum sample', sample], ['improve interval hours', interval], ['improve rank by', rank]].filter(([, v]) => v === undefined).map(([k]) => k);
  if (absent.length > 0 || !sample || !interval || !rank) return { missing: `${STORE_CONFIG_PATH} "Loop limits" has no ${absent.map((a) => `"${a}"`).join(', ')} row` };
  const whole = (s: Sourced<string>, what: string): Sourced<number> => {
    const n = Number(s.value);
    if (!Number.isInteger(n) || n < 1) throw new PolicyError(`"${what}" must be a positive whole number, in ${s.line}`);
    return { value: n, line: s.line };
  };
  const keys = rank.value.split(',').map((k) => k.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !(CRITERIA as readonly string[]).includes(k));
  if (keys.length === 0 || unknown.length > 0) throw new PolicyError(`"improve rank by" names ${unknown.length ? `unknown criteria ${unknown.join(', ')}` : 'nothing'}; it takes ${CRITERIA.join(', ')}, in ${rank.line}`);
  return { minimumSample: whole(sample, 'improve minimum sample'), intervalHours: whole(interval, 'improve interval hours'), rankBy: { value: keys as Criterion[], line: rank.line } };
}

export function improveDue(settings: ImproveSettings, last: string | undefined, now: Date): boolean {
  return last === undefined || now.getTime() - Date.parse(last) >= settings.intervalHours.value * 3_600_000;
}

/* ---------------------------------------------------------------- ranking */

export interface KnobRow {
  /** `review · pi-local/gpt-6-luna/max · 1a2b3c4d5e6f`. */
  key: string;
  stage: string;
  runtime: string;
  model: string;
  effort: string;
  digest: string;
  runs: number;
  derived: VerdictTally;
  explicit: VerdictTally;
  reviews: number;
  findings: number;
  repairs: number;
  escalations: number;
  /** The weekly bound the store configuration holds back for one run on this tier, or null when no row names it. */
  weeklyBound: number | null;
}

const tally = (): VerdictTally => ({ accepted: 0, 'rework-needed': 0, rejected: 0 });

/** The prompt template a loop stage renders. */
const templateOf = (stage: string): PromptStage | undefined => {
  const t = stage === 'merge' ? 'check' : stage;
  return (PROMPT_STAGES as readonly string[]).includes(t) ? t as PromptStage : undefined;
};

function weeklyBound(policy: LoopPolicy, stage: string, runtime: string, model: string, effort: string): number | null {
  if (stage === 'review') {
    return policy.reviewLadder.find((t) => t.runtime === runtime && t.model === model && t.effort === effort)?.weeklyPercent ?? null;
  }
  return stageRow(policy, stage, runtime, model, effort)?.weeklyPercent ?? null;
}

/**
 * The "Stage tiers" row a knob's tier stands on: the row naming the same runtime,
 * model and effort, else the stage's row for that runtime, else its first. A stage
 * lists one option per family, and a knob's tier is one of them or a past one.
 */
function stageRow(policy: LoopPolicy, stage: string, runtime: string, model: string, effort: string): Tier | undefined {
  const rows = policy.stageTiers.get(tierRowsOf(stage)) ?? [];
  return rows.find((t) => t.runtime === runtime && t.model === model && t.effort === effort) ?? rows.find((t) => t.runtime === runtime) ?? rows[0];
}

/**
 * Group the loop's scorecards by stage, tier and prompt digest, counting each
 * source of verdict apart. A run admission refused never reached a runtime, so it
 * is not part of the sample — the same rule the coordinator's attempt count uses.
 */
export function knobRows(
  cards: Scorecard[], verdicts: ReturnType<typeof verdictsFor>, policy: LoopPolicy,
  status: (runId: string) => string | undefined = (id) => getRun(id)?.status,
): KnobRow[] {
  const rows = new Map<string, KnobRow>();
  for (const card of cards) {
    // The improve stage's own drafting runs are not a knob it tunes.
    if (!card.loop || card.loop.stage === 'improve') continue;
    const { model, effort } = card.settings.resolved;
    const digest = card.settings.prompt?.digest ?? 'unrecorded';
    const key = `${card.loop.stage} · ${card.runtime}/${model}/${effort} · ${digest.slice(0, 12)}`;
    const row = rows.get(key) ?? {
      key, stage: card.loop.stage, runtime: card.runtime, model, effort, digest, runs: 0, derived: tally(), explicit: tally(),
      reviews: 0, findings: 0, repairs: 0, escalations: 0, weeklyBound: weeklyBound(policy, card.loop.stage, card.runtime, model, effort),
    };
    row.runs += card.runIds.filter((id) => status(id) !== 'quota-waiting').length;
    row.reviews += (card.reviews ?? []).length;
    row.findings += (card.reviews ?? []).reduce((s, r) => s + r.findingCount, 0);
    row.repairs += card.repairs.length;
    if (card.loop.escalated) row.escalations++;
    for (const v of verdicts.filter((x) => x.cardId === card.id)) row[v.source][v.verdict]++;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function criterionValue(row: KnobRow, c: Criterion): number {
  switch (c) {
    case 'explicit-not-accepted': return row.explicit['rework-needed'] + row.explicit.rejected;
    case 'derived-not-accepted': return row.derived['rework-needed'] + row.derived.rejected;
    case 'escalations': return row.escalations;
    case 'repairs': return row.repairs;
    case 'findings': return row.findings;
    case 'weekly-bound': return row.weeklyBound ?? 0;
  }
}

/**
 * Rank the knobs with at least the minimum sample, worst first, by each
 * criterion in the stated order. The pick is the first knob past the rule: one
 * with a non-zero count under some criterion other than cost. Nothing here adds
 * one source of verdict to another or divides one count by another.
 */
export function rankKnobs(rows: KnobRow[], settings: ImproveSettings): { ranked: KnobRow[]; eligible: KnobRow[]; pick?: KnobRow } {
  const order = settings.rankBy.value;
  const ranked = [...rows].sort((a, b) => {
    for (const c of order) {
      const d = criterionValue(b, c) - criterionValue(a, c);
      if (d !== 0) return d;
    }
    return a.key.localeCompare(b.key);
  });
  const eligible = ranked.filter((r) => r.runs >= settings.minimumSample.value);
  const pick = eligible.find((r) => order.some((c) => c !== 'weekly-bound' && criterionValue(r, c) > 0));
  return { ranked, eligible, ...(pick ? { pick } : {}) };
}

const t3 = (t: VerdictTally): string => `${t.accepted}/${t['rework-needed']}/${t.rejected}`;

export function renderRanking(ranked: KnobRow[], settings: ImproveSettings): string[] {
  const lines = [
    'knob (stage · tier · prompt)'.padEnd(58) + 'runs  derived a/r/x  explicit a/r/x  reviews  findings  repairs  escalations  weekly',
  ];
  for (const r of ranked) {
    lines.push([
      r.key.padEnd(57), String(r.runs).padStart(5), t3(r.derived).padStart(15), t3(r.explicit).padStart(16), String(r.reviews).padStart(9),
      String(r.findings).padStart(10), String(r.repairs).padStart(9), String(r.escalations).padStart(13),
      (r.weeklyBound === null ? '-' : `${r.weeklyBound}%`).padStart(8), r.runs < settings.minimumSample.value ? '  (below sample)' : '',
    ].join(''));
  }
  if (ranked.length === 0) lines.push('   (no scorecard carries a loop record for this repository)');
  return lines;
}

export function renderRule(settings: ImproveSettings): string[] {
  return [
    'Rule, as the store configuration states it:',
    `   ${settings.minimumSample.line}`,
    `   ${settings.rankBy.line}`,
    `   ${settings.intervalHours.line}`,
    `   Knobs with fewer than ${settings.minimumSample.value} runs are not ranked for a proposal. The rest are ordered worst first by ${settings.rankBy.value.join(', then ')};`,
    '   the pick is the first with a non-zero count under a criterion other than cost. Derived and explicit verdicts are separate criteria, never summed.',
  ];
}

/* ---------------------------------------------------------------- drafting */

export type Draft =
  | { kind: 'prompt'; template: string; rationale: string }
  | { kind: 'tier'; tier: { runtime: RuntimeId; model: string; effort: string; fiveHourPercent: number; weeklyPercent: number }; rationale: string };

const RUNTIMES: readonly RuntimeId[] = ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'];
const placeholders = (t: string): string[] => [...new Set([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))].sort();

/** Read the drafting run's JSON; a draft that drops a placeholder or names no real runtime is refused. */
export function parseDraft(text: string, current: string): Draft {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error('the draft is not a JSON object');
  const d = JSON.parse(json) as Record<string, unknown>;
  const rationale = typeof d['rationale'] === 'string' ? d['rationale'].trim() : '';
  if (!rationale) throw new Error('the draft gives no rationale');
  if (d['kind'] === 'prompt') {
    const template = typeof d['template'] === 'string' ? d['template'] : '';
    if (template.trim() === '' || template === current) throw new Error('the drafted template is empty or unchanged');
    if (placeholders(template).join(',') !== placeholders(current).join(',')) {
      throw new Error(`the drafted template changes the placeholders (${placeholders(template).join(', ')} instead of ${placeholders(current).join(', ')})`);
    }
    renderTemplate(template, Object.fromEntries(placeholders(current).map((p) => [p, 'x'])));
    return { kind: 'prompt', template: template.endsWith('\n') ? template : `${template}\n`, rationale };
  }
  if (d['kind'] === 'tier') {
    const t = (d['tier'] ?? {}) as Record<string, unknown>;
    const runtime = t['runtime'] as RuntimeId;
    const five = Number(t['fiveHourPercent']);
    const weekly = Number(t['weeklyPercent']);
    if (!RUNTIMES.includes(runtime) || typeof t['model'] !== 'string' || typeof t['effort'] !== 'string' || !/^[\w.·-]+$/.test(t['model']) || !/^[\w-]+$/.test(t['effort'])
      || !Number.isInteger(five) || !Number.isInteger(weekly) || five < 0 || weekly < 0 || five > 100 || weekly > 100) {
      throw new Error('the drafted tier does not name a runtime, a model, an effort and whole-number bounds');
    }
    return { kind: 'tier', tier: { runtime, model: t['model'], effort: t['effort'], fiveHourPercent: five, weeklyPercent: weekly }, rationale };
  }
  throw new Error(`the draft's kind is ${String(d['kind'])}, not prompt or tier`);
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const improveBranch = (row: KnobRow): string => `improve/${slugOf(`${row.stage}-${row.runtime}-${row.model}-${row.effort}`)}-${row.digest.slice(0, 8)}`;

/* ---------------------------------------------------------------- the stage */

export async function planImprove(ctx: PassContext, deps: ImproveDeps | undefined): Promise<StagePlan> {
  const plan: StagePlan = { stage: 'improve', items: [], notes: [], faults: [] };
  const settings = improveSettings(ctx.policy);
  if ('missing' in settings) {
    plan.notes.push(`improve: ${settings.missing}; the stage proposes nothing until the store configuration states its rule`);
    return plan;
  }
  const cards = listScorecards().filter((c) => c.repo === ctx.slug && c.loop);
  let verdicts: ReturnType<typeof verdictsFor> = verdictsFor(cards, undefined);
  if (deps?.snapshots) {
    try {
      const snapshot = await deps.snapshots.read(referencedNumbers(cards));
      verdicts = verdictsFor(cards, derivationContext(snapshot, ctx.rules.SHAPE_MARKER));
    } catch (err) {
      plan.notes.push(`improve: derived verdicts not read — the store read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    plan.notes.push('improve: derived verdicts not read — no store snapshot was given; explicit verdicts only');
  }
  const { ranked, eligible, pick } = rankKnobs(knobRows(cards, verdicts, ctx.policy), settings);
  plan.notes.push('Ranking:', ...renderRanking(ranked, settings).map((l) => `   ${l}`), ...renderRule(settings));
  if (!pick) {
    plan.notes.push(eligible.length === 0
      ? `no proposal: sample below N for every knob (N = ${settings.minimumSample.value}, ${settings.minimumSample.line})`
      : `no proposal: none of the ${eligible.length} knob(s) with at least ${settings.minimumSample.value} runs has a count under the rule's criteria`);
    return plan;
  }
  const template = templateOf(pick.stage);
  const tierRow = pick.stage === 'review' ? undefined : stageRow(ctx.policy, pick.stage, pick.runtime, pick.model, pick.effort);
  const kinds = [template ? `the ${template} prompt template (${promptTemplatePath(template)})` : undefined, tierRow ? `the ${tierRowsOf(pick.stage)} tier row` : undefined].filter(Boolean);
  const item: Item = {
    ref: `knob ${pick.key}`,
    decision: { kind: 'dispatch', detail: `would draft one change to ${kinds.join(' or ')}, replay the frozen cases where the stage has them, and open one pull request on ${improveBranch(pick)}${template && !deps?.coordinator ? ' (a prompt change is saved as a draft instead: no prompt proposal repository is named in the floor)' : ''}` },
  };
  if (!deps) {
    item.decision = { kind: 'blocked', reason: 'the improve stage has no git to propose through in this run' };
  } else if (!template) {
    item.decision = { kind: 'blocked', reason: `the ${pick.stage} stage has no prompt template the loop renders` };
  } else {
    item.act = () => actOnKnob(ctx, deps, pick, template, settings, ranked);
  }
  plan.items.push(item);
  return plan;
}

async function actOnKnob(ctx: PassContext, deps: ImproveDeps, row: KnobRow, template: PromptStage, settings: ImproveSettings, ranked: KnobRow[]): Promise<{ produced: boolean; summary: string; blocked?: string }> {
  const taskId = `loop-improve-${slugOf(row.key).slice(0, 60)}-${Date.now().toString(36)}`;
  const picked = await chooseOption(ctx, { stage: 'improve', subject: `knob ${row.key}`, taskId, actions: ['review'] });
  if (!picked.tier) return noOption(picked);
  const tier = picked.tier;
  const out = outputPath(ctx, taskId);
  const current = promptTemplate(template);
  const evidence = [...renderRanking(ranked, settings), '', ...renderRule(settings)].join('\n');
  const tierRow = row.stage === 'review' ? undefined : stageRow(ctx.policy, row.stage, row.runtime, row.model, row.effort);
  const result = await runModel(ctx, {
    outputPath: out, loop: { stage: 'improve', item: `knob ${row.key}`, workType: 'improve' },
    stage: 'improve', template: 'improve', tier, taskId, cwd: ctx.stateDir, actions: ['review'], timeoutMs: 1_800_000,
    prompt: improvePrompt({
      stage: row.stage, tier: `${row.runtime}/${row.model}/${row.effort}`, digest: row.digest.slice(0, 12),
      ...(tierRow ? { tierRow: `${tierRow.runtime} ${tierRow.model} ${tierRow.effort}, ${tierRow.fiveHourPercent}% five-hour, ${tierRow.weeklyPercent}% weekly (${tierRow.line})` } : {}),
      evidence, template: current, outputPath: out,
    }),
  });
  const text = result.outcome.kind === 'completed' ? readOutput(out, result) : undefined;
  if (!text) return { produced: false, summary: `no draft: ${whyNot(result)}`, ...(result.runtimeDispatched ? {} : { blocked: whyNot(result) }) };
  let draft: Draft;
  try {
    draft = parseDraft(text, current);
  } catch (err) {
    return { produced: false, summary: `the draft was refused: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (draft.kind === 'tier' && !tierRow) return { produced: false, summary: `the draft proposes a tier, but the ${row.stage} stage has no tier row to change` };

  const trial = await trials(ctx, deps, row, template, draft);
  const body = renderImproveBody({ ctx, deps, row, draft, trial, settings, ranked, taskId, runId: result.run?.id });
  const title = draft.kind === 'prompt'
    ? `improve(loop): the ${template} prompt, from the counts behind ${row.stage} on ${row.runtime}/${row.model}/${row.effort}`
    : `improve(policy): the ${row.stage === 'merge' ? 'check' : row.stage} tier ${row.runtime}/${row.model}/${row.effort} → ${draft.tier.runtime}/${draft.tier.model}/${draft.tier.effort}`;
  const branch = improveBranch(row);
  let pr: { pr: number; opened: boolean; repo: string };
  if (draft.kind === 'prompt') {
    if (!deps.coordinator) {
      // Nothing leaves the machine: the operator reads the draft and decides where it goes.
      const dir = join(ctx.stateDir, 'improve-drafts', branch.replaceAll('/', '-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pull-request.md'), `# ${title}\n\n${body}\n`, 'utf8');
      writeFileSync(join(dir, promptTemplatePath(template).split('/').pop()!), draft.template, 'utf8');
      ctx.commands.recordLoop(taskId, { stage: 'improve', item: `knob ${row.key}`, workType: 'improve', wrote: dir });
      return { produced: true, summary: `saved the draft to ${dir}; no prompt proposal repository is named in the floor` };
    }
    const c = deps.coordinator;
    const r = await proposeFileChange({ git: c.git, store: c.store, worktree: worktreeDir(ctx, 'improve-coordinator') }, {
      base: c.base, branch, file: promptTemplatePath(template), edit: () => draft.template,
      commitMessage: `improve(loop): propose a change to the ${template} prompt\n\nDrafted by the improve stage from ${row.runs} run(s) of ${row.key}; see the pull request for the counts and trials.`,
      title, body,
    });
    pr = { pr: r.pr, opened: r.opened, repo: c.slug };
  } else {
    const stage = row.stage === 'merge' ? 'check' : row.stage;
    const r = await proposeFileChange({ git: deps.targetGit, store: ctx.store, worktree: worktreeDir(ctx, 'improve-target') }, {
      base: ctx.base, branch, file: STORE_CONFIG_PATH,
      edit: (t) => applyChange(t, { kind: 'tier', stage, ...draft.tier }),
      validate: (t) => { parseStoreConfig(t); },
      commitMessage: `chore(policy): propose the ${stage} tier ${draft.tier.runtime}/${draft.tier.model}/${draft.tier.effort}\n\nDrafted by the coordinator's improve stage; see the pull request for the counts behind it.`,
      title, body,
    });
    pr = { pr: r.pr, opened: r.opened, repo: ctx.slug };
  }
  ctx.commands.recordLoop(taskId, { stage: 'improve', item: `knob ${row.key}`, workType: 'improve', wrote: `PR #${pr.pr} in ${pr.repo}` });
  return { produced: true, summary: `${pr.opened ? 'opened' : 'updated'} https://github.com/${pr.repo}/pull/${pr.pr} on ${branch}` };
}

interface TrialOutcome {
  /** Why no trial ran, when none did. */
  none?: string;
  before?: string;
  after?: string;
  suite?: string;
  /** The comparison as `agentsys replay compare` prints it. */
  compare?: string[];
}

/** Replay the frozen cases of the stage's kind on the knob as it is and as drafted. */
async function trials(ctx: PassContext, deps: ImproveDeps, row: KnobRow, template: PromptStage, draft: Draft): Promise<TrialOutcome> {
  const kind = STAGE_KIND[template];
  if (!kind) return { none: `the ${row.stage} stage has no replayable case kind, so the change is proposed on its counts alone` };
  const suite = latestIncidentSuite();
  const cases = suite?.cases.filter((c) => c.kind === kind && !c.isFixture) ?? [];
  if (!suite || cases.length === 0) return { none: `no frozen incident suite holds a ${kind} case yet, so there is nothing to replay` };
  const runtime = row.runtime as RuntimeId;
  const before: Configuration = { stage: template, runtime, model: row.model, effort: row.effort, digest: promptDigestOf(promptTemplate(template)) };
  const after: Configuration = draft.kind === 'prompt'
    ? { ...before, digest: promptDigestOf(draft.template) }
    : { ...before, runtime: draft.tier.runtime, model: draft.tier.model, effort: draft.tier.effort };
  const replay = {
    repo: ctx.repo, dispatch: ctx.commands.dispatch.bind(ctx.commands), scratch: join(ctx.stateDir, 'replay'), triggerSource: ctx.triggerSource,
    pull: deps.pull,
  };
  await replaySuite(replay, suite, before);
  await replaySuite(replay, suite, after, draft.kind === 'prompt' ? draft.template : promptTemplate(template));
  const a = renderConfiguration(before);
  const b = renderConfiguration(after);
  const trialsOf = listTrials().filter((t) => t.suiteVersion === suite.version);
  const show = (v: boolean | undefined): string => (v === undefined ? 'not run' : v ? 'pass' : 'FAIL');
  return {
    before: a, after: b, suite: suite.version,
    compare: [
      `Suite ${suite.version}: ${a} (${trialsOf.filter((t) => t.configuration === a).length} trial(s)) vs ${b} (${trialsOf.filter((t) => t.configuration === b).length} trial(s))`,
      ...compareConfigurations(trialsOf, a, b).map((r) => `  ${r.caseId.padEnd(34)} ${show(r.a).padEnd(8)} ${show(r.b)}`),
    ],
  };
}

function renderImproveBody(p: {
  ctx: PassContext; deps: ImproveDeps; row: KnobRow; draft: Draft; trial: TrialOutcome; settings: ImproveSettings; ranked: KnobRow[]; taskId: string; runId: string | undefined;
}): string {
  const { ctx, deps, row, draft, trial, settings, ranked } = p;
  return [
    'The coordinator\'s improve stage drafted this change and applied nothing. It changes only what a person merges.',
    '',
    `**Knob:** \`${row.key}\` — ${row.runs} run(s), derived verdicts ${t3(row.derived)} and explicit verdicts ${t3(row.explicit)} (accepted/rework-needed/rejected, counted apart), ${row.findings} finding(s) over ${row.reviews} review(s), ${row.repairs} repair(s), ${row.escalations} escalation(s).`,
    '',
    '### The rule that picked it',
    '',
    '```',
    ...renderRule(settings),
    '```',
    '',
    '### The ranking',
    '',
    '```',
    ...renderRanking(ranked.slice(0, 8), settings),
    '```',
    '',
    '### The change',
    '',
    draft.kind === 'prompt'
      ? `An edit to \`${promptTemplatePath(templateOf(row.stage)!)}\` (digest ${row.digest.slice(0, 12)} → ${promptDigestOf(draft.template).slice(0, 12)}).`
      : `The ${row.stage === 'merge' ? 'check' : row.stage} row of \`${STORE_CONFIG_PATH}\` "Stage tiers": ${row.runtime}/${row.model}/${row.effort} → ${draft.tier.runtime}/${draft.tier.model}/${draft.tier.effort}, bounds ${draft.tier.fiveHourPercent}% five-hour, ${draft.tier.weeklyPercent}% weekly.`,
    '',
    `The drafting run's rationale (run ${p.runId ?? 'unrecorded'}, task ${p.taskId}), quoted:`,
    '',
    ...draft.rationale.split('\n').map((l) => `> ${l}`),
    '',
    '### Trials',
    '',
    ...(trial.none
      ? [`No trial: ${trial.none}.`]
      : [
        `The frozen suite ${trial.suite}'s cases, replayed on the knob as it is (\`${trial.before}\`) and as drafted (\`${trial.after}\`). \`agentsys replay compare --version ${trial.suite} --a ${trial.before} --b ${trial.after}\` prints:`,
        '',
        '```',
        ...trial.compare!,
        '```',
      ]),
    '',
    '### Where this came from',
    '',
    `- Command: \`${deps.command}\``,
    `- Pass ${ctx.passId}; target ${ctx.slug} at ${ctx.base} ${ctx.baseSha.slice(0, 12)}; policy ${ctx.policy.source}`,
    ...(deps.coordinator ? [`- Coordinator: ${deps.coordinator.path} at ${deps.coordinator.commit.slice(0, 12)}`] : []),
    `- Scorecards and trials: ${join(ctx.stateDir, '..', '..')}`,
  ].join('\n');
}
