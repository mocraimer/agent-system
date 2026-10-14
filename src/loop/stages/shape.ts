import { chooseOption, HUMAN_LABEL, noOption, optionsLabel, outputPath, previewDispatch, readOutput, runModel, short, whyNot, worktreeDir } from '../context.js';
import type { ChoiceRequest } from '../context.js';
import { numericLimit, resolveStopLine, rung, stageOptions } from '../policy.js';
import { shapePrompt } from '../prompts.js';
import type { Item, PassContext, StagePlan } from '../types.js';

/**
 * Rung 0: draft a shape proposal for every unshaped ticket whose proposal is
 * missing or stale.
 *
 * Which tickets are unshaped, and whether a posted proposal still matches its
 * ticket, are the repository's own rules (`shape-candidates.mjs`). The run drafts;
 * the loop posts the draft under the proposal marker with the body's fingerprint.
 * Nothing here applies a label — `shaped` is a person's act.
 */
export async function planShape(ctx: PassContext): Promise<StagePlan> {
  const { rules, policy } = ctx;
  const plan: StagePlan = { stage: 'shape', rung: rung(policy, 'proposal'), items: [], notes: [], faults: [] };
  const perPass = numericLimit(policy, 'shape runs per pass');
  let planned = 0;

  for (const issue of rules.shapeable(ctx.issues, null)) {
    const stopLine = resolveStopLine(policy, issue.labels);
    const ref = `#${issue.number}`;
    if (issue.labels.includes(HUMAN_LABEL)) {
      plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason: 'HUMAN label — not store-defined, left for the operator' } });
      continue;
    }
    const comments = await ctx.comments(issue.number);
    const proposal = comments.filter((c) => c.body.includes(rules.SHAPE_MARKER)).pop();
    const fingerprint = rules.issueBodyHash(issue.body);
    if (proposal && rules.readShapeFingerprint(proposal.body) === fingerprint) {
      plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason: 'proposal current' } });
      continue;
    }
    if (planned >= perPass) {
      plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason: `per-pass limit of ${perPass} reached; next pass` } });
      continue;
    }
    planned++;
    const taskId = `loop-shape-${issue.number}-${fingerprint.slice(0, 8)}`;
    const request: ChoiceRequest = { stage: 'shape', subject: ref, taskId, actions: ['author-changes'] };
    const item: Item = {
      ref,
      stopLine,
      decision: { kind: 'dispatch', detail: `${proposal ? 'proposal stale' : 'no proposal'}; shape on ${optionsLabel(stageOptions(policy, 'shape'))}` },
      act: async () => {
        const picked = await chooseOption(ctx, request);
        if (!picked.tier) return noOption(picked);
        const tier = picked.tier;
        const dir = worktreeDir(ctx, `shape-${issue.number}`);
        await ctx.repo.addWorktree(dir, ctx.policyRef);
        try {
          const out = outputPath(ctx, taskId);
          const result = await runModel(ctx, {
            outputPath: out, loop: { stage: 'shape', item: ref, workType: stopLine.workType, stopLine: stopLine.rung },
            stage: 'shape', template: 'shape', tier, taskId, cwd: dir, actions: ['author-changes'], timeoutMs: 3_600_000,
            prompt: shapePrompt({ repo: ctx.slug, issue, outputPath: out }),
          });
          const draft = result.outcome.kind === 'completed' ? readOutput(out, result) : undefined;
          if (!draft) return { produced: false, summary: `no proposal: ${whyNot(result)}`, ...(result.runtimeDispatched ? {} : { blocked: whyNot(result) }) };
          const body = `${rules.SHAPE_MARKER}\n${rules.renderShapeFingerprint(fingerprint)}\n\n${draft}\n`;
          let commentId: number;
          if (proposal) {
            await ctx.store.updateComment(proposal.id, body);
            commentId = proposal.id;
          } else {
            commentId = await ctx.store.createComment(issue.number, body);
          }
          ctx.commands.recordLoop(taskId, { stage: 'shape', item: ref, workType: stopLine.workType, stopLine: stopLine.rung, wrote: `comment ${commentId}` });
          return { produced: true, summary: `proposal ${proposal ? 'updated' : 'posted'} as comment ${commentId}, fingerprint ${short(fingerprint)}` };
        } finally {
          await ctx.repo.removeWorktree(dir);
        }
      },
    };
    await previewDispatch(ctx, item, request);
    plan.items.push(item);
  }
  return plan;
}
