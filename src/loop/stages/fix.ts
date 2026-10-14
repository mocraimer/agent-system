import { createHash, randomUUID } from 'node:crypto';
import {
  chooseOption, HUMAN_LABEL, modelTrailer, noOption, optionsLabel, outputPath, previewDispatch, readOutput, runModel, short, stopLineOfPull, ticketOf, whyNot, worktreeDir,
} from '../context.js';
import type { ChoiceRequest } from '../context.js';
import {
  appliedComments, findingsAcceptedAt, fixRounds, LOOP_SIGNATURE, markerAt, newestReview, operatorComment, parseFixMarkers, parseReviewMarkers,
  renderAppliedMarker, renderFixMarker, reviewMatchesBody,
} from '../markers.js';
import { numericLimit, rung, stageOptions } from '../policy.js';
import { fixPrompt } from '../prompts.js';
import { tallyFindings } from '../../console/verdicts.js';
import type { Comment, PullRequest } from '../github.js';
import type { Item, OperatorAsk, PassContext, StagePlan } from '../types.js';
import { ACCEPT_FINDINGS_LABEL, APPLY_COMMENT_LABEL, STATUS_SKIPPED, STATUS_STOPPED } from '../labels.js';
import type { StatusLabel } from '../labels.js';

/** What the fix run's commits end with, so its work is attributable to the loop. */

/**
 * Rung 4: a pull request the loop opened, whose review at its current head has
 * findings, gets one fix run that pushes to the pull request's branch. The next
 * pass reviews the new head. The cycle ends at a clean review, at the store's
 * round cap, or when a fix run leaves the head where it was.
 */
export async function planFix(ctx: PassContext): Promise<StagePlan> {
  const stageRung = rung(ctx.policy, 'clean');
  const plan: StagePlan = { stage: 'fix', rung: stageRung, items: [], notes: [], faults: [] };
  const cap = numericLimit(ctx.policy, 'fix rounds per pull request');

  // Drafts, and pull requests against another base that a person has labelled, are
  // kept in and skipped by name below. Dropping either in the filter would answer
  // an operator's label with silence.
  // Only `apply-comment`, which is this stage's to carry out. `accept-findings`
  // is pinned before any stage runs and is not filtered by base, so a pull
  // request against another base has already been answered by the time this runs
  // — telling its operator the label was not acted on would be untrue.
  const labelled = (p: { labels?: string[] }): boolean => (p.labels ?? []).includes(APPLY_COMMENT_LABEL);
  const pulls = ctx.pulls
    .filter((p) => p.baseRefName === ctx.base || labelled(p))
    .sort((a, b) => a.number - b.number);
  for (const pr of pulls) {
    if (pr.baseRefName !== ctx.base) {
      plan.items.push({
        ref: `PR #${pr.number}`,
        ask: { label: APPLY_COMMENT_LABEL, final: true },
        decision: {
          kind: 'skip',
          reason: `targets ${pr.baseRefName}; this loop works ${ctx.base}, so your label is not one it can act on here`,
          owner: STATUS_SKIPPED,
        },
      });
      continue;
    }
    const comments = await ctx.comments(pr.number);
    const newest = newestReview(comments);
    const reviewComment = [...comments].reverse().find((c) => parseReviewMarkers(c.body).length > 0);
    const head = pr.headRefOid;
    const attested = ctx.commands.attestedDescription(ctx.slug, pr.number, head);

    // An operator who labels a pull request `apply-comment` has written what they
    // want done, which is a reason to fix it whatever the review says — including
    // on a pull request no review has findings for, or none at this head.
    const asked = (pr.labels ?? []).includes(APPLY_COMMENT_LABEL);
    // On a pull request the loop did not open, its author is who fixes it. The one exception is the
    // author asking: whoever applied the label and wrote the comment must be that author, because
    // the comment goes to a model that pushes to their branch.
    const outside = ticketOf(pr) === undefined;
    if (asked && outside) {
      const refusal = await outsideRefusal(ctx, pr);
      if (refusal) {
        plan.items.push({
          ref: `PR #${pr.number}`,
          stopLine: await stopLineOfPull(ctx, pr),
          ask: { label: APPLY_COMMENT_LABEL, final: refusal.final },
          decision: { kind: 'skip', reason: refusal.reason, owner: STATUS_SKIPPED },
        });
        continue;
      }
    }
    const instruction = asked ? unconsumedInstruction(comments, outside ? pr.author : undefined) : undefined;
    // A person who accepted the findings standing at this head has answered them;
    // the fix stage has nothing left to do about them.
    const accepted = findingsAcceptedAt(comments, head);
    const acceptancePending = (pr.labels ?? []).includes(ACCEPT_FINDINGS_LABEL) && !accepted;
    const reviewed = Boolean(newest) && markerAt(newest, head) && newest!.findings > 0 && !accepted;
    // The label is on, but there is nothing of theirs left to carry out. Say so: the label stays,
    // and silence here reads exactly like a loop that has not run.
    const nothingWaiting = async (): Promise<void> => {
      plan.items.push({
        ref: `PR #${pr.number}`,
        stopLine: await stopLineOfPull(ctx, pr),
        ask: asking(),
        decision: {
          kind: 'skip',
          reason: `apply-comment: nothing of yours is waiting — the newest comment ${outside ? `of the pull request's author (${pr.author})` : 'here'} is `
            + 'either the loop\'s own or one already carried out. Write a new comment and the loop carries it out on its next pass; the label is still on.',
          owner: STATUS_SKIPPED,
        },
      });
    };
    // A pull request the loop did not open is answered this way even when a review is stale or has
    // findings, since its author fixes those and the label is what was asked about.
    if (!instruction && asked && outside) { await nothingWaiting(); continue; }
    if (!instruction && newest && markerAt(newest, head) && !reviewMatchesBody(newest, pr.body, true)) {
      plan.items.push({
        ref: `PR #${pr.number}`, stopLine: await stopLineOfPull(ctx, pr), ...(asked ? { ask: asking() } : {}),
        decision: { kind: 'skip', reason: 'the review does not cover the current PR description; re-review before fixing', owner: STATUS_STOPPED },
      });
      continue;
    }
    if (!instruction && asked && !reviewed) { await nothingWaiting(); continue; }
    if (acceptancePending && !instruction) {
      plan.items.push({
        ref: `PR #${pr.number}`, ...(asked ? { ask: asking() } : {}),
        decision: { kind: 'skip', reason: 'accept-findings instruction awaits a marker pinned to the current head; no fix is sent', owner: STATUS_SKIPPED },
      });
      continue;
    }
    if (!instruction && !reviewed) continue;

    const ref = `PR #${pr.number}`;
    const stopLine = await stopLineOfPull(ctx, pr);
    const skip = (reason: string, owner?: StatusLabel): void => {
      plan.items.push({
        ref, stopLine, ...(asked ? { ask: asking(instruction) } : {}),
        decision: { kind: 'skip', reason, ...(owner ? { owner } : {}) },
      });
    };
    if (pr.isDraft) { skip('this pull request is a draft; the loop leaves drafts alone, so mark it ready for review', STATUS_SKIPPED); continue; }
    if (stopLine.labels.includes(HUMAN_LABEL)) { skip('carries HUMAN — not store-defined, left for the operator', STATUS_SKIPPED); continue; }
    if (outside && !instruction) { skip(`${describe(newest, instruction)}; not a pull request the loop opened — its author fixes it`, STATUS_SKIPPED); continue; }
    if (stopLine.rung < stageRung.number) { skip(`stop-line ${stopLine.rung} below this stage (${stageRung.number})`, STATUS_STOPPED); continue; }

    const rounds = fixRounds(comments);
    const roundCount = Math.max(rounds.length, attested?.round ?? 0);
    const last = rounds[rounds.length - 1];
    // Both guards below stop the loop looping on its own output. An operator
    // comment is new information from outside the loop, so neither applies to it —
    // and without this the label would do nothing on exactly the pull requests it
    // is for, the ones already given up on.
    if (!instruction) {
      if (last && head.toLowerCase().startsWith(last.from.toLowerCase()) && last.from === last.to && (attested?.round ?? 0) <= last.round) {
        // A round that answered without code is followed by a re-review of the same
        // head. Until that runs there is nothing to judge; once it has, findings still
        // standing mean the answer did not settle them, and looping would not either.
        const answeredAt = comments.findLastIndex((c) => parseFixMarkers(c.body).some((m) => m.round === last.round));
        const reviewedAt = comments.findLastIndex((c) => parseReviewMarkers(c.body).length > 0);
        if (answeredAt > reviewedAt) { skip(`round ${last.round} answered at ${short(head)} without a code change; waiting for its re-review`); continue; }
        skip(`no progress: round ${last.round} left the head at ${short(head)} and the re-review still has findings=${newest?.findings ?? 0}; left for a person`, STATUS_STOPPED);
        continue;
      }
      if (roundCount >= cap) {
        skip(`round cap reached (${roundCount}/${cap}); left for a person`, STATUS_STOPPED);
        continue;
      }
    }

    const round = roundCount + 1;
    // An operator instruction replaces the review body: they have read the
    // findings and said what they want instead.
    const brief = instruction
      ? `A person reviewing this pull request asked for the following. Do what it asks.\n\n${instruction.body}`
      : reviewComment!.body;
    // The ticket's accepted scope: the shape proposal it was granted on, or the ticket body.
    const ticketNumber = ticketOf(pr);
    let scope: string | undefined;
    if (ticketNumber !== undefined) {
      const ticketIssue = ctx.issues.find((i) => i.number === ticketNumber) ?? await ctx.issue(ticketNumber);
      if (ticketIssue) {
        const ticketComments = await ctx.comments(ticketNumber);
        const proposal = ticketComments.find((c) => c.body.includes(ctx.rules.SHAPE_MARKER));
        scope = proposal?.body ?? ticketIssue.body;
      }
    }
    const taskId = `loop-fix-pr${pr.number}-${short(head)}`;
    const request: ChoiceRequest = { stage: 'fix', subject: ref, taskId, actions: ['author-changes', 'push-branch'] };
    const attemptTrailer = `Agent-System-Fix-Attempt: ${randomUUID()}`;
    const item: Item = {
      ref,
      stopLine,
      ...(instruction ? { ask: asking(instruction) } : {}),
      decision: { kind: 'dispatch', detail: `${describe(newest, instruction)} at ${short(head)}; round ${round}/${cap} on ${optionsLabel(stageOptions(ctx.policy, 'fix'))}` },
      act: async () => {
        const picked = await chooseOption(ctx, request);
        if (!picked.tier) return noOption(picked);
        const tier = picked.tier;
        const dir = worktreeDir(ctx, `fix-${pr.number}`);
        await ctx.repo.fetch([`+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);
        await ctx.repo.addWorktree(dir, `origin/${pr.headRefName}`, pr.headRefName);
        try {
          const checkedOut = await ctx.repo.revParse(`origin/${pr.headRefName}`);
          if (checkedOut !== head) return { produced: false, summary: `the branch moved to ${short(checkedOut)} since the review; the next pass reviews it` };
          const current = (await ctx.store.pullsFromHead(pr.headRefName)).find((p) => p.number === pr.number && p.state === 'OPEN');
          if (!current || current.headRefOid !== head) return { produced: false, summary: 'The PR changed before the fix started; read it again before dispatching.' };
          if (!instruction && !reviewMatchesBody(newest, current.body, true)) {
            return { produced: false, summary: 'The PR description changed since the review; re-review before fixing.' };
          }
          const descriptionBeforeDigest = createHash('sha256').update(current.body).digest('hex');
          const out = outputPath(ctx, taskId);
          const result = await runModel(ctx, {
            outputPath: out, loop: { stage: 'fix', item: ref, workType: stopLine.workType, stopLine: stopLine.rung, head, round, descriptionBeforeDigest,
              fixBranch: pr.headRefName, fixBase: ctx.base,
              ...(reviewComment ? { reviewCommentAtDispatch: reviewComment.id } : {}) },
            stage: 'fix', template: 'fix', tier, taskId, cwd: dir, actions: ['author-changes', 'push-branch'], timeoutMs: 3_600_000,
            prompt: fixPrompt({
              repo: ctx.slug, pr: { number: pr.number, branch: pr.headRefName, base: ctx.base }, head,
              review: brief, outputPath: out, commitTrailer: `${modelTrailer(tier, 'fix')}\n${attemptTrailer}`,
              ...(scope !== undefined ? { scope } : {}),
            }),
          });
          // A run that did not finish leaves no comment: a half-posted reply would
          // read as a round that happened.
          if (result.outcome.kind !== 'completed') {
            return { produced: false, summary: `fix run did not finish: ${whyNot(result)}`, ...(result.runtimeDispatched ? {} : { blocked: whyNot(result) }) };
          }
          const newHead = await ctx.store.branchHead(pr.headRefName);
          const reply = readOutput(out, result);
          const localHead = await ctx.repo.revParse('HEAD', dir);
          const answered = newHead === head;
          if (answered) {
            // A run that pushed nothing can still have answered the findings, with
            // evidence rather than code. An answer judges them in the form the fix prompt
            // asks for; a reply that only says what it did, or what it is waiting on, is
            // not one. The reply is this run's own output, so the loop posts and credits
            // it; a description edit the run may have made is not credited, since a
            // person could have made the same edit during the run.
            const tally = reply ? tallyFindings(reply) : undefined;
            const judged = tally ? tally.accepted + tally.rejected + tally.outOfScope : 0;
            const answers = judged >= Math.max(1, instruction ? 1 : (newest?.findings ?? 1));
            if (!answers) {
              return {
                produced: false,
                summary: `Runtime completed with no pushed head${reply ? ', and its reply does not judge the findings' : ' and no reply'}; PR description edits cannot be attributed to this run. Attempted output retained at ${result.run?.outputPath ?? out} and remains unverified.`,
                blocked: 'Inspect the retained output and pending checks before retrying.',
              };
            }
            if (localHead.toLowerCase() !== head.toLowerCase()) {
              return {
                produced: false,
                summary: `Runtime completed without pushing, but its local HEAD is ${short(localHead)}, not ${short(head)}. Attempted output retained at ${result.run?.outputPath ?? out} and remains unverified.`,
                blocked: 'Inspect the retained output and the unpushed commit before retrying.',
              };
            }
          } else {
            if (!reply) return { produced: false, summary: 'The fix left no finished reply; its artifact needs inspection.', blocked: 'Inspect the changed PR and retained run evidence.' };
            if (localHead.toLowerCase() !== newHead.toLowerCase()) {
              return { produced: false, summary: `The branch moved to ${short(newHead)}, but this worker's local HEAD is ${short(localHead)}. Output remains unverified.`,
                blocked: 'Inspect the intervening push and retained attempt before attributing the changed head.' };
            }
            const commits = await ctx.store.pullCommits(pr.number);
            const pushed = commits.at(-1);
            if (!pushed || pushed.oid.toLowerCase() !== newHead.toLowerCase() || !pushed.message.split('\n').includes(attemptTrailer)) {
              return { produced: false, summary: `The branch moved to ${short(newHead)}, but its last commit does not carry this fix attempt's trailer. Output remains unverified.`,
                blocked: 'Inspect the branch and retained attempt before attributing the changed head.' };
            }
          }
          const consumed = instruction ? `\n${renderAppliedMarker({ comment: instruction.id, head })}` : '';
          const commentId = await ctx.store.createComment(pr.number, `${reply}\n\n${renderFixMarker({ round, from: head, to: newHead })}${consumed}\n— fix round ${round}/${cap}${answered ? ', answered without a code change' : ''}, ${LOOP_SIGNATURE} in pass ${ctx.passId}\n`);
          // Taken back once carried out, so the label is a single instruction
          // rather than a standing one the next pass would obey again.
          if (instruction) await ctx.store.removeLabel(pr.number, APPLY_COMMENT_LABEL);
          if (newHead !== head) {
            ctx.commands.recordRepair(taskId, { trigger: 'review-finding', detail: `round ${round}: ${describe(newest, instruction)} at ${short(head)}`, head: newHead });
          }
          ctx.commands.recordLoop(taskId, {
            stage: 'fix', item: ref, workType: stopLine.workType, stopLine: stopLine.rung, head: newHead, round, wrote: `comment ${commentId}`,
          });
          return { produced: true, summary: answered
            ? `round ${round}: answered at ${short(head)} without a code change, reply comment ${commentId}; the next pass re-reviews this head`
            : `round ${round}: ${short(head)} → ${short(newHead)}, reply comment ${commentId}; the next pass reviews the new head` };
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

/**
 * Why the loop will not act on an `apply-comment` label on a pull request it did not open, or
 * undefined when the label was applied by that pull request's author.
 *
 * Fails closed: a label whose applier cannot be read is not acted on, though the reason can pass.
 */
async function outsideRefusal(ctx: PassContext, pr: PullRequest): Promise<{ reason: string; final: boolean } | undefined> {
  let actor: string | undefined;
  try {
    actor = await ctx.store.labelActor(pr.number, APPLY_COMMENT_LABEL);
  } catch (err) {
    // The error text stays out of the reason: it varies pass to pass, and the reason is what the answer is keyed on.
    ctx.log(`fix: PR #${pr.number} apply-comment: could not read who applied the label: ${err instanceof Error ? err.message : String(err)}`);
    return {
      reason: 'apply-comment: the loop could not read who applied the label, '
        + 'and on a pull request it did not open it acts only when the pull request\'s author applied it',
      final: false,
    };
  }
  if (actor === undefined) {
    return { reason: 'apply-comment: the loop could not find who applied the label, and on a pull request it did not open it acts only when the pull request\'s author applied it', final: false };
  }
  if (actor.toLowerCase() !== pr.author.toLowerCase()) {
    return {
      reason: `apply-comment: ${actor} applied it, and ${pr.author || 'an account that no longer exists'} opened this pull request. The loop did not open it, so its author fixes it; `
        + 'it carries out apply-comment here only when the author applies the label and wrote the comment',
      final: true,
    };
  }
  return undefined;
}

/** What an `apply-comment` item owes the operator: an answer, naming their comment where one was waiting. */
const asking = (instruction?: { id: number }): OperatorAsk => ({ label: APPLY_COMMENT_LABEL, ...(instruction ? { comment: instruction.id } : {}) });

/** The operator's newest comment, unless a fix run has already been given it. */
function unconsumedInstruction(
  comments: ReadonlyArray<Comment>,
  /** On a pull request the loop did not open, only its author's comments count. */
  by?: string,
): Comment | undefined {
  const comment = operatorComment(comments, by);
  if (!comment) return undefined;
  return appliedComments(comments).includes(comment.id) ? undefined : comment;
}

/** What this fix run is answering, for the reason a person reads. */
function describe(review: { findings: number } | undefined, instruction: unknown): string {
  if (instruction) return 'an operator comment';
  return `findings=${review?.findings ?? 0}`;
}
