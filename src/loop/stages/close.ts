import { HUMAN_LABEL } from '../context.js';
import { CLOSE_WARNING_MARKER, DONE_MARKER, VERDICT_CLOSE_MARKER, writtenByLoop } from '../markers.js';
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
 *
 * The close stage also acts on "should be closed" verdicts in the current
 * assessment, when the store configuration enables it with
 * `close on assessment verdict: yes` in the Loop limits table. For each such
 * verdict it posts one comment citing the kind and the evidence, then closes
 * the ticket as not planned. The opt-in is off by default: a missing row, or
 * any value other than `yes`, leaves verdict closes to a person.
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

  // Verdict closes: close tickets the current assessment says should be closed.
  // Off unless the store configuration carries `close on assessment verdict: yes`.
  const verdictCloseSetting = ctx.policy.limits.get('close on assessment verdict');
  if (verdictCloseSetting?.value === 'yes') {
    await planVerdictCloses(ctx, plan);
  }

  return plan;
}

/**
 * A single parsed `CLOSE_VERDICT:` line from an assessment comment.
 *
 * The assess prompt asks the model to append one line per ticket it judges
 * should be closed. The close stage reads these lines and acts on them when
 * the assessment is current and the ticket passes the skip conditions.
 *
 * Exported for tests.
 */
export interface CloseVerdict {
  ticket: number;
  kind: 'duplicate' | 'already-done' | 'no-longer-true';
  /** Set only for `kind === 'duplicate'`; the ticket this one duplicates. */
  dup?: number;
}

/**
 * Parse every `CLOSE_VERDICT:` line in an assessment comment body.
 *
 * Lines that do not match the format are silently ignored; they come from prose
 * in the assessment and are not machine-readable verdicts.
 *
 * Exported for tests.
 */
export function parseCloseVerdicts(body: string): CloseVerdict[] {
  const out: CloseVerdict[] = [];
  for (const line of body.split('\n')) {
    const m = /^CLOSE_VERDICT:\s+ticket=#(\d+)\s+kind=(duplicate|already-done|no-longer-true)(?:\s+dup=#(\d+))?/.exec(line.trim());
    if (!m) continue;
    const ticket = Number(m[1]);
    const kind = m[2] as CloseVerdict['kind'];
    const dup = m[3] !== undefined ? Number(m[3]) : undefined;
    out.push({ ticket, kind, ...(dup !== undefined ? { dup } : {}) });
  }
  return out;
}

/** True when the assessment body has prose evidence for ticket #N beyond the CLOSE_VERDICT lines. */
function hasProseEvidence(body: string, ticketNumber: number): boolean {
  const withoutVerdictLines = body.split('\n').filter((l) => !/^CLOSE_VERDICT:/.test(l.trim())).join('\n');
  return new RegExp(`#${ticketNumber}(?!\\d)`).test(withoutVerdictLines);
}

async function planVerdictCloses(ctx: PassContext, plan: StagePlan): Promise<void> {
  const { rules } = ctx;
  const efforts = [...new Set(ctx.issues.flatMap((i) => i.labels.filter((l) => l.startsWith('effort:'))))].sort();

  for (const effort of efforts) {
    let tracking;
    try { tracking = rules.trackingIssue(ctx.issues, effort); }
    catch { continue; }

    const comments = await ctx.comments(tracking.number);
    const assessmentComment = comments.filter((c) => c.body.includes(rules.MARKER)).pop();
    if (!assessmentComment) continue;

    // Collect dependency states to match the fingerprint the assess run computed.
    const candidates = rules.candidates(ctx.issues, effort);
    const dependencyStates: Record<number, string> = {};
    for (const n of new Set(candidates.flatMap((i) => rules.dependsOn(i.body)))) {
      dependencyStates[n] = await ctx.store.issueState(n);
    }

    const decision = rules.decide({
      issues: ctx.issues, effortLabel: effort, dependencyStates,
      devHead: ctx.baseSha, priorComment: assessmentComment.body,
    });
    if (decision.shouldRun) continue; // Assessment is stale — skip all verdict closes for this effort.

    const verdicts = parseCloseVerdicts(assessmentComment.body);
    for (const v of verdicts) {
      const ref = `#${v.ticket}`;
      const issue = ctx.issues.find((i) => i.number === v.ticket && i.state === 'OPEN');
      const skip = (reason: string): void => {
        plan.items.push({ ref, decision: { kind: 'skip', reason: `verdict close: ${reason}` } });
      };

      if (!issue) { skip('not among current open issues'); continue; }

      const stopLine = resolveStopLine(ctx.policy, issue.labels);

      if (issue.number === tracking.number) { skip('tracking issue'); continue; }
      if (issue.assignees.length > 0) { skip(`human assignee (${issue.assignees.join(', ')})`); continue; }
      if (issue.labels.includes(HUMAN_LABEL)) { skip('HUMAN label'); continue; }
      if (issue.labels.includes('auto') || issue.labels.includes('escalated')) {
        skip(issue.labels.includes('auto') ? 'auto label' : 'escalated label'); continue;
      }
      if (v.kind === 'duplicate' && v.dup === undefined) { skip('duplicate verdict has no dup number'); continue; }
      if (v.kind !== 'duplicate' && !hasProseEvidence(assessmentComment.body, v.ticket)) {
        skip('no prose evidence in assessment'); continue;
      }

      const kindLabel = v.kind === 'duplicate' ? `duplicate of #${v.dup}` : v.kind;
      const item: Item = {
        ref, stopLine,
        decision: { kind: 'dispatch', detail: `verdict close: ${kindLabel} (assessment comment ${assessmentComment.id} in #${tracking.number})` },
        act: async () => {
          const issueComments = await ctx.comments(issue.number);
          // A pass that posted the VERDICT_CLOSE comment and then failed to close
          // leaves it behind; the retry finishes the close without a second comment.
          const posted = issueComments.find((c) => c.body.includes(VERDICT_CLOSE_MARKER));
          if (!posted) {
            const lines = [VERDICT_CLOSE_MARKER];
            if (v.kind === 'duplicate') {
              lines.push(`Closing as not planned: this ticket duplicates #${v.dup}.`);
            } else if (v.kind === 'already-done') {
              lines.push(`Closing as not planned: the current assessment judges this ticket already done.`);
            } else {
              lines.push(`Closing as not planned: the current assessment judges this ticket no longer true.`);
            }
            lines.push('');
            lines.push(`Evidence is in the assessment comment (comment ${assessmentComment.id} in #${tracking.number}).`);
            lines.push('');
            lines.push(`The coordinator's loop closed this ticket in pass ${ctx.passId} under \`close on assessment verdict: yes\` in the store configuration (\`tickets/store-config.md\`, *Loop limits*).`);
            await ctx.store.createComment(issue.number, lines.join('\n'));
          }
          await ctx.store.closeIssue(issue.number, 'not planned');
          ctx.log(`close: ${ref} closed on verdict (${kindLabel}; assessment comment ${assessmentComment.id})`);
          return { produced: true, summary: `closed as not planned on ${kindLabel} verdict (assessment comment ${assessmentComment.id})` };
        },
      };
      plan.items.push(item);
    }
  }
}
