import { join } from 'node:path';
import type { AuthorityRef, RuntimeId } from '../core/authority.js';
import { isOutstanding } from '../core/outcome.js';
import type { Outcome, OutcomeKind } from '../core/outcome.js';
import type { RunRecord, SettingsSnapshot } from '../core/run.js';
import { getRun, listRuns, saveRun } from '../core/run.js';
import { listRecords, readRecord, stateRoot, withLock, writeJson } from '../core/store.js';

/**
 * The operator's own judgement of a task's result.
 *
 * Kept apart from every measured signal on purpose: a green test run, an agent
 * saying it succeeded, and a person saying the work was good are three different
 * claims, and only the last is this.
 */
export type FeedbackVerdict = 'accepted' | 'rework-needed' | 'rejected';

export interface OperatorFeedback {
  verdict: FeedbackVerdict;
  /** Who said so. An unattributed verdict is not recorded. */
  by: string;
  reason: string;
  at: string;
  /** Set when this supersedes an earlier verdict, which is kept. */
  supersedes?: FeedbackVerdict;
  /** True for suite fixtures, so they can never be counted as real acceptance. */
  isFixture?: boolean;
}

/** What a check reported, kept separate from what a person thought of it. */
export interface CheckResult {
  name: string;
  outcome: 'passed' | 'failed' | 'skipped';
  source: string;
  /** Absent on older records; never inferred from when a report is read. */
  at?: string;
  head?: string;
}

/** New writes require an explicit full commit ID; old stored checks may lack one. */
export type CheckInput = CheckResult & { head: string };

export type ReviewerRelationship = 'author' | 'independent' | 'not-independent';

/** Independence is derived from the relationship, never supplied as a boolean. */
export type Reviewer = { id: string } & (
  | { relationship: 'author' | 'not-independent'; independent: false }
  | { relationship: 'independent'; independent: true }
);

export interface FindingInput {
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
}

export interface ReviewInput {
  /** Stable person/session identities, not merely the model or runtime name. */
  author: string;
  reviewer: { id: string; relationship: ReviewerRelationship };
  /** Review dimension, report path or URL. */
  source: string;
  head: string;
  /** An explicit empty array records a completed review with no findings. */
  findings: FindingInput[];
  /** A reviewer skill may own the detailed findings in GitHub while returning only their count. */
  findingCount?: number;
  at?: string;
}

export interface ReviewEvidence {
  author: string;
  reviewer: Reviewer;
  source: string;
  /** Absent on older records; new writes require an explicit full commit ID. */
  head?: string;
  at: string;
}

export interface ReviewerFinding extends ReviewEvidence, FindingInput {}

/** Kept even when a completed review produced no findings. */
export interface CompletedReview extends ReviewEvidence {
  findingCount: number;
}

export interface RepairCycle {
  at: string;
  trigger: 'review-finding' | 'failed-check';
  detail: string;
  /** Head the repair produced, so the renewed checks are attributable. */
  head?: string;
}

export type RepairInput = Omit<RepairCycle, 'at' | 'head'> & { head: string; at?: string };

/**
 * Usage a run actually consumed.
 *
 * Every field is optional and absence means unknown. Nothing here defaults to
 * zero: a vendor that reports nothing must not look free, and an account delta
 * contaminated by other activity is not a per-run figure.
 */
export interface UsageRecord {
  admissionEstimatePercent?: { fiveHour: number; weekly: number };
  observedAccountDeltaPercent?: { fiveHour: number; weekly: number };
  /** True when other activity on the account could have contributed to the delta. */
  deltaContaminated?: boolean;
  reservationId?: string;
  resetContext?: string;
  paidCallUsd?: number;
  paidCallUnknown?: boolean;
}

/**
 * What the loop knew about a run it dispatched: which stage, which ticket or pull
 * request, and what came of it on GitHub. The trust report is computed from these.
 *
 * Optional: a scorecard for work dispatched by hand has none, and every card
 * written before the loop existed still loads.
 */
export interface LoopRecord {
  stage: string;
  /** `#123` for a ticket, `PR #456` for a pull request. */
  item: string;
  /** The ticket's `type:` slug, or `untyped`; groups evidence by kind of work. */
  workType: string;
  /** The stop-line in force for the item when the run was dispatched. */
  stopLine?: number;
  head?: string;
  /** Review stage: digest of the pull request description the review was given, which with the head says what was reviewed. */
  bodyDigest?: string;
  /** Review stage: the reviewer family differed from the author's. */
  independent?: boolean;
  /** Review stage: findings the review reported. */
  findings?: number;
  /** Fix stage: which review → fix round this was. */
  round?: number;
  /** Fix stage: PR branch and base pinned before dispatch. */
  fixBranch?: string;
  fixBase?: string;
  /** Fix stage: PR description digest before dispatch, never inferred from a later PR. */
  descriptionBeforeDigest?: string;
  /** Fix stage: newest review-marker comment ID at dispatch, if one existed. */
  reviewCommentAtDispatch?: number;
  /** Sweep stage: true only when no PR existed for the ticket at dispatch. */
  sweepNoPullAtDispatch?: boolean;
  /** Sweep stage: base branch recorded at dispatch. */
  sweepBase?: string;
  /** An operator's explicit attestation for this particular run, not a loop write. */
  attestedDelivery?: {
    runId: string;
    kind: 'description' | 'sweep';
    pr: number;
    head: string;
    bodyDigest?: string;
    reviewCommentAtDispatch?: number;
    /** Newest review-marker comment when the operator attested, after the worker finished. */
    reviewCommentAtAttestation?: number;
    round?: number;
    by: string;
    reason: string;
    at: string;
  };
  /** Merge stage: the merge the loop made after this run's readiness check. */
  merged?: { into: string; head: string; at: string };
  /** Sweep stage: the run ended with the ticket escalated. */
  escalated?: boolean;
  /** What the loop wrote to GitHub for this run: a comment, pull request or issue. */
  wrote?: string;
}

export interface Scorecard {
  id: string;
  taskId: string;
  repo: string;
  workClass: string;
  authority: AuthorityRef;
  runtime: RuntimeId;
  profile: string;
  settings: SettingsSnapshot;
  /** Version of the coordinator and prompts that produced this. */
  workflowVersion: string;
  attempts: number;
  runIds: string[];
  manifestPaths: string[];
  candidateHead?: string;
  prUrl?: string;
  checks: CheckResult[];
  reviewerFindings: ReviewerFinding[];
  /** Absent on old cards means no recorded completed review, not a clean review. */
  reviews?: CompletedReview[];
  repairs: RepairCycle[];
  elapsedMs?: number;
  usage: UsageRecord;
  blockers: string[];
  finalStatus: OutcomeKind | 'running';
  /** Absent means unrated. Unrated real work stays unrated. */
  feedback?: OperatorFeedback;
  /** Earlier verdicts, kept when a later one supersedes them. */
  feedbackHistory?: OperatorFeedback[];
  /** Operator attestations for specific attempts, kept when a later retry replaces `loop`. */
  attestedDeliveries?: Array<NonNullable<LoopRecord['attestedDelivery']>>;
  /** Set when the loop dispatched the run. */
  loop?: LoopRecord;
  /** Runs an operator stopped while they were in flight, and who stopped them. */
  stops?: Array<{ runId: string; by: string; at: string }>;
  createdAt: string;
}

const dir = (): string => join(stateRoot(), 'scorecards');

export function listScorecards(): Scorecard[] {
  return listRecords<Scorecard>('scorecard', dir());
}
export function getScorecard(id: string): Scorecard | undefined {
  return readRecord<Scorecard>('scorecard', join(dir(), `${id}.json`));
}
export function saveScorecard(card: Scorecard): void {
  writeJson(join(dir(), `${card.id}.json`), card);
}

/** Build a scorecard from a run and whatever else is known about the task. */
export function scorecardFromRun(
  run: RunRecord,
  extra: Partial<Scorecard> & { repo: string; workClass: string; workflowVersion: string },
): Scorecard {
  return {
    id: `card_${run.taskId}`,
    taskId: run.taskId,
    authority: run.authority,
    runtime: run.runtime,
    profile: run.profile,
    settings: run.settings,
    attempts: run.attempt,
    runIds: [run.id],
    manifestPaths: run.skill?.manifestPath ? [run.skill.manifestPath] : [],
    checks: [],
    reviewerFindings: [],
    repairs: [],
    usage: {},
    blockers: [],
    finalStatus: run.status,
    createdAt: new Date().toISOString(),
    ...(run.candidate?.head ? { candidateHead: run.candidate.head } : {}),
    ...(run.endedAt ? { elapsedMs: Date.parse(run.endedAt) - Date.parse(run.startedAt) } : {}),
    ...extra,
  };
}

/**
 * Keep the reason a run remains unresolved on its scorecard.
 *
 * Quota-waiting and remote-uncertain outcomes are history, not successful runs.
 * Checks-failed is different: the local run has stopped without confirmed success.
 * Its summary says whether checks failed or the result could not be verified;
 * either way it remains visible as a failed attempt rather than a live blocker.
 */
export function blockersFor(outcome: Pick<Outcome, 'kind' | 'summary'>): string[] {
  return isOutstanding(outcome.kind) || outcome.kind === 'quota-waiting'
    ? [outcome.summary]
    : [];
}

export class FeedbackError extends Error {
  override readonly name = 'FeedbackError';
}

/**
 * Record an operator's verdict on a task.
 *
 * A verdict needs an identity and a reason; an unattributed one is refused rather
 * than stored anonymously, because the whole value of this field is that a person
 * stands behind it. Correcting a verdict keeps the earlier one.
 */
export function recordFeedback(
  scorecardId: string,
  feedback: Omit<OperatorFeedback, 'at'> & { at?: string },
): Scorecard {
  return withLock(`scorecard-${scorecardId}`, () => {
    const card = getScorecard(scorecardId);
    if (!card) throw new FeedbackError(`No scorecard "${scorecardId}".`);
    if (!feedback.by || feedback.by.trim() === '') {
      throw new FeedbackError('Feedback needs an identity; an unattributed verdict is not recorded.');
    }
    if (!feedback.reason || feedback.reason.trim() === '') {
      throw new FeedbackError('Feedback needs a reason.');
    }
    const entry: OperatorFeedback = {
      verdict: feedback.verdict,
      by: feedback.by,
      reason: feedback.reason,
      at: feedback.at ?? new Date().toISOString(),
      ...(feedback.isFixture ? { isFixture: true } : {}),
      ...(card.feedback ? { supersedes: card.feedback.verdict } : {}),
    };
    const next: Scorecard = {
      ...card,
      feedback: entry,
      feedbackHistory: [...(card.feedbackHistory ?? []), ...(card.feedback ? [card.feedback] : [])],
    };
    saveScorecard(next);
    return next;
  });
}

export class ScorecardEvidenceError extends Error {
  override readonly name = 'ScorecardEvidenceError';
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScorecardEvidenceError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function commitId(head: unknown): string {
  const value = text(head, 'Evidence head');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw new ScorecardEvidenceError('Evidence head must be a full 40- or 64-character hexadecimal commit ID.');
  }
  return value;
}

function timestamp(at: unknown): string {
  if (at === undefined) return new Date().toISOString();
  const value = text(at, 'at');
  if (!Number.isFinite(Date.parse(value))) throw new ScorecardEvidenceError('at must be a valid timestamp.');
  return new Date(value).toISOString();
}

function appendEvidence(id: string, update: (card: Scorecard) => Scorecard): Scorecard {
  // The id becomes both a filename and a lock name; it must remain a single component.
  if (typeof id !== 'string' || id.trim() === '' || /[/\\\0]/.test(id) || id === '.' || id === '..') {
    throw new ScorecardEvidenceError('Use a scorecard id from the scorecards report, not a path.');
  }
  return withLock(`scorecard-${id}`, () => {
    const card = getScorecard(id);
    if (!card) throw new ScorecardEvidenceError(`No scorecard "${id}". Record a task run first.`);
    const next = update(card);
    saveScorecard(next);
    return next;
  });
}

export function recordCheckResult(id: string, input: CheckInput): Scorecard {
  const name = text(input.name, 'Check name');
  const source = text(input.source, 'Check source');
  if (!['passed', 'failed', 'skipped'].includes(input.outcome)) {
    throw new ScorecardEvidenceError('Check outcome must be passed, failed or skipped.');
  }
  const entry: CheckResult = {
    name, source, outcome: input.outcome, at: timestamp(input.at),
    head: commitId(input.head),
  };
  return appendEvidence(id, (card) => ({ ...card, checks: [...card.checks, entry] }));
}

export function recordReview(id: string, input: ReviewInput): Scorecard {
  const author = text(input.author, 'Author identity');
  const reviewerId = text(input.reviewer?.id, 'Reviewer identity');
  const relationship = input.reviewer.relationship;
  if (!['author', 'independent', 'not-independent'].includes(relationship)) {
    throw new ScorecardEvidenceError('Reviewer relationship must be author, independent or not-independent.');
  }
  const sameIdentity = author.toLowerCase() === reviewerId.toLowerCase();
  if (sameIdentity && relationship === 'independent') {
    throw new ScorecardEvidenceError('The author cannot be an independent reviewer. Use relationship author.');
  }
  if (!sameIdentity && relationship === 'author') {
    throw new ScorecardEvidenceError('An author review must use the author identity as its reviewer.');
  }
  const reviewer: Reviewer = relationship === 'independent'
    ? { id: reviewerId, relationship, independent: true }
    : { id: reviewerId, relationship: sameIdentity ? 'author' : relationship, independent: false };
  const evidence: ReviewEvidence = {
    author, reviewer, source: text(input.source, 'Review source'),
    head: commitId(input.head), at: timestamp(input.at),
  };
  if (!Array.isArray(input.findings)) {
    throw new ScorecardEvidenceError('Review findings must be an array; use [] only for a completed review with no findings.');
  }
  const findings = input.findings.map((finding): ReviewerFinding => {
    if (!finding || !['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      throw new ScorecardEvidenceError('Finding severity must be critical, high, medium or low.');
    }
    return { ...evidence, severity: finding.severity, summary: text(finding.summary, 'Finding summary') };
  });
  const findingCount = input.findingCount ?? findings.length;
  if (!Number.isSafeInteger(findingCount) || findingCount < findings.length) {
    throw new ScorecardEvidenceError('Review findingCount must be a safe non-negative integer no smaller than the detailed findings.');
  }
  return appendEvidence(id, (card) => ({
    ...card,
    reviews: [...(card.reviews ?? []), { ...evidence, findingCount }],
    reviewerFindings: [...card.reviewerFindings, ...findings],
  }));
}

/**
 * Attach or extend the loop's record of a run it dispatched. Merges onto what is
 * already there on purpose: a later write for the same run adds what it learned
 * (the merge a check led to, say) without restating the rest.
 */
export function recordLoop(id: string, record: Partial<LoopRecord> & Pick<LoopRecord, 'stage' | 'item' | 'workType'>): Scorecard {
  return appendEvidence(id, (card) => {
    const loop: LoopRecord = { ...card.loop, ...record };
    const latest = card.runIds.at(-1);
    const run = latest ? getRun(latest) : undefined;
    if (run) {
      const at = new Date().toISOString();
      // Only this attempt can own its observed artifact. A quota preview cannot
      // credit an earlier worker's PR, and interruption never adopts a draft.
      const delivered = run.runtimeDispatched === true && run.status === 'completed' && Boolean(record.wrote);
      saveRun({
        ...run, loop: { ...run.loop, ...record },
        timing: { ...run.timing, adoptionEndedAt: at },
        ...(delivered ? { delivery: { status: 'delivered', reason: 'The loop verified and recorded a task artifact.', evidence: [record.wrote!], verifiedAt: at } as const } : {}),
      });
    }
    return { ...card, loop };
  });
}

export function recordRepairCycle(id: string, input: RepairInput): Scorecard {
  if (!['review-finding', 'failed-check'].includes(input.trigger)) {
    throw new ScorecardEvidenceError('Repair trigger must be review-finding or failed-check.');
  }
  const entry: RepairCycle = {
    at: timestamp(input.at), trigger: input.trigger, detail: text(input.detail, 'Repair detail'),
    head: commitId(input.head),
  };
  return appendEvidence(id, (card) => ({ ...card, repairs: [...card.repairs, entry] }));
}

export interface ScorecardEvidenceReport {
  scorecardId: string;
  taskId: string;
  checkStatus: 'not-recorded' | 'recorded';
  reviewStatus: 'not-reviewed' | 'reviewed';
  independentReviewStatus: 'not-reviewed' | 'reviewed';
  checks: CheckResult[];
  reviews: CompletedReview[];
  reviewerFindings: ReviewerFinding[];
  repairs: RepairCycle[];
}

/** Historical evidence, never a verdict about acceptance of the current head. */
function evidenceReport(card: Scorecard): ScorecardEvidenceReport {
  const reviews = card.reviews ?? [];
  return {
    scorecardId: card.id, taskId: card.taskId,
    checkStatus: card.checks.length === 0 ? 'not-recorded' : 'recorded',
    reviewStatus: reviews.length === 0 ? 'not-reviewed' : 'reviewed',
    independentReviewStatus: reviews.some((review) =>
      review.reviewer.relationship === 'independent' && review.reviewer.independent &&
      review.author.trim().toLowerCase() !== review.reviewer.id.trim().toLowerCase()) ? 'reviewed' : 'not-reviewed',
    checks: card.checks, reviews, reviewerFindings: card.reviewerFindings, repairs: card.repairs,
  };
}

export interface GroupKey {
  repo?: string;
  workClass?: string;
  authorityId?: string;
  runtime?: RuntimeId;
  effectiveConfiguration?: string;
  workflowVersion?: string;
}

export interface GroupReport {
  key: GroupKey;
  /** How many scorecards this summarises. Always shown; a count of 3 is not a rate. */
  sampleCount: number;
  byStatus: Record<string, number>;
  unresolved: number;
  failedAttempts: number;
  /** Real operator verdicts only — fixture feedback is excluded from these counts. */
  operatorVerdicts: Record<FeedbackVerdict, number>;
  unrated: number;
  /** Per-task history for the same filtered population as the counts above. */
  evidence: ScorecardEvidenceReport[];
  /** Stated in words so a small sample cannot be read as a reliability figure. */
  caveat: string;
  /** All recorded attempts, not only a task's final retry. Missing provenance stays missing. */
  recordedAttempts: RunRecord[];
  attemptCounts: { recorded: number; dispatched: number; dispatchUnknown: number; delivered: number; byStatus: Record<string, number> };
}

/**
 * Summarise comparable work.
 *
 * Deliberately reports counts and never a success rate. The contract's own warning
 * is that a handful of heterogeneous tasks must not become a general reliability
 * claim, and a percentage is exactly the shape that invites that reading.
 */
export function groupReport(cards: Scorecard[], key: GroupKey): GroupReport {
  const matching = cards.filter((c) =>
    (key.repo === undefined || c.repo === key.repo) &&
    (key.workClass === undefined || c.workClass === key.workClass) &&
    (key.authorityId === undefined || c.authority.id === key.authorityId) &&
    (key.runtime === undefined || c.runtime === key.runtime) &&
    (key.workflowVersion === undefined || c.workflowVersion === key.workflowVersion) &&
    (key.effectiveConfiguration === undefined ||
      `${c.settings.observed.model}/${c.settings.observed.effort}` === key.effectiveConfiguration));

  const byStatus: Record<string, number> = {};
  const verdicts: Record<FeedbackVerdict, number> = { accepted: 0, 'rework-needed': 0, rejected: 0 };
  let unresolved = 0;
  let failedAttempts = 0;
  let unrated = 0;

  for (const c of matching) {
    byStatus[c.finalStatus] = (byStatus[c.finalStatus] ?? 0) + 1;
    if (c.finalStatus === 'running' || c.blockers.length > 0) unresolved++;
    failedAttempts += c.checks.filter((x) => x.outcome === 'failed').length;
    // Fixture feedback exists to exercise the mechanism; counting it would let the
    // suite manufacture operator acceptance nobody gave.
    if (c.feedback && !c.feedback.isFixture) verdicts[c.feedback.verdict]++;
    else unrated++;
  }

  const recordedAttempts = listRuns().filter((run) => {
    const card = cards.find((c) => c.runIds.includes(run.id));
    // A retry can update the task card's workflow version. An attempt's own build
    // wins; a legacy card label is only a cohort label, not proof of its build.
    // A digest-shaped card may belong to a later retry, so leave a legacy
    // attempt without build identity in the unknown cohort instead.
    const legacyCohort = (run.build === undefined || run.build === null) && card?.workflowVersion &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(card.workflowVersion)
      ? card.workflowVersion : 'unversioned';
    const attemptVersion = run.build?.digest ?? legacyCohort;
    return (key.repo === undefined || (run.repo ?? card?.repo) === key.repo) &&
      (key.workClass === undefined || (run.workClass ?? card?.workClass) === key.workClass) &&
      (key.runtime === undefined || run.runtime === key.runtime) &&
      (key.authorityId === undefined || run.authority.id === key.authorityId) &&
      (key.workflowVersion === undefined || attemptVersion === key.workflowVersion) &&
      (key.effectiveConfiguration === undefined || `${run.settings.observed.model}/${run.settings.observed.effort}` === key.effectiveConfiguration);
  });
  const attemptStatuses: Record<string, number> = {};
  for (const run of recordedAttempts) attemptStatuses[run.status] = (attemptStatuses[run.status] ?? 0) + 1;
  return {
    key,
    recordedAttempts,
    attemptCounts: {
      recorded: recordedAttempts.length,
      dispatched: recordedAttempts.filter((run) => run.runtimeDispatched === true).length,
      dispatchUnknown: recordedAttempts.filter((run) => run.runtimeDispatched === undefined).length,
      delivered: recordedAttempts.filter((run) => run.delivery?.status === 'delivered').length,
      byStatus: attemptStatuses,
    },
    sampleCount: matching.length,
    byStatus,
    unresolved,
    failedAttempts,
    operatorVerdicts: verdicts,
    unrated,
    evidence: matching.map(evidenceReport),
    caveat:
      `${matching.length} sample(s). These are raw counts of individual tasks, not a success rate ` +
      'or a reliability estimate, and the tasks in a group are not necessarily comparable in difficulty. ' +
      'Recorded checks and reviews are history for their stated scope, not acceptance of the current head.',
  };
}
