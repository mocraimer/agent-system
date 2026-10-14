import { randomUUID } from 'node:crypto';
import { chooseOption, HUMAN_LABEL, modelTrailer, noOption, optionsLabel, previewDispatch, runModel, whyNot, worktreeDir } from '../context.js';
import type { ChoiceRequest } from '../context.js';
import { resolveStopLine, rung, stageOptions } from '../policy.js';
import { sweepPrompt } from '../prompts.js';
import type { Item, PassContext, StagePlan } from '../types.js';
import type { Issue } from '../github.js';

const ESCALATED_LABEL = 'escalated';

/** The task id a ticket's sweep runs share, so a recovery is a second attempt of the same task. */
export const sweepTaskId = (n: number): string => `loop-sweep-${n}`;

interface Candidate {
  issue: Issue;
  item: Item;
  recovering: boolean;
  claimId?: number;
}

/**
 * Rung 2: work one granted ticket to an open pull request, then stop.
 *
 * The loop selects — recovery first, then the oldest ready ticket, as the store
 * configuration says — and writes the claim comment before any work starts. The
 * run itself is `run-ticket` on the sweep tier, in a worktree of the base branch,
 * dispatched through the coordinator. One ticket per pass.
 */
export async function planSweep(ctx: PassContext): Promise<StagePlan> {
  const { rules, policy } = ctx;
  const stageRung = rung(policy, 'pr-open');
  const plan: StagePlan = { stage: 'sweep', rung: stageRung, items: [], notes: [], faults: [] };

  const granted = ctx.issues
    .filter((i) => i.labels.includes('auto') && !i.labels.includes('effort'))
    .sort((a, b) => a.number - b.number);

  const recoveries: Candidate[] = [];
  const ready: Candidate[] = [];
  for (const issue of granted) {
    const ref = `#${issue.number}`;
    const stopLine = resolveStopLine(policy, issue.labels);
    const skip = (reason: string): void => { plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason } }); };

    if (!issue.labels.some((l) => l.startsWith('effort:'))) { skip('in no effort — the effort filter passes it over'); continue; }
    if (issue.labels.includes(ESCALATED_LABEL)) { skip('escalated'); continue; }
    if (issue.assignees.length > 0) { skip(`human assignee (${issue.assignees.join(', ')})`); continue; }
    if (issue.labels.includes(HUMAN_LABEL)) { skip('HUMAN label — not store-defined, left for the operator'); continue; }
    if (stopLine.rung < stageRung.number) { skip(`stop-line ${stopLine.rung} below this stage (${stageRung.number})`); continue; }
    const deps = rules.dependsOn(issue.body);
    const open: number[] = [];
    for (const n of deps) if ((await ctx.store.issueState(n)) !== 'CLOSED') open.push(n);
    if (open.length > 0) { skip(`dependency open (${open.map((n) => `#${n}`).join(', ')})`); continue; }

    const comments = await ctx.comments(issue.number);
    const claim = comments.filter((c) => rules.isClaim(c.body)).pop();
    const pulls = await ctx.store.pullsFromHead(`ticket/${issue.number}`);
    const openPull = pulls.find((p) => (p.state ?? '').toUpperCase() === 'OPEN');
    const mergedPull = pulls.find((p) => (p.state ?? '').toUpperCase() === 'MERGED');

    if (claim) {
      if (openPull) { skip(`claim outstanding; PR already open (#${openPull.number})`); continue; }
      if (mergedPull) { skip(`claim outstanding; PR #${mergedPull.number} merged — the close step's, not the sweep's`); continue; }
      if (ctx.commands.inFlight(sweepTaskId(issue.number))) { skip('claim outstanding; its run is in flight'); continue; }
      const item: Item = { ref, stopLine, decision: { kind: 'dispatch', detail: 'recover the interrupted attempt' } };
      recoveries.push({ issue, item, recovering: true, claimId: claim.id });
      plan.items.push(item);
      continue;
    }
    if (openPull) { skip(`PR already open (#${openPull.number}) with no claim — someone else's work`); continue; }
    const item: Item = { ref, stopLine, decision: { kind: 'dispatch', detail: 'ready' } };
    ready.push({ issue, item, recovering: false });
    plan.items.push(item);
  }

  // Recovery before new work, then oldest first; one ticket per pass.
  const [chosen, ...rest] = [...recoveries, ...ready];
  for (const other of rest) other.item.decision = { kind: 'skip', reason: `one ticket per pass; #${chosen!.issue.number} goes first` };
  if (!chosen) {
    plan.notes.push('sweep: nothing dispatchable');
    return plan;
  }

  const request: ChoiceRequest = {
    stage: 'sweep', subject: `#${chosen.issue.number}`, taskId: sweepTaskId(chosen.issue.number), actions: ['author-changes', 'push-branch', 'open-pr'],
  };
  chosen.item.decision = {
    kind: 'dispatch',
    detail: `${chosen.recovering ? 'recover the interrupted attempt' : 'claim and start'}; run-ticket on ${optionsLabel(stageOptions(policy, 'sweep'))}`,
  };
  await previewDispatch(ctx, chosen.item, request);
  chosen.item.act = async () => {
    const { issue } = chosen;
    const taskId = sweepTaskId(issue.number);
    // A claim is a write other people see. Choose first, so a pass where no option
    // could start does not post and delete one each time.
    const picked = await chooseOption(ctx, request);
    if (!picked.tier) return noOption(picked);
    const tier = picked.tier;
    let claimId = chosen.claimId;
    let wroteClaim = false;
    let dispatched = false;
    const dir = worktreeDir(ctx, `sweep-${issue.number}`);
    try {
      if (claimId === undefined) {
        claimId = await ctx.store.createComment(issue.number, [
          rules.CLAIM_MARKER,
          rules.LOOP_CLAIM_LINE,
          '',
          `Claimed by the coordinator's loop in pass ${ctx.passId} to run \`run-ticket\` on this ticket. The claim is`,
          'held while this comment exists; deleting it releases the claim.',
        ].join('\n'));
        wroteClaim = true;
      }
      await ctx.repo.addWorktree(dir, `origin/${ctx.base}`);
      const existing = await ctx.store.pullsFromHead(`ticket/${issue.number}`);
      if (existing.some((p) => p.state === 'OPEN')) return { produced: false, summary: 'A PR appeared before this sweep attempt began; no work was dispatched.', blocked: 'Inspect the PR and claim before retrying.' };
      // A one-time line every commit of this attempt carries: a pull request whose
      // commits all carry it is this run's work, not a concurrent actor's.
      const attemptTrailer = `Agent-System-Sweep-Attempt: ${randomUUID()}`;
      const result = await runModel(ctx, {
        loop: { stage: 'sweep', item: `#${issue.number}`, workType: chosen.item.stopLine!.workType, stopLine: chosen.item.stopLine!.rung,
          sweepNoPullAtDispatch: true, sweepBase: ctx.base },
        stage: 'sweep', template: 'sweep', tier, taskId, cwd: dir, actions: ['author-changes', 'push-branch', 'open-pr'], timeoutMs: 3_600_000,
        prompt: sweepPrompt({ repo: ctx.slug, issue, base: ctx.base, claimCommentId: claimId, recovering: chosen.recovering, commitTrailer: `${modelTrailer(tier, 'sweep')}\n${attemptTrailer}` }),
      });
      dispatched = result.runtimeDispatched;
      const after = await ctx.store.pullsFromHead(`ticket/${issue.number}`);
      const opened = after.find((p) => (p.state ?? '').toUpperCase() === 'OPEN');
      const now = await ctx.store.issue(issue.number);
      const escalated = now?.labels.includes(ESCALATED_LABEL) ?? false;
      if (!dispatched) return { produced: false, summary: `not dispatched: ${whyNot(result)}`, blocked: whyNot(result) };
      const commits = opened && result.outcome.kind === 'completed' && opened.baseRefName === ctx.base
        ? await ctx.store.pullCommits(opened.number) : [];
      const proven = commits.length > 0 && commits.every((c) => c.message.split('\n').includes(attemptTrailer));
      ctx.commands.recordLoop(taskId, {
        stage: 'sweep', item: `#${issue.number}`, workType: chosen.item.stopLine!.workType, stopLine: chosen.item.stopLine!.rung,
        escalated, ...(proven ? { wrote: `PR #${opened!.number}` } : {}),
      });
      if (proven) return { produced: true, summary: `PR #${opened!.number} open from ticket/${issue.number}; every commit carries this attempt's trailer` };
      // The PR or escalation is a live observation, not proof that this runtime
      // created it. Another actor can act on the same ticket while it runs.
      if (opened) return { produced: false, summary: `PR #${opened.number} is open from ticket/${issue.number}; ${result.outcome.kind}, but this run's ownership of it is unverified.`,
        blocked: 'Inspect the retained run and PR before crediting delivery.' };
      if (escalated) return { produced: false, summary: `Ticket #${issue.number} is escalated; ${result.outcome.kind}, but this run's ownership of that change is unverified.`,
        blocked: 'Inspect the retained run and ticket before crediting delivery.' };
      return { produced: false, summary: `no pull request after the run; ${whyNot(result)}. The claim stays, so the next pass recovers it.` };
    } finally {
      // A claim for work that never reached a runtime would hold the ticket with
      // nothing behind it; a claim for work that ran is what recovery reads.
      if (wroteClaim && !dispatched && claimId !== undefined) {
        await ctx.store.deleteComment(claimId).catch((err: unknown) => {
          ctx.log(`sweep: could not release claim comment ${claimId} on #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      await ctx.repo.removeWorktree(dir);
    }
  };
  return plan;
}
