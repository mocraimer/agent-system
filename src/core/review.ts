import type { Outcome } from './outcome.js';

/**
 * Text that arrived from outside the coordinator.
 *
 * Task evidence, PR and review bodies, and vendor results are all written by
 * parties the coordinator does not control. They are data to quote, never
 * instructions to follow, and this type exists so the difference is visible in
 * the type signature rather than remembered.
 */
export interface Untrusted {
  readonly source: string;
  readonly text: string;
}

export function untrusted(source: string, text: string): Untrusted {
  return { source, text };
}

/** A control attempt found inside untrusted text. */
export interface ControlAttempt {
  pattern: string;
  excerpt: string;
}

/**
 * Shapes that try to make the coordinator act rather than read.
 *
 * Detection is for reporting, not for cleaning: the text is still quoted verbatim.
 * The protection is that nothing here is ever executed or parsed as authority —
 * these patterns only make an attempt visible in the record.
 */
const CONTROL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'authority-claim', re: /\b(approved by|grants? (full )?autonomy|authoriz(e|ed) (this|the) (task|run|merge)|apv_[a-z0-9]+|grant_[a-z0-9]+)\b/i },
  { name: 'instruction-override', re: /\b(ignore (all )?(previous|prior|above)|disregard (the )?(instructions|manifest|rules)|you (are|must) now)\b/i },
  { name: 'limit-change', re: /\b(raise|increase|remove|disable|lift)\s+(?:the\s+)?(?:\w+\s+){0,2}(limits?|thresholds?|allowances?|caps?|budgets?|quotas?)\b/i },
  { name: 'forbidden-action', re: /\b(merge (this|the) (pr|pull request)|force[- ]push|deploy to (prod|production))\b/i },
  { name: 'command-injection', re: /(^|\n)\s*(?:\$|>|#)?\s*(rm\s+-rf|curl\s+[^|]*\|\s*(?:ba)?sh|gh\s+pr\s+merge|git\s+push\s+--force)/i },
];

export interface Screened {
  /** The original text, unchanged. Quoting it is allowed and expected. */
  quoted: string;
  source: string;
  attempts: ControlAttempt[];
  /** True when the text tried to control the coordinator or widen authority. */
  suspicious: boolean;
}

/**
 * Screen untrusted text for control attempts, without altering it.
 *
 * Returns the text verbatim: a reviewer's point must reach a human intact, and
 * redacting it would hide the very thing worth seeing. What the screening changes
 * is the record, not the content.
 */
export function screen(input: Untrusted): Screened {
  const attempts: ControlAttempt[] = [];
  for (const { name, re } of CONTROL_PATTERNS) {
    const m = re.exec(input.text);
    if (m) {
      const at = m.index;
      attempts.push({
        pattern: name,
        excerpt: input.text.slice(Math.max(0, at - 40), at + m[0].length + 40).trim(),
      });
    }
  }
  return { quoted: input.text, source: input.source, attempts, suspicious: attempts.length > 0 };
}

/** A finding a reviewer produced. Data about the candidate, not an action on it. */
export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: string;
  description: string;
  /** The reviewer's own words, quoted. */
  quoted: string;
  /** Set when the reviewer's text also tried to control the coordinator. */
  controlAttempts?: ControlAttempt[];
}

export interface ReviewJobSpec {
  taskId: string;
  /** The candidate the reviewer inspects. */
  candidate: { repo: string; base: string; head: string };
  /** Workspace the reviewer may write in. Never the author's checkout. */
  workspace: string;
  /** The author's checkout, which the reviewer must not be given. */
  authorWorkspace: string;
}

export class ReviewIsolationError extends Error {
  override readonly name = 'ReviewIsolationError';
}

/**
 * Check a review job is actually isolated before it starts.
 *
 * A reviewer sharing the author's workspace can change what it is judging, and a
 * finding produced that way says nothing about the candidate that was submitted.
 */
export function assertIsolated(spec: ReviewJobSpec): void {
  if (spec.workspace === spec.authorWorkspace) {
    throw new ReviewIsolationError(
      'The reviewer was given the author workspace. A reviewer that can edit what it judges is not a reviewer.',
    );
  }
  if (spec.workspace.startsWith(`${spec.authorWorkspace}/`)) {
    throw new ReviewIsolationError(
      `The reviewer workspace ${spec.workspace} is inside the author workspace ${spec.authorWorkspace}.`,
    );
  }
}

/** Operations a review job is never permitted to perform. */
export const REVIEW_FORBIDDEN_OPERATIONS = [
  'push', 'commit', 'merge', 'force-push', 'deploy', 'branch-write', 'result-import',
] as const;

export type ReviewOperation = string;

/**
 * Decide whether a review job may perform an operation.
 *
 * `result-import` is on the forbidden list deliberately: a reviewer's output is
 * imported by the coordinator as findings, never applied by the reviewer itself.
 */
export function reviewMayPerform(operation: ReviewOperation): Outcome | undefined {
  if ((REVIEW_FORBIDDEN_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      kind: 'refused',
      summary: `A review job cannot "${operation}".`,
      nextAction:
        'Review output returns as findings. Any change goes back to the author against the same task and PR, and re-triggers the checks.',
    };
  }
  return undefined;
}

export interface RepairHandoff {
  taskId: string;
  prUrl: string;
  findings: ReviewFinding[];
  /** The head the findings were made against. */
  reviewedHead: string;
  /** Checks that must run again once the author changes the candidate. */
  checksToRerun: string[];
}

/**
 * Hand findings back to the author.
 *
 * Same task and same PR, by construction: a repair that opened a second PR would
 * detach the fix from the approval that authorized the work.
 */
export function handBackForRepair(
  spec: ReviewJobSpec,
  prUrl: string,
  findings: ReviewFinding[],
  checksToRerun: string[],
): RepairHandoff {
  return {
    taskId: spec.taskId,
    prUrl,
    findings,
    reviewedHead: spec.candidate.head,
    checksToRerun,
  };
}

/**
 * Whether findings still describe the candidate.
 *
 * Once the author moves the head, the reviewed evidence is about a candidate that
 * no longer exists, so the checks are owed again rather than carried over.
 */
export function findingsStale(handoff: RepairHandoff, currentHead: string): boolean {
  return handoff.reviewedHead !== currentHead;
}
