import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DispatchCommandResult, DispatchTaskInput } from '../commands.js';
import type { RuntimeId } from '../core/authority.js';
import { newId } from '../core/store.js';
import { isolatedWorktreeDir, readOutput } from '../loop/context.js';
import { promptDigestOf, promptTemplate, reviewPrompt } from '../loop/prompts.js';
import type { PromptStage } from '../loop/prompts.js';
import { parseFindings, REVIEW_TIMEOUT_MS } from '../loop/stages/review.js';
import type { CaseResult, EvalCase, EvalSuite, TrialResult } from './oracle.js';
import { scoreTrial } from './oracle.js';

/**
 * Replaying a frozen case against one configuration of a stage.
 *
 * A configuration is `stage:runtime/model/effort:prompt-digest` — the three
 * things the improve stage can change. The case runs through the same prompt
 * the stage would build, on that tier, as a real model run dispatched through
 * the coordinator, and the trial is scored against the frozen oracle.
 */

const RUNTIMES: readonly RuntimeId[] = ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'];

export interface Configuration {
  stage: PromptStage;
  runtime: RuntimeId;
  model: string;
  effort: string;
  /** A digest, or a prefix of one of at least eight characters. */
  digest: string;
}

/** Which case kind each replayable stage answers. */
export const STAGE_KIND: Partial<Record<PromptStage, EvalCase['kind']>> = {
  review: 'reviewer-detects-bad-candidate',
};

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

export function parseConfiguration(text: string): Configuration {
  const m = /^([a-z]+):([a-z-]+)\/([^/:\s]+)\/([^/:\s]+):([0-9a-f]{8,64})$/.exec(text.trim());
  if (!m) throw new ReplayError(`"${text}" is not a configuration: write stage:runtime/model/effort:prompt-digest, e.g. review:pi-local/gpt-6-luna/max:1a2b3c4d.`);
  const [, stage, runtime, model, effort, digest] = m as unknown as [string, string, string, string, string, string];
  if (!(stage in STAGE_KIND)) throw new ReplayError(`The ${stage} stage has no replayable case kind; replayable: ${Object.keys(STAGE_KIND).join(', ')}.`);
  if (!RUNTIMES.includes(runtime as RuntimeId)) throw new ReplayError(`"${runtime}" is not a runtime the coordinator has.`);
  return { stage: stage as PromptStage, runtime: runtime as RuntimeId, model, effort, digest };
}

export const renderConfiguration = (c: Configuration): string => `${c.stage}:${c.runtime}/${c.model}/${c.effort}:${c.digest.slice(0, 12)}`;

export interface ReplayDeps {
  repo: {
    slug(): Promise<string>;
    fetch(refs: string[]): Promise<void>;
    addWorktree(dir: string, ref: string): Promise<void>;
    removeWorktree(dir: string): Promise<void>;
  };
  dispatch(input: DispatchTaskInput): Promise<DispatchCommandResult>;
  /** Evidence root; target worktrees use the shared isolated worker location. */
  scratch: string;
  /** The individual approval the runs are dispatched under, when not a grant. */
  approvalId?: string;
  triggerSource?: string;
  /** The pull request's title and body, read when the case is run; the review quotes them. */
  pull(number: number): Promise<{ title: string; body: string }>;
}

/**
 * Run every case of the configuration's kind and score the trial. The template
 * is the stage's current one unless a drafted one is given, and its digest must
 * be the configuration's: a trial is only evidence about the prompt it names.
 */
export async function replaySuite(deps: ReplayDeps, suite: EvalSuite, config: Configuration, template = promptTemplate(config.stage)): Promise<TrialResult & { runs: Array<{ caseId: string; runId?: string; outcome: string; observed: string }> }> {
  const digest = promptDigestOf(template);
  if (!digest.startsWith(config.digest)) {
    throw new ReplayError(`The configuration names prompt ${config.digest}, but the ${config.stage} template given has digest ${digest.slice(0, 12)}.`);
  }
  const kind = STAGE_KIND[config.stage]!;
  const slug = await deps.repo.slug();
  const results: CaseResult[] = [];
  const runs: Array<{ caseId: string; runId?: string; outcome: string; observed: string }> = [];
  for (const c of suite.cases.filter((x) => x.kind === kind && !x.isFixture)) {
    const pr = Number(c.inputs['pr']);
    const head = c.inputs['head'];
    const base = c.inputs['base'];
    const pattern = c.inputs['defectPattern'];
    if (!Number.isInteger(pr) || !head || !base || !pattern) {
      runs.push({ caseId: c.id, outcome: 'not run', observed: 'the case does not pin pr, head, base and defectPattern' });
      continue;
    }
    const setupStartedAt = new Date().toISOString();
    const dir = isolatedWorktreeDir(deps.scratch, `replay-${c.id}`);
    await deps.repo.fetch([`+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`]);
    await deps.repo.addWorktree(dir, head);
    try {
      mkdirSync(join(deps.scratch, 'out'), { recursive: true });
      const out = join(deps.scratch, 'out', `${c.id}-${newId('review')}.md`);
      const { title, body } = await deps.pull(pr);
      const result = await deps.dispatch({
        taskId: `replay-${c.id}-${newId('t')}`,
        repo: slug,
        workClass: 'replay-review',
        runtime: config.runtime,
        profile: 'default',
        actions: ['review'],
        prompt: reviewPrompt({ repo: slug, pr: { number: pr, title, body, base }, head, outputPath: out, baseRef: base }, template, 'replay'),
        repoPath: dir,
        outputPath: out,
        setupStartedAt,
        settings: { model: config.model, effort: config.effort },
        estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 1, detail: 'one replayed review' },
        timeoutMs: REVIEW_TIMEOUT_MS,
        entry: 'prompt',
        promptVersion: { template: config.stage, digest },
        ...(deps.approvalId ? { approvalId: deps.approvalId } : {}),
        ...(deps.triggerSource ? { triggerSource: deps.triggerSource } : {}),
      });
      const retainedOutput = result.run?.outputPath ?? out;
      const text = result.outcome.kind === 'completed' ? readOutput(out, result) : undefined;
      const matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const observed = text === undefined ? 'no-review' : parseFindings(text).some((f) => matcher.test(f.summary)) ? 'defect-reported' : 'defect-missed';
      runs.push({ caseId: c.id, ...(result.run ? { runId: result.run.id } : {}), outcome: `${result.outcome.kind}: ${result.outcome.summary}`, observed });
      results.push({
        caseId: c.id,
        observed,
        // The review is the evidence: the file the run wrote, or else its final answer in the run's evidence.
        ...(text !== undefined ? { evidenceRef: existsSync(retainedOutput) ? `review ${retainedOutput}` : `review in the final answer under ${result.run?.evidenceDir ?? 'the run'}` } : {}),
        ranChecks: text !== undefined ? ['review'] : [],
      });
    } finally {
      await deps.repo.removeWorktree(dir);
    }
  }
  return { ...scoreTrial(suite, results, renderConfiguration({ ...config, digest })), runs };
}
