import { chooseOption, noOption, optionsLabel, outputPath, previewDispatch, readOutput, runModel, short, whyNot, worktreeDir } from '../context.js';
import type { ChoiceRequest } from '../context.js';
import { rung, stageOptions } from '../policy.js';
import { assessPrompt } from '../prompts.js';
import type { Item, PassContext, StagePlan } from '../types.js';

/**
 * Rung 1: keep one current assessment on each effort's tracking issue.
 *
 * The candidate set and the fingerprint that says whether an assessment is still
 * current are the repository's (`auto-candidates.mjs` `decide`). A current
 * fingerprint costs nothing. A stale one gets a model run that proposes a verdict
 * per ticket; the loop posts it as the single assessment comment. Labels, bodies
 * and states of the assessed tickets are never touched.
 */
export async function planAssess(ctx: PassContext): Promise<StagePlan> {
  const { rules, policy } = ctx;
  const plan: StagePlan = { stage: 'assess', rung: rung(policy, 'granted'), items: [], notes: [], faults: [] };

  const efforts = [...new Set(ctx.issues.flatMap((i) => i.labels.filter((l) => l.startsWith('effort:'))))].sort();
  for (const effort of efforts) {
    const candidates = rules.candidates(ctx.issues, effort);
    let tracking;
    try {
      tracking = rules.trackingIssue(ctx.issues, effort);
    } catch (err) {
      if (candidates.length > 0) {
        plan.items.push({ ref: effort, decision: { kind: 'blocked', reason: `no tracking issue: ${err instanceof Error ? err.message : String(err)}` } });
      }
      continue;
    }
    const ref = `#${tracking.number} (${effort})`;
    const dependencyStates: Record<number, string> = {};
    for (const n of new Set(candidates.flatMap((i) => rules.dependsOn(i.body)))) {
      dependencyStates[n] = await ctx.store.issueState(n);
    }
    const comments = await ctx.comments(tracking.number);
    const prior = comments.filter((c) => c.body.includes(rules.MARKER)).pop();
    const decision = rules.decide({
      issues: ctx.issues, effortLabel: effort, dependencyStates, devHead: ctx.baseSha, priorComment: prior?.body ?? null,
    });
    if (!decision.shouldRun) {
      plan.items.push({ ref, decision: { kind: 'skip', reason: `assessment current — ${decision.reason}` } });
      continue;
    }

    const post = async (text: string): Promise<number> => {
      const body = `${rules.MARKER}\n${rules.renderFingerprint(decision.fingerprint)}\n\n${text}\n`;
      if (prior) {
        await ctx.store.updateComment(prior.id, body);
        return prior.id;
      }
      return ctx.store.createComment(tracking.number, body);
    };

    // An empty backlog is still worth saying once, and saying it needs no model.
    if (candidates.length === 0) {
      plan.items.push({
        ref,
        decision: { kind: 'dispatch', detail: 'no ticket awaits a verdict; post that without a model run' },
        act: async () => {
          const id = await post(`No open ticket in \`${effort}\` awaits a verdict (read at ${ctx.base} ${short(ctx.baseSha)}).`);
          return { produced: true, summary: `assessment comment ${id} says the queue is clear` };
        },
      });
      continue;
    }

    const taskId = `loop-assess-${tracking.number}-${decision.fingerprint.slice(0, 8)}`;
    const request: ChoiceRequest = { stage: 'assess', subject: ref, taskId, actions: ['review'] };
    const item: Item = {
      ref,
      decision: { kind: 'dispatch', detail: `${decision.reason}; assess ${candidates.map((c) => `#${c.number}`).join(' ')} on ${optionsLabel(stageOptions(policy, 'assess'))}` },
      act: async () => {
        const picked = await chooseOption(ctx, request);
        if (!picked.tier) return noOption(picked);
        const tier = picked.tier;
        const dir = worktreeDir(ctx, `assess-${tracking.number}`);
        await ctx.repo.addWorktree(dir, `origin/${ctx.base}`);
        try {
          const out = outputPath(ctx, taskId);
          const result = await runModel(ctx, {
            outputPath: out, loop: { stage: 'assess', item: `#${tracking.number}`, workType: 'tracking' },
            stage: 'assess', template: 'assess', tier, taskId, cwd: dir, actions: ['review'], timeoutMs: 1_800_000,
            prompt: assessPrompt({
              repo: ctx.slug, base: ctx.base, baseSha: ctx.baseSha, effortLabel: effort, outputPath: out,
              tickets: candidates.map((c) => ({ number: c.number, title: c.title, labels: c.labels, body: c.body })),
            }),
          });
          const text = result.outcome.kind === 'completed' ? readOutput(out, result) : undefined;
          if (!text) return { produced: false, summary: `no assessment: ${whyNot(result)}`, ...(result.runtimeDispatched ? {} : { blocked: whyNot(result) }) };
          const id = await post(text);
          ctx.commands.recordLoop(taskId, { stage: 'assess', item: `#${tracking.number}`, workType: 'tracking', wrote: `comment ${id}` });
          return { produced: true, summary: `assessment comment ${id} ${prior ? 'updated' : 'posted'}, fingerprint ${short(decision.fingerprint)}` };
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
