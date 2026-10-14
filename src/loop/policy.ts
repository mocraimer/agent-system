import type { RuntimeId } from '../core/authority.js';

/**
 * The loop's policy, read from the target repository's store configuration.
 *
 * Nothing in this file states a rung, a stop-line, a tier or a reviewer. It knows
 * the *shape* of the Stop-lines section — which headings hold which tables — and
 * reads every value out of the file on each pass. A value missing from the file
 * is an error naming the heading, never a default supplied here: the review rule
 * was contradicted for four days by a script holding its own copy of it.
 */

/** Where the policy lives inside the target repository. */
export const STORE_CONFIG_PATH = 'tickets/store-config.md';

export type Family = 'claude' | 'pi';

/**
 * The runtime family a reviewer or author belongs to. Independence is a difference
 * in family, so a runtime added without one must fail to compile here rather than
 * read as independent of everything.
 */
export function familyOf(runtime: RuntimeId): Family {
  switch (runtime) {
    case 'claude-local':
    case 'claude-web':
      return 'claude';
    case 'pi-local':
    case 'codex-cloud':
      return 'pi';
    default: {
      const unhandled: never = runtime;
      throw new Error(`No family for runtime ${String(unhandled)}.`);
    }
  }
}

/** A value with the store-config line it came from, so a decision can cite it. */
export interface Sourced<T> {
  value: T;
  /** `tickets/store-config.md:<line>: <text>` */
  line: string;
}

export interface Rung {
  number: number;
  name: string;
  reachedWhen: string;
  line: string;
}

export interface Tier {
  runtime: RuntimeId;
  model: string;
  effort: string;
  fiveHourPercent: number;
  weeklyPercent: number;
  line: string;
}

export interface ReviewTier extends Tier {
  author: Family;
  order: number;
}

export interface LoopPolicy {
  /** Where it was read from: path and the commit it was read at. */
  source: string;
  rungs: Rung[];
  /** Keyed by the full label, e.g. `type:bug`. */
  typeStopLines: Map<string, Sourced<number>>;
  defaultStopLine: Sourced<number>;
  /** Keyed by the full label, e.g. `effort:backlog-20260917`. */
  effortStopLines: Map<string, Sourced<number>>;
  /** Every option a stage may run on, one row per runtime, in table order. */
  stageTiers: Map<string, Tier[]>;
  reviewLadder: ReviewTier[];
  limits: Map<string, Sourced<string>>;
  protocol: Protocol;
}

/**
 * How the loop meets the target repository: what its own comments are marked
 * with, which branch releases go to, and what proves a release deployed. Read
 * from the "Coordinator protocol" and "Release checks" tables.
 */
export interface Protocol {
  /** Every hidden marker the loop writes or reads starts `<!-- <prefix>-`; the loop signs claims and commits `<prefix>-loop`. */
  markerPrefix: Sourced<string>;
  /** The branch a release pull request targets, which only a person merges into. */
  releaseBranch: Sourced<string>;
  /** The workflow whose completed run on the release branch's head starts post-deploy verification. */
  deployWorkflow?: Sourced<string>;
  /** Run before the checks, in the base-branch worktree; the `key=value` lines it writes to `$GITHUB_OUTPUT` become `{scope.<key>}`. */
  deployScope?: Sourced<string[]>;
  releaseChecks: ReleaseCheck[];
}

/** One post-deploy check, run after the deploy workflow completes. */
export interface ReleaseCheck {
  name: string;
  /** `base` (a worktree of the base branch) or `deployed` (the operator's worktree of the deployed commit), optionally `/<subdirectory>`. */
  runIn: { tree: 'base' | 'deployed'; subdirectory: string };
  /** Program and arguments, split on spaces before placeholders are filled. */
  argv: string[];
  /** Files the operator places in the deployed worktree, relative to its root; named, never read. */
  envFiles: string[];
  timeoutMs: number;
  /** What an exit other than 0 (pass) and 1 (fail) means. */
  otherExits: 'fail' | 'blocked';
  line: string;
}

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
}

const RUNTIMES: readonly RuntimeId[] = ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'];

interface Row {
  cells: string[];
  line: string;
}

/**
 * The rows of the first table under a `###` heading, with the header and the
 * separator row dropped. Cells are trimmed and stripped of backticks.
 */
function tableUnder(lines: string[], heading: string, path: string): Row[] {
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) throw new PolicyError(`${path} has no "### ${heading}" heading under Stop-lines.`);
  const rows: Row[] = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i]!;
    if (/^#{1,3} /.test(text)) break;
    if (!text.trim().startsWith('|')) {
      if (inTable) break;
      continue;
    }
    if (!inTable) {
      inTable = true;
      i++; // the separator row after the header
      continue;
    }
    const cells = text.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/`/g, ''));
    rows.push({ cells, line: `${path}:${i + 1}: ${text.trim()}` });
  }
  if (!inTable) throw new PolicyError(`${path} has no table under "### ${heading}".`);
  return rows;
}

/** Like `tableUnder`, for a table a store configuration may leave out. */
function optionalTableUnder(lines: string[], heading: string, path: string): Row[] {
  return lines.some((l) => l.trim() === `### ${heading}`) ? tableUnder(lines, heading, path) : [];
}

function int(cell: string | undefined, row: Row, what: string): number {
  const n = Number(cell);
  if (cell === undefined || cell === '' || !Number.isInteger(n) || n < 0) {
    throw new PolicyError(`${what} is not a whole number in ${row.line}`);
  }
  return n;
}

function runtime(cell: string | undefined, row: Row): RuntimeId {
  if (!RUNTIMES.includes(cell as RuntimeId)) {
    throw new PolicyError(`"${cell ?? ''}" is not a runtime the coordinator has, in ${row.line}`);
  }
  return cell as RuntimeId;
}

function tier(cells: string[], row: Row): Tier {
  const [rt, model, effort, fiveHour, weekly] = cells;
  if (!model || !effort) throw new PolicyError(`A tier needs a model and an effort, in ${row.line}`);
  return {
    runtime: runtime(rt, row),
    model,
    effort,
    fiveHourPercent: int(fiveHour, row, 'Five-hour %'),
    weeklyPercent: int(weekly, row, 'Weekly %'),
    line: row.line,
  };
}

/** Parse the Stop-lines section and the review ladder out of a store configuration. */
export function parseStoreConfig(text: string, source = STORE_CONFIG_PATH): LoopPolicy {
  try {
    return parse(text, source);
  } catch (err) {
    // Name where the file was read from: with --policy-ref it is not the base branch.
    if (err instanceof PolicyError && source !== STORE_CONFIG_PATH) throw new PolicyError(`${err.message} (read from ${source})`);
    throw err;
  }
}

function parse(text: string, source: string): LoopPolicy {
  const path = STORE_CONFIG_PATH;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((l) => l.trim() === '## Stop-lines')) {
    throw new PolicyError(`${path} has no "## Stop-lines" section; the loop has no policy to run under.`);
  }

  const rungs = tableUnder(lines, 'The rungs', path).map((row): Rung => ({
    number: int(row.cells[0], row, 'Rung'),
    name: row.cells[1] ?? '',
    reachedWhen: row.cells[2] ?? '',
    line: row.line,
  }));

  const typeStopLines = new Map<string, Sourced<number>>();
  let defaultStopLine: Sourced<number> | undefined;
  for (const row of tableUnder(lines, 'Stop-line by type', path)) {
    const [label, rung] = row.cells;
    const value = int(rung, row, 'Stop-line');
    if ((label ?? '').startsWith('default')) defaultStopLine = { value, line: row.line };
    else if ((label ?? '').startsWith('type:')) typeStopLines.set(label!, { value, line: row.line });
    else throw new PolicyError(`"${label ?? ''}" is neither a type:<slug> label nor the default row, in ${row.line}`);
  }
  if (!defaultStopLine) throw new PolicyError(`${path} "Stop-line by type" has no default row.`);

  const effortStopLines = new Map<string, Sourced<number>>();
  for (const row of tableUnder(lines, 'Stop-line by effort', path)) {
    const [label, rung] = row.cells;
    if (!(label ?? '').startsWith('effort:')) throw new PolicyError(`"${label ?? ''}" is not an effort:<slug> label, in ${row.line}`);
    effortStopLines.set(label!, { value: int(rung, row, 'Stop-line'), line: row.line });
  }

  const stageTiers = new Map<string, Tier[]>();
  for (const row of tableUnder(lines, 'Stage tiers', path)) {
    const [stage, ...rest] = row.cells;
    const option = tier(rest, row);
    const options = stageTiers.get(stage ?? '') ?? [];
    const twin = options.find((o) => o.runtime === option.runtime);
    if (twin) throw new PolicyError(`The ${stage ?? ''} stage lists ${option.runtime} twice, in ${twin.line} and in ${row.line}`);
    stageTiers.set(stage ?? '', [...options, option]);
  }

  const reviewLadder = tableUnder(lines, 'Review ladder', path).map((row): ReviewTier => {
    const [author, order, ...rest] = row.cells;
    if (author !== 'claude' && author !== 'pi') throw new PolicyError(`"${author ?? ''}" is not an author family, in ${row.line}`);
    return { author, order: int(order, row, 'Order'), ...tier(rest, row) };
  }).sort((a, b) => (a.author === b.author ? a.order - b.order : a.author.localeCompare(b.author)));

  const limits = new Map<string, Sourced<string>>();
  for (const row of tableUnder(lines, 'Loop limits', path)) {
    limits.set(row.cells[0] ?? '', { value: row.cells[1] ?? '', line: row.line });
  }

  return { source, rungs, typeStopLines, defaultStopLine, effortStopLines, stageTiers, reviewLadder, limits, protocol: protocol(lines, path) };
}

function protocol(lines: string[], path: string): Protocol {
  const settings = new Map<string, Sourced<string>>();
  for (const row of tableUnder(lines, 'Coordinator protocol', path)) {
    settings.set(row.cells[0] ?? '', { value: row.cells[1] ?? '', line: row.line });
  }
  const markerPrefix = settings.get('marker prefix');
  if (!markerPrefix || !/^[a-z0-9][a-z0-9-]*$/.test(markerPrefix.value)) {
    throw new PolicyError(`${path} "Coordinator protocol" needs a "marker prefix" row of lower-case letters, digits and hyphens${markerPrefix ? `, in ${markerPrefix.line}` : ''}.`);
  }
  const releaseBranch = settings.get('release branch') ?? { value: 'main', line: `${path}: default release branch` };
  const deployWorkflow = settings.get('deploy workflow');
  const scope = settings.get('deploy scope command');
  const releaseChecks = optionalTableUnder(lines, 'Release checks', path).map((row): ReleaseCheck => {
    const [name, runIn, command, envFiles, minutes, otherExits] = row.cells;
    const [tree, ...sub] = (runIn ?? '').split('/');
    if (!name) throw new PolicyError(`A release check needs a name, in ${row.line}`);
    if (tree !== 'base' && tree !== 'deployed') throw new PolicyError(`"${runIn ?? ''}" is not base or deployed (optionally /<subdirectory>), in ${row.line}`);
    if (!command) throw new PolicyError(`A release check needs a command, in ${row.line}`);
    if (otherExits !== 'fail' && otherExits !== 'blocked') throw new PolicyError(`"${otherExits ?? ''}" is not fail or blocked, in ${row.line}`);
    return {
      name,
      runIn: { tree, subdirectory: sub.join('/') },
      argv: words(command),
      envFiles: envFiles && envFiles !== '-' ? envFiles.split(',').map((f) => f.trim()).filter(Boolean) : [],
      timeoutMs: int(minutes, row, 'Timeout minutes') * 60_000,
      otherExits,
      line: row.line,
    };
  });
  return {
    markerPrefix,
    releaseBranch,
    ...(deployWorkflow ? { deployWorkflow } : {}),
    ...(scope ? { deployScope: { value: words(scope.value), line: scope.line } } : {}),
    releaseChecks,
  };
}

const words = (command: string): string[] => command.split(/\s+/).filter(Boolean);

/** A rung by the ladder's own name, so a renumbered ladder moves every stage with it. */
export function rung(policy: LoopPolicy, name: string): Rung {
  const found = policy.rungs.find((r) => r.name === name);
  if (!found) throw new PolicyError(`The rung ladder in ${STORE_CONFIG_PATH} has no rung named "${name}".`);
  return found;
}

/** The "Stage tiers" name of the rows a stage reads: the merge stage's model run is the `check` stage. */
export const tierRowsOf = (stage: string): string => (stage === 'merge' ? 'check' : stage);

/** The options a stage may run on, in the order the store configuration lists them. */
export function stageOptions(policy: LoopPolicy, stage: string): Tier[] {
  const found = policy.stageTiers.get(tierRowsOf(stage));
  if (!found) throw new PolicyError(`${STORE_CONFIG_PATH} "Stage tiers" has no row for the ${tierRowsOf(stage)} stage.`);
  return found;
}

export const tierLabel = (tier: Pick<Tier, 'runtime' | 'model' | 'effort'>): string => `${tier.model}·${tier.effort} on ${tier.runtime}`;

export function limit(policy: LoopPolicy, name: string): Sourced<string> {
  const found = policy.limits.get(name);
  if (!found) throw new PolicyError(`${STORE_CONFIG_PATH} "Loop limits" has no "${name}" row.`);
  return found;
}

export function numericLimit(policy: LoopPolicy, name: string): number {
  const found = limit(policy, name);
  const n = Number(found.value);
  if (!Number.isInteger(n) || n < 1) throw new PolicyError(`"${name}" must be a positive whole number, in ${found.line}`);
  return n;
}

/** Like `numericLimit`, but returns `defaultValue` when the row is absent. */
export function optionalNumericLimit(policy: LoopPolicy, name: string, defaultValue: number): number {
  const found = policy.limits.get(name);
  if (!found) return defaultValue;
  const n = Number(found.value);
  if (!Number.isInteger(n) || n < 1) throw new PolicyError(`"${name}" must be a positive whole number, in ${found.line}`);
  return n;
}

export interface ResolvedStopLine {
  rung: number;
  /** The store-config line that decided it. */
  line: string;
  /** The ticket's `type:` slug, or `untyped`, for grouping evidence by work class. */
  workType: string;
}

/**
 * Resolve how far a ticket's work may go: an effort override first, then the
 * ticket's type, then the default — the precedence the store configuration states.
 */
export function resolveStopLine(policy: LoopPolicy, labels: readonly string[]): ResolvedStopLine {
  const typeLabel = labels.find((l) => l.startsWith('type:'));
  const workType = typeLabel ? typeLabel.slice('type:'.length) : 'untyped';
  for (const label of labels) {
    const override = policy.effortStopLines.get(label);
    if (override) return { rung: override.value, line: override.line, workType };
  }
  const byType = typeLabel ? policy.typeStopLines.get(typeLabel) : undefined;
  if (byType) return { rung: byType.value, line: byType.line, workType };
  return { rung: policy.defaultStopLine.value, line: policy.defaultStopLine.line, workType };
}

/** The review tiers for work written by `author`, in the order the store configuration tries them. */
export function reviewTiersFor(policy: LoopPolicy, author: Family): ReviewTier[] {
  const tiers = policy.reviewLadder.filter((t) => t.author === author);
  if (tiers.length === 0) throw new PolicyError(`${STORE_CONFIG_PATH} "Review ladder" has no rows for ${author}-authored work.`);
  return tiers;
}
