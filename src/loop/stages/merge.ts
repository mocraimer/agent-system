import { chooseOption, HUMAN_LABEL, noOption, optionsLabel, previewDispatch, readOutput, runModel, short, stopLineOfPull, ticketOf, whyNot, worktreeDir } from '../context.js';
import type { ChoiceRequest } from '../context.js';
import { findingsAcceptedAt, markerAt, newestReview, reviewMatchesBody } from '../markers.js';
import { rung, stageOptions } from '../policy.js';
import { checkPrompt } from '../prompts.js';
import type { Tier } from '../policy.js';
import type { Item, LoopCommands, PassContext, StagePlan } from '../types.js';
import { STATUS_SKIPPED, STATUS_STOPPED } from '../labels.js';
import type { StatusLabel } from '../labels.js';

/** `check-pr`'s own verdict line. */
export function checkPrPassed(output: string | undefined): boolean {
  return /^##\s*check-pr:\s*PASS\b/m.test(output ?? '');
}

/**
 * Rung 5: merge a reviewed pull request into the base branch — only where the
 * ticket's stop-line reaches this rung, the newest review names the current head
 * with no findings or current-head accepted findings and is independent,
 * authority covers `merge-dev`, and `check-pr` reports the pull request ready. Each condition is
 * read from GitHub in this pass; the merge names the head it checked, so a push
 * after the check makes GitHub refuse it. A merge commit, never a squash. The
 * ticket stays open for a person to close.
 */
export async function planMerge(ctx: PassContext): Promise<StagePlan> {
  const stageRung = rung(ctx.policy, 'dev');
  const plan: StagePlan = { stage: 'merge', rung: stageRung, items: [], notes: [], faults: [] };

  const releaseBranch = ctx.policy.protocol.releaseBranch.value;
  if (ctx.base === releaseBranch) {
    plan.notes.push(`merge: the base branch is ${releaseBranch}, the release branch, which only a person merges into; this stage does nothing here`);
    return plan;
  }
  const pulls = ctx.pulls.filter((p) => p.baseRefName === ctx.base && !p.isDraft).sort((a, b) => a.number - b.number);
  for (const pr of pulls) {
    const comments = await ctx.comments(pr.number);
    const newest = newestReview(comments);
    if (newest && markerAt(newest, pr.headRefOid) && !reviewMatchesBody(newest, pr.body, true)) {
      plan.items.push({ ref: `PR #${pr.number}`, decision: { kind: 'skip', reason: 'the review does not cover the current PR description; re-review before merge', owner: STATUS_STOPPED } });
      continue;
    }
    // Clean at head, or a person accepted what stood against this exact head.
    const accepted = findingsAcceptedAt(comments, pr.headRefOid);
    if (!newest || !markerAt(newest, pr.headRefOid) || (newest.findings !== 0 && !accepted)) continue;

    const ref = `PR #${pr.number}`;
    const stopLine = await stopLineOfPull(ctx, pr);
    const reviewState = newest.findings > 0 ? 'current-head findings accepted' : 'clean review';
    const skip = (reason: string, owner?: StatusLabel): void => {
      plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason, ...(owner ? { owner } : {}) } });
    };
    if (stopLine.labels.includes(HUMAN_LABEL)) { skip('carries HUMAN — not store-defined, left for the operator', STATUS_SKIPPED); continue; }
    if (ticketOf(pr) === undefined) { skip(`${reviewState} at head; not a pull request the loop opened — a person merges it`, STATUS_SKIPPED); continue; }
    if (stopLine.rung < stageRung.number) { skip(`stop-line ${stopLine.rung} < ${stageRung.number}${newest.findings > 0 ? '; current-head findings accepted, awaits a human merge' : ''}`, STATUS_STOPPED); continue; }
    if (!newest.independent) { skip('the newest review is not independent, so it does not satisfy rung 3'); continue; }

    const options = stageOptions(ctx.policy, 'merge');
    const head = pr.headRefOid;
    const taskId = `loop-merge-pr${pr.number}-${short(head)}`;
    const mergeAuthority = (runtime: Tier['runtime']): ReturnType<LoopCommands['authorize']> => ctx.commands.authorize({
      repo: ctx.slug, workClass: 'loop-merge', runtime, profile: 'default', actions: ['merge-dev'],
      triggerSource: ctx.triggerSource, taskId,
    });
    // Merging is a person's grant: with no option's runtime holding it, the check would run for nothing.
    const denials = options.map((o) => mergeAuthority(o.runtime)).filter((a) => !a.allowed);
    if (denials.length === options.length) {
      plan.items.push({ ref, stopLine, decision: { kind: 'blocked', reason: `no authority for merge-dev: ${denials[0]!.outcome.summary}` } });
      continue;
    }
    const request: ChoiceRequest = { stage: 'merge', subject: ref, taskId, actions: ['review'], alsoAuthorized: ['merge-dev'] };

    const item: Item = {
      ref,
      stopLine,
      decision: { kind: 'dispatch', detail: `${reviewState} with independent review at ${short(head)}; check-pr on ${optionsLabel(options)}, then merge into ${ctx.base}` },
      act: async () => {
        const picked = await chooseOption(ctx, request);
        if (!picked.tier) return noOption(picked);
        const tier = picked.tier;
        const dir = worktreeDir(ctx, `merge-${pr.number}`);
        await ctx.repo.addWorktree(dir, `origin/${ctx.base}`);
        try {
          const result = await runModel(ctx, {
            loop: { stage: 'merge', item: ref, workType: stopLine.workType, stopLine: stopLine.rung, head },
            stage: 'merge', template: 'check', tier, taskId, cwd: dir, actions: ['review'], timeoutMs: 1_200_000,
            prompt: checkPrompt({ repo: ctx.slug, pr: { number: pr.number, branch: pr.headRefName }, head }),
          });
          const verdict = result.outcome.kind === 'completed' ? readOutput(undefined, result) : undefined;
          if (!checkPrPassed(verdict)) {
            return { produced: false, summary: `check-pr did not pass: ${verdict ? verdict.split('\n').slice(0, 4).join(' ') : whyNot(result)}`, ...(result.runtimeDispatched ? {} : { blocked: whyNot(result) }) };
          }

          // Re-read the PR and review after check-pr. A body-only edit cannot
          // keep the same head and borrow a digestless or older-body review.
          const live = (await ctx.store.listOpenPulls()).find((p) => p.number === pr.number);
          const liveComments = await ctx.store.comments(pr.number);
          const liveReview = newestReview(liveComments);
          const liveAccepted = findingsAcceptedAt(liveComments, head);
          if (!live || live.headRefOid !== head || live.body !== pr.body || !liveReview || !markerAt(liveReview, head)
            || !reviewMatchesBody(liveReview, live.body, true)
            || (liveReview.findings !== 0 && !liveAccepted) || !liveReview.independent) {
            return { produced: false, summary: 'the pull request changed between the check and the merge; the next pass reads it again' };
          }
          const recheck = mergeAuthority(tier.runtime);
          if (!recheck.allowed) return { produced: false, summary: 'merge-dev authority was withdrawn', blocked: recheck.outcome.summary };

          await ctx.store.mergePull(pr.number, head, { into: ctx.base, never: releaseBranch });
          const at = new Date().toISOString();
          ctx.commands.recordLoop(taskId, {
            stage: 'merge', item: ref, workType: stopLine.workType, stopLine: stopLine.rung, head,
            merged: { into: ctx.base, head, at }, wrote: `merge of PR #${pr.number}`,
          });
          return { produced: true, summary: `merged PR #${pr.number} at ${short(head)} into ${ctx.base} with a merge commit; the close step closes the ticket on a later pass under the store's rule` };
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
