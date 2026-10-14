import type { AuthorityDecision, DispatchRequest, RuntimeId } from '../core/authority.js';
import type { Outcome } from '../core/outcome.js';
import type { UsageEstimate, WindowVerdict } from '../core/admission.js';
import type { DispatchCommandResult, DispatchTaskInput } from '../commands.js';
import type { LoopRecord, RepairInput, ReviewInput } from '../eval/scorecard.js';
import type { Repo } from './git.js';
import type { Comment, Issue, PullCommit, PullRequest, Store } from './github.js';
import type { StatusLabel } from './labels.js';
import type { LoopPolicy, ResolvedStopLine, Rung } from './policy.js';
import type { QueueRules } from './queues.js';

/** The stages of a pass, in order, each named for the rung it moves work to. */
export const STAGES = [
  { name: 'shape', rung: 'proposal' },
  { name: 'assess', rung: 'granted' },
  { name: 'sweep', rung: 'pr-open' },
  { name: 'review', rung: 'reviewed' },
  { name: 'fix', rung: 'clean' },
  { name: 'merge', rung: 'dev' },
  { name: 'close', rung: 'dev' },
  { name: 'release', rung: 'release' },
  { name: 'verify', rung: 'verified' },
] as const;

export type StageName = typeof STAGES[number]['name'];

/** A stage a pass can run: one of the ladder's, or the improve stage, which moves no work up a rung. */
export type PassStage = StageName | 'improve';

export type Decision =
  | { kind: 'dispatch'; detail: string }
  /**
   * `owner` is set where the skip settles who moves next — the loop having
   * exhausted what it may do here, or a pull request it never acts on. A skip
   * meaning only "this stage had nothing to do" leaves it unset, because a
   * later stage may still act on the same item.
   */
  | { kind: 'skip'; reason: string; owner?: StatusLabel }
  | { kind: 'blocked'; reason: string };

export type FaultKind = 'breach' | 'stalled' | 'error';

export interface Fault {
  /** `setup` when the pass failed before any stage could run. */
  stage: PassStage | 'setup';
  kind: FaultKind;
  /** What the fault is about: `PR #679`, `#655`, or the stage itself. */
  subject: string;
  /** One line: what is wrong. */
  detail: string;
  /** The evidence a person needs to check it. */
  evidence: string;
}

export interface ActResult {
  produced: boolean;
  summary: string;
  /** Set when the item could not be acted on after all, with why. */
  blocked?: string;
  faults?: Fault[];
}

/** The head and description a review was given. */
export interface ReviewedState {
  head: string;
  bodyDigest?: string;
}

/**
 * An operator label this item answers. The planner states it and a real pass owes the operator
 * an answer on the pull request itself, since a reason kept in the pass log is one they never see.
 */
export interface OperatorAsk {
  label: string;
  /** The comment of theirs the label points at, where one was waiting. */
  comment?: number;
  /** Set where the reason cannot change, so the label is taken back with the answer rather than left standing. */
  final?: boolean;
}

export interface Item {
  /** `#123` or `PR #456`. */
  ref: string;
  /** Present when the pull request carries an operator label this item is the loop's answer to. */
  ask?: OperatorAsk;
  stopLine?: ResolvedStopLine;
  decision: Decision;
  /** Present on dispatch decisions; a dry run never calls it. */
  act?: () => Promise<ActResult>;
  result?: ActResult;
}

export interface StagePlan {
  stage: PassStage;
  /** The rung the stage moves work to; the improve stage has none. */
  rung?: Rung;
  items: Item[];
  notes: string[];
  faults: Fault[];
}

/** The coordinator paths a pass uses, injectable so a test drives them with fakes. */
export interface LoopCommands {
  dispatch(input: DispatchTaskInput): Promise<DispatchCommandResult>;
  authorize(req: DispatchRequest): AuthorityDecision;
  readiness(runtime: RuntimeId, entry?: 'skill' | 'review-pr' | 'prompt'): Promise<Outcome | undefined>;
  /**
   * Whether admission would let this run through now, without reserving anything,
   * with the window verdicts it decided on when it read usage at all.
   */
  admissionPreview(runtime: RuntimeId, taskId: string, estimate: UsageEstimate): Promise<{ admitted: boolean; reason?: string; windows?: WindowVerdict[] }>;
  /** Settle runs whose process ended while the coordinator was not watching. */
  recover(): Promise<void>;
  /** A run of this task is still recorded as running. */
  inFlight(taskId: string): boolean;
  /**
   * Whether the loop itself posted this comment, by its own scorecard records
   * rather than by anything in the comment's text, which anyone can type.
   */
  wroteComment(commentId: number): boolean;
  /**
   * What the loop has run a review of on this pull request, oldest first: each head and
   * description pair once, whether a commit or a description edit started the review.
   * Read from the run store rather than from the comments, so a review whose result
   * went unrecorded because the head moved under it still counts. A run from before the
   * description was recorded has none.
   */
  reviewsRun(repo: string, pr: number): ReviewedState[];
  /** A completed fix attested by the operator, requiring a newer review at the same head. */
  attestedDescription(repo: string, pr: number, head: string): { reviewCommentAtAttestation?: number; round?: number; bodyDigest?: string } | undefined;
  recordLoop(taskId: string, record: Partial<LoopRecord> & Pick<LoopRecord, 'stage' | 'item' | 'workType'>): void;
  recordReview(taskId: string, input: ReviewInput): void;
  recordRepair(taskId: string, input: RepairInput): void;
  /** Run a verification command; never a model. */
  exec(command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface PassOptions {
  dryRun: boolean;
  /** Read policy and queue rules here instead of the base branch, to try a policy change before it lands. */
  policyRef?: string;
  /** Run only these stages. */
  stages?: PassStage[];
  /** A release pull request the operator names for the verify stage, bypassing the stop-line gate. */
  releasePr?: number;
  /** An operator-prepared worktree of the deployed commit, holding the env files `deployed` release checks need. */
  e2eWorktree?: string;
}

/** Everything a stage reads, fetched once per pass. */
export interface PassContext {
  passId: string;
  startedAt: Date;
  options: PassOptions;
  slug: string;
  base: string;
  baseSha: string;
  policyRef: string;
  policy: LoopPolicy;
  rules: QueueRules;
  repo: Repo;
  store: Store;
  commands: LoopCommands;
  /** Open tickets the loop may work: its own fault issues and tickets whose work has merged are set aside. */
  issues: Issue[];
  /** Open tickets whose work has merged into the base branch, with the pull request that merged it. */
  merged: Array<{ issue: Issue; pr: PullRequest }>;
  pulls: PullRequest[];
  triggerSource: string;
  stateDir: string;
  /** Memoised reads, so two stages asking about the same item cost one call. */
  comments(number: number): Promise<Comment[]>;
  commits(number: number): Promise<PullCommit[]>;
  issue(number: number): Promise<Issue | undefined>;
  /** Drop what is cached about an item after the pass wrote to it. */
  forget(number: number): void;
  log(line: string): void;
}
