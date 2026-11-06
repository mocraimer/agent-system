import { createHash } from 'node:crypto';
import type { PullRequest, Store } from './github.js';
import { situationsByPull, STATUS_BLOCKED, STATUS_SKIPPED, STATUS_STOPPED, STATUS_WORKING } from './labels.js';
import type { Situation } from './labels.js';
import { LOOP_SIGNATURE, parsePrStatus, writtenByLoop, renderPrStatusChange, renderPrStatusState } from './markers.js';
import type { PrStatusChange } from './markers.js';
import type { StagePlan } from './types.js';

/**
 * One editable comment per pull request that says why the loop has it in the state its label shows.
 *
 * A label says where a pull request is, not why, and the reason otherwise lives only in the operator's
 * pass log. The comment is written when a pull request first needs a person or is refused, then edited
 * in place, so the timeline never fills with one comment per transition. It changes when the label, the
 * stage or the kind of reason changes, and never for a number that merely moved.
 */

const RECENT = 5;

interface Cause { cause: string; why: string; next: string }

/** Digits and whitespace out, so a percentage or a count that moved does not read as a new situation. */
const normal = (text: string): string => text.replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
const trim = (text: string, n = 160): string => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/** The short form of each kind of reason, as the change history names it. */
const SHORT: Record<string, string> = {
  'working': 'the loop is working on it',
  'no-independent-tier': 'no independent reviewer reachable',
  'no-tier': 'no model tier has room',
  'no-authority': 'no authority for the action',
  'release-check': 'release check failed or unclear',
  'review-limit': 'review limit reached',
  'stale-review': 'review is for an older description',
  'stop-line': 'stop-line ends before this stage',
  'no-progress': 'a fix round made no progress',
  'round-cap': 'fix rounds used up',
  'no-opinion': 'no stage spoke for it',
};
const shortOf = (cause: string): string => SHORT[cause] ?? (cause.startsWith('skipped-') ? 'the loop does not act on it' : 'another reason');

/** The kind of reason, in plain words, for the situations the stages actually produce. */
export function causeOf(s: Situation): Cause {
  const { label, stage, reason } = s;
  const wait = 'The loop tries again on a later pass. Nothing is needed from you.';
  if (label === STATUS_WORKING) return { cause: 'working', why: 'The loop is moving this pull request.', next: 'Nothing is needed from you.' };
  if (label === STATUS_SKIPPED) {
    return { cause: `skipped-${stage}`, why: `The loop does not act on this pull request: ${trim(reason)}`, next: 'Nothing is needed from you unless you want the loop to take it up.' };
  }
  if (/not independent; no independent tier reachable/.test(reason)) {
    return { cause: 'no-independent-tier', why: 'The review exists, but only a reviewer of the author\'s own model family could run, so it does not count toward a merge.', next: wait };
  }
  if (/no authority (on|for)|not ready:/.test(reason)) {
    return { cause: 'no-authority', why: `The loop has no authority, or the runtime is not ready, for what the ${stage} stage wants to do.`, next: 'Needs you: issue the grant or approval that covers it, fix the runtime\'s setup, or do the step yourself.' };
  }
  if (label === STATUS_BLOCKED && /tier unavailable|no reachable tier|no tier produced|admission/i.test(reason)) {
    return { cause: 'no-tier', why: `The ${stage} stage wanted to act, and no model tier could start (quota, concurrency or no reachable tier).`, next: `${wait} If it lasts past the quota reset, check the subscription windows.` };
  }
  if (label === STATUS_BLOCKED && (stage === 'verify' || stage === 'release')) {
    return { cause: 'release-check', why: 'The release deployment or its post-deploy checks failed, or their state is unclear.', next: 'Needs you: inspect the failed deployment or the verification comment, then resolve it.' };
  }
  if (/^review limit reached/.test(reason)) {
    return { cause: 'review-limit', why: 'The loop has reviewed this pull request, which it did not open, up to its review limit.', next: 'Needs you: add the `review-again` label to allow more reviews, or review it yourself.' };
  }
  if (/does not cover the current PR description/.test(reason)) {
    return { cause: 'stale-review', why: 'The latest review was written for an older description of this pull request.', next: 'The loop re-reviews on its next pass. If this repeats over several passes, look at the latest review comment.' };
  }
  if (/^stop-line \d+ (below|<)/.test(reason)) {
    return { cause: 'stop-line', why: `This ticket type's stop-line ends before the ${stage} stage.`, next: 'Needs you: take this step yourself, or raise the stop-line in `tickets/store-config.md`.' };
  }
  if (/^no progress/.test(reason)) {
    return { cause: 'no-progress', why: 'A fix round did not move the findings.', next: 'Needs you: read the review and decide. The loop will not try again by itself.' };
  }
  if (/^round cap/.test(reason)) {
    return { cause: 'round-cap', why: 'The loop used all its fix rounds on this pull request.', next: 'Needs you: read the review and decide. The loop will not try again by itself.' };
  }
  const key = createHash('sha256').update(`${stage}\n${normal(reason)}`).digest('hex').slice(0, 10);
  return label === STATUS_BLOCKED
    ? { cause: `blocked-${key}`, why: `The ${stage} stage wanted to act and could not.`, next: `Needs you: see the reason — ${trim(reason)}` }
    : { cause: `stopped-${key}`, why: `The ${stage} stage left this pull request for a person.`, next: `Needs you: see the reason — ${trim(reason)}` };
}

const NO_OPINION: Cause = { cause: 'no-opinion', why: 'No stage had a plan for this pull request, so it waits for a person.', next: 'Needs you: nothing the loop does will move it.' };

const ICON: Record<string, string> = { [STATUS_BLOCKED]: '🔴', [STATUS_STOPPED]: '🟡', [STATUS_WORKING]: '🔵', [STATUS_SKIPPED]: '⚪' };
const WORD: Record<string, string> = { [STATUS_BLOCKED]: 'blocked', [STATUS_STOPPED]: 'stopped, needs a person', [STATUS_WORKING]: 'working', [STATUS_SKIPPED]: 'skipped' };
const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC';
const name = (label: string): string => label.replace(/^loop:/, '');

export interface StatusView { label: string; stage: string; cause: Cause; since: string; changes: PrStatusChange[] }

export function renderStatusComment(v: StatusView, passId: string): string {
  const shown = v.changes.slice(-RECENT).reverse();
  return [
    `**Loop status: ${ICON[v.label] ?? ''} ${WORD[v.label] ?? name(v.label)}** (since ${when(v.since)})`,
    '',
    `**Why:** ${v.cause.why}`,
    `**Next:** ${v.cause.next}`,
    '',
    '<details>',
    '<summary>Last changes</summary>',
    '',
    ...shown.map((c) => `- ${when(c.at)}: ${c.from === 'none' ? 'first seen' : name(c.from)} → ${name(c.to)}${c.stage === 'none' ? '' : ` (${c.stage}: ${shortOf(c.cause)})`}`),
    '',
    '</details>',
    '',
    renderPrStatusState({ label: v.label, stage: v.stage, cause: v.cause.cause, since: v.since }),
    ...v.changes.slice(-RECENT).map(renderPrStatusChange),
    `— ${LOOP_SIGNATURE} in pass ${passId}`,
    '',
  ].join('\n');
}

/**
 * Write or edit each open pull request's status comment from what the pass's plans say.
 *
 * Called only for a pass that planned every stage, like the label sync. A pull request gets a comment
 * when it first needs a person or is refused, and no stage speaking for it is not a reason to write one.
 * One pull request failing does not stop the others, and the next pass tries again.
 */
export async function syncStatusComments(
  store: Pick<Store, 'comments' | 'createComment' | 'updateComment'>,
  pulls: readonly PullRequest[],
  base: string,
  plans: readonly StagePlan[],
  at: Date,
  passId: string,
): Promise<string[]> {
  const found = situationsByPull(plans);
  const now = at.toISOString();
  const lines: string[] = [];
  for (const pr of pulls) {
    if (pr.baseRefName !== base) continue;
    const sit = found.get(pr.number);
    const label = sit?.label ?? STATUS_STOPPED;
    const stage = sit?.stage ?? 'none';
    const cause = sit ? causeOf(sit) : NO_OPINION;
    try {
      const comments = await store.comments(pr.number);
      const existing = comments.filter((c) => writtenByLoop(c.body) && parsePrStatus(c.body)).at(-1);
      const held = existing ? parsePrStatus(existing.body) : undefined;
      if (!held) {
        if (!sit || (label !== STATUS_BLOCKED && label !== STATUS_STOPPED)) continue;
        const change = { at: now, from: 'none', to: label, stage, cause: cause.cause };
        await store.createComment(pr.number, renderStatusComment({ label, stage, cause, since: now, changes: [change] }, passId));
        lines.push(`status comment: PR #${pr.number} written (${label}, ${cause.cause})`);
        continue;
      }
      const { state, changes } = held;
      if (state.label === label && state.stage === stage && state.cause === cause.cause) continue;
      const change = { at: now, from: state.label, to: label, stage, cause: cause.cause };
      await store.updateComment(existing!.id, renderStatusComment({ label, stage, cause, since: now, changes: [...changes, change].slice(-RECENT) }, passId));
      lines.push(`status comment: PR #${pr.number} updated (${state.label} → ${label}, ${cause.cause})`);
    } catch (err) {
      lines.push(`status comment: PR #${pr.number} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines;
}
