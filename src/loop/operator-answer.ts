import { createHash } from 'node:crypto';
import { LOOP_SIGNATURE, newestDeclinedKey, renderDeclinedMarker } from './markers.js';
import { pullRefNumber } from './labels.js';
import type { Item, PassContext, StagePlan } from './types.js';

/**
 * What the operator is owed on the pull request for a label the loop did not carry out.
 *
 * A reason in the pass log reaches nobody who labelled a pull request and went back to it,
 * so each answer is a loop comment on that pull request. It is written once per situation:
 * the key names the comment the label pointed at and the reason, and the newest answer for
 * the label is the only one compared, so a pass every fifteen minutes does not repeat it.
 */
type Outcome = { kind: 'declined' | 'blocked' | 'failed'; reason: string };

/** What a stage did with an item that asked for something, or undefined where it answered by acting. */
function outcomeOf(item: Item): Outcome | undefined {
  const { decision, result } = item;
  if (decision.kind === 'skip') return { kind: 'declined', reason: decision.reason };
  if (decision.kind === 'blocked') return { kind: 'blocked', reason: decision.reason };
  if (result && !result.produced) return { kind: result.blocked ? 'blocked' : 'failed', reason: result.summary };
  return undefined;
}

const sentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}`;

export const answerKey = (...parts: Array<string | number | undefined>): string =>
  createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\n')).digest('hex').slice(0, 12);

/**
 * Post one loop comment saying what became of an operator label, unless the newest answer
 * already given for that label is this one. Returns whether it posted.
 */
export async function answerOnce(
  ctx: PassContext, number: number, label: string, key: string, text: string,
): Promise<boolean> {
  // Read now, not from the pass's cache: a fix run may have written to this pull request since.
  const comments = await ctx.store.comments(number);
  if (newestDeclinedKey(comments, label) === key) return false;
  await ctx.store.createComment(number, [
    text,
    '',
    renderDeclinedMarker({ label, key }),
    `— ${LOOP_SIGNATURE} in pass ${ctx.passId}`,
  ].join('\n'));
  ctx.forget(number);
  return true;
}

/**
 * Answer every item of a stage that asked for something and was not carried out.
 *
 * Runs after the stage's items have acted, in a real pass only. A failure to write costs the
 * answer for this pass and no more: it is logged, and the next pass tries again.
 */
export async function answerAsks(ctx: PassContext, plan: StagePlan): Promise<void> {
  for (const item of plan.items) {
    const number = pullRefNumber(item.ref);
    if (!item.ask || number === undefined) continue;
    const outcome = outcomeOf(item);
    if (!outcome) continue;
    const { label } = item.ask;
    // A blocked or failed run's reason carries quota windows and run ids that change every pass.
    const key = answerKey(item.ask.comment, outcome.kind === 'declined' ? outcome.reason : outcome.kind);
    const lead = {
      declined: `The loop did not carry out your \`${label}\` label.`,
      blocked: `The loop could not carry out your \`${label}\` label yet.`,
      failed: `The loop tried to carry out your \`${label}\` label and did not finish.`,
    }[outcome.kind];
    const fate = item.ask.final
      ? `The \`${label}\` label has been taken back; nothing here will change what the loop does with it.`
      : item.ask.comment === undefined
        ? `The \`${label}\` label is still on. Remove it if you no longer want it.`
        : `The \`${label}\` label is still on. The loop looks at this pull request every pass and carries your comment out once this changes. Remove the label to withdraw it.`;
    try {
      if (await answerOnce(ctx, number, label, key, `${lead}\n\n${sentence(outcome.reason)}\n\n${fate}`)) {
        ctx.log(`answered: PR #${number} told why its ${label} label was not carried out (${outcome.kind})`);
      }
    } catch (err) {
      ctx.log(`answer: PR #${number} ${label} not answered this pass: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!item.ask.final) continue;
    try {
      await ctx.store.removeLabel(number, label);
    } catch (err) {
      ctx.log(`answer: PR #${number} ${label} not taken back this pass: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
