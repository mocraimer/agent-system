import type { PullRequest, Store } from './github.js';
import type { Decision, StagePlan } from './types.js';

/**
 * Labels in this namespace are the loop's own writing.
 *
 * Everywhere else in this store, a label is a person's act — `shaped` accepts a
 * proposal, `auto` grants one, and the loop applies neither. Every loop comment
 * posts under the operator's own GitHub login, so a label is the last signal
 * that separates what a person decided from what the machine did. Reserving one
 * namespace for the loop is what keeps that signal readable: inside it the loop
 * writes and a person does not, outside it a person writes and the loop does not.
 */
export const LOOP_NAMESPACE = 'loop:';

export const STATUS_WORKING = 'loop:working';
export const STATUS_BLOCKED = 'loop:blocked';
export const STATUS_STOPPED = 'loop:stopped';
export const STATUS_SKIPPED = 'loop:skipped';

/** In precedence order: the first one a pull request earns is the one it carries. */
export const STATUS_LABELS = [STATUS_WORKING, STATUS_BLOCKED, STATUS_STOPPED, STATUS_SKIPPED] as const;

export type StatusLabel = typeof STATUS_LABELS[number];

/**
 * How each status label looks when the loop has to make it.
 *
 * A repository that has never carried these has none of them, and a label the
 * loop owns is one it can create rather than wait for a person to prepare.
 */
const STATUS_LABEL_DEFINITIONS: Record<StatusLabel, { color: string; description: string }> = {
  [STATUS_WORKING]: { color: '1D76DB', description: 'The loop is moving this pull request: dispatched or queued this pass' },
  [STATUS_BLOCKED]: { color: 'D93F0B', description: 'The loop wants to act and was refused: quota, concurrency, or no reachable tier' },
  [STATUS_STOPPED]: { color: 'FBCA04', description: 'The loop will not advance this further without a person' },
  [STATUS_SKIPPED]: { color: 'CFD3D7', description: 'The loop does not act on this pull request at all' },
};

export function statusLabelDefinition(label: string): { color: string; description: string } {
  assertApplicable(label);
  return STATUS_LABEL_DEFINITIONS[label as StatusLabel];
}

/**
 * Labels a person applies and the loop only ever reads.
 *
 * Listed here so one file holds the whole vocabulary; nothing in the loop may
 * pass these to a label write.
 */
export const HUMAN_LABEL = 'HUMAN';
export const ACCEPT_FINDINGS_LABEL = 'accept-findings';
export const APPLY_COMMENT_LABEL = 'apply-comment';
export const REVIEW_AGAIN_LABEL = 'review-again';

/** The operator labels the loop consumes and clears once it has acted on them. */
export const ONE_SHOT_LABELS = [ACCEPT_FINDINGS_LABEL, APPLY_COMMENT_LABEL, REVIEW_AGAIN_LABEL] as const;

/**
 * Refuse applying any label the loop does not own.
 *
 * Called by the store's own label method rather than by its callers, so no path
 * through the loop can apply a label a person owns. `shaped` and `auto` are the
 * ones this most protects: applying either is how a person grants work.
 */
export function assertApplicable(label: string): void {
  if (!(STATUS_LABELS as readonly string[]).includes(label)) {
    throw new Error(
      `The loop may only apply its own labels (${STATUS_LABELS.join(', ')}); `
      + `"${label}" is a person's to apply.`,
    );
  }
}

/**
 * Refuse removing any label the loop neither owns nor was handed.
 *
 * Wider than what it may apply, by one case: an operator label naming a single
 * action is consumed when the loop takes that action, which is what keeps it a
 * one-shot instruction rather than a standing grant. Removing it is finishing
 * what the operator asked for; every other label of theirs stays untouched.
 */
export function assertRemovable(label: string): void {
  if ((STATUS_LABELS as readonly string[]).includes(label)) return;
  if ((ONE_SHOT_LABELS as readonly string[]).includes(label)) return;
  throw new Error(
    `The loop may only remove its own labels (${STATUS_LABELS.join(', ')}) `
    + `or an operator instruction it has carried out (${ONE_SHOT_LABELS.join(', ')}); `
    + `"${label}" is a person's to remove.`,
  );
}

/** `PR #123` → 123; anything else, including a bare ticket ref, → undefined. */
export function pullRefNumber(ref: string): number | undefined {
  const m = /^PR #(\d+)$/.exec(ref);
  return m ? Number(m[1]) : undefined;
}

/**
 * The status one stage decision implies, or undefined where it implies none.
 *
 * A skip carries its own `owner` where the stage that wrote it knows the skip
 * settles who moves next. A skip without one — "reviewed at head", "one ticket
 * per pass" — says only that this stage had nothing to do, which the next stage
 * may contradict.
 */
export function statusOf(decision: Decision): StatusLabel | undefined {
  if (decision.kind === 'dispatch') return STATUS_WORKING;
  if (decision.kind === 'blocked') return STATUS_BLOCKED;
  return decision.owner;
}

/**
 * The one status label a pull request carries, across every stage that saw it.
 *
 * A pull request appears in several stage plans at once — #710 is a dispatch in
 * both review and fix, while #679 is an uninformative skip in review and a
 * "no progress" skip in fix — so a label read off a single stage would
 * contradict another stage's view of the same pull request.
 */
export function statusByPull(plans: readonly StagePlan[]): Map<number, StatusLabel> {
  const best = new Map<number, StatusLabel>();
  for (const plan of plans) {
    for (const item of plan.items) {
      const number = pullRefNumber(item.ref);
      if (number === undefined) continue;
      const status = statusOf(item.decision);
      if (!status) continue;
      const held = best.get(number);
      if (held === undefined || rank(status) < rank(held)) best.set(number, status);
    }
  }
  return best;
}

const rank = (label: StatusLabel): number => STATUS_LABELS.indexOf(label);

/**
 * Put each open pull request's status label where the pass's own plans say it is.
 *
 * Only ever called for a pass that planned every stage. A pass restricted to some
 * of them sees part of each pull request's situation, and a label written from
 * that would state the part as the whole.
 *
 * A pull request no stage had an opinion about is the operator's: nothing in the
 * loop is going to move it.
 */
export async function syncStatusLabels(
  store: Pick<Store, 'addLabel' | 'removeLabel'>,
  pulls: readonly PullRequest[],
  base: string,
  plans: readonly StagePlan[],
): Promise<string[]> {
  const derived = statusByPull(plans);
  const lines: string[] = [];
  for (const pr of pulls) {
    if (pr.baseRefName !== base) continue;
    const want = derived.get(pr.number) ?? STATUS_STOPPED;
    const held = (pr.labels ?? []).filter((l): l is StatusLabel => (STATUS_LABELS as readonly string[]).includes(l));
    if (held.length === 1 && held[0] === want) continue;
    for (const stale of held) {
      if (stale === want) continue;
      await store.removeLabel(pr.number, stale);
    }
    if (!held.includes(want)) await store.addLabel(pr.number, want);
    lines.push(`labels: PR #${pr.number} ${held.length ? held.join(',') : 'none'} → ${want}`);
  }
  return lines;
}
