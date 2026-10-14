import { HUMAN_LABEL } from '../context.js';
import { CLOSE_WARNING_MARKER, DONE_MARKER, writtenByLoop } from '../markers.js';
import { limit, optionalNumericLimit, resolveStopLine, rung } from '../policy.js';
import type { Item, PassContext, StagePlan } from '../types.js';

/**
 * Close a ticket whose work has merged, when the code was the whole job.
 *
 * GitHub closes an issue from a pull request only on a merge into the default
 * branch; work here merges into the base branch, so without this step every
 * ticket stays open after its merge and drifts back into the queues. Which
 * merged tickets close is the store configuration's rule: those carrying the
 * label its Loop limits row names. Any other merged ticket may need more than the
 * code, so it gets one warning and closes after a grace period unless a person
 * replies or labels it HUMAN; until then it is out of every work queue and listed
 * on the status comment. No model runs here.
 */
export async function planClose(ctx: PassContext): Promise<StagePlan> {
  const plan: StagePlan = { stage: 'close', rung: rung(ctx.policy, 'dev'), items: [], notes: [], faults: [] };
  const closeLabel = limit(ctx.policy, 'close merged tickets labelled');

  for (const { issue, pr } of [...ctx.merged].sort((a, b) => a.issue.number - b.issue.number)) {
    const ref = `#${issue.number}`;
    const stopLine = resolveStopLine(ctx.policy, issue.labels);
    const merged = `merged via PR #${pr.number}${pr.mergedAt ? ` on ${pr.mergedAt.slice(0, 10)}` : ''}`;
    const skip = (reason: string): void => { plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason } }); };

    if (issue.assignees.length > 0) { skip(`${merged}; human assignee (${issue.assignees.join(', ')}) — left to them`); continue; }
    if (issue.labels.includes(HUMAN_LABEL)) { skip(`${merged}; HUMAN label — left for the operator`); continue; }
    if (!issue.labels.includes(closeLabel.value)) {
      // No auto label. Post a one-time grace-close warning, then close after the grace period
      // unless a human responds. Tickets with a human assignee or HUMAN label are already
      // handled above; this path handles the remaining merged-but-not-auto tickets.
      const graceDays = optionalNumericLimit(ctx.policy, 'close other merged tickets after days', 3);
      const comments = await ctx.comments(issue.number);
      const warningIdx = comments.findIndex((c) => c.body.includes(CLOSE_WARNING_MARKER));

      if (warningIdx === -1) {
        // No warning yet — post one.
        const item: Item = {
          ref, stopLine,
          decision: { kind: 'dispatch', detail: `${merged}; no \`${closeLabel.value}\` label — posting ${graceDays}-day grace-close warning` },
          act: async () => {
            await ctx.store.createComment(issue.number, [
              CLOSE_WARNING_MARKER,
              `This ticket's work has merged (${merged}), but it does not carry \`${closeLabel.value}\`.`,
              `The coordinator's loop will close it in ${graceDays} day(s). If something past the code remains, say what here or label it \`${HUMAN_LABEL}\`, and it stays open.`,
            ].join('\n'));
            ctx.log(`close: ${ref} — grace-close warning posted (${graceDays}-day grace period)`);
            return { produced: true, summary: `grace-close warning posted (${graceDays}-day grace period)` };
          },
        };
        plan.items.push(item);
        continue;
      }

      // Warning exists. Check if a human replied after it.
      const humanReplied = comments.slice(warningIdx + 1).some((c) => !writtenByLoop(c.body));
      if (humanReplied) {
        skip(`${merged}; human replied after grace-close warning — left for them`);
        continue;
      }

      // Check whether the grace period has elapsed.
      const warningTime = new Date(comments[warningIdx]!.createdAt).getTime();
      const elapsedMs = ctx.startedAt.getTime() - warningTime;
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

      if (elapsedDays < graceDays) {
        const remaining = Math.ceil(graceDays - elapsedDays);
        skip(`${merged}; grace-close warning posted — ${remaining} day(s) remaining before auto-close`);
        continue;
      }

      // Grace elapsed with no human response. Close the ticket.
      const item: Item = {
        ref, stopLine,
        decision: { kind: 'dispatch', detail: `${merged}; grace period (${graceDays} day(s)) elapsed with no response — closing` },
        act: async () => {
          await ctx.store.createComment(issue.number, [
            CLOSE_WARNING_MARKER,
            `Grace period elapsed with no response. Closing — the work merged in #${pr.number} and no one indicated further work is needed.`,
          ].join('\n'));
          await ctx.store.closeIssue(issue.number, 'completed');
          ctx.log(`close: ${ref} grace-closed (${graceDays}-day grace elapsed)`);
          return { produced: true, summary: `grace-closed after ${graceDays}-day grace period` };
        },
      };
      plan.items.push(item);
      continue;
    }

    const item: Item = {
      ref,
      stopLine,
      decision: { kind: 'dispatch', detail: `${merged}; carries \`${closeLabel.value}\` (${closeLabel.line}), so close it as done` },
      act: async () => {
        const comments = await ctx.comments(issue.number);
        // A pass that posted the DONE comment and then failed to close leaves it
        // behind; the retry finishes the close without saying it twice.
        const posted = comments.find((c) => c.body.includes(DONE_MARKER));
        const commentId = posted?.id ?? await ctx.store.createComment(issue.number, [
          DONE_MARKER,
          `Done: the work merged into \`${ctx.base}\` in #${pr.number}${pr.mergeCommit ? ` (merge commit ${pr.mergeCommit})` : ''}${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}.`,
          '',
          `This ticket carries \`${closeLabel.value}\`, so under the store's rule its definition of done ends at that pull request`,
          '(`tickets/store-config.md`, *When merged work closes its ticket*). GitHub does not close an issue from a merge into',
          `\`${ctx.base}\`, so the coordinator's loop closes it in pass ${ctx.passId}.`,
        ].join('\n'));
        const claims = comments.filter((c) => ctx.rules.isClaim(c.body));
        for (const claim of claims) await ctx.store.deleteComment(claim.id);
        await ctx.store.closeIssue(issue.number);
        ctx.log(`close: ${ref} closed; DONE comment ${commentId}; ${claims.length} claim comment(s) released`);
        return { produced: true, summary: `closed as done (comment ${commentId}; ${claims.length} claim comment(s) released)` };
      },
    };
    plan.items.push(item);
  }
  return plan;
}
