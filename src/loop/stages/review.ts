import { createHash } from 'node:crypto';
import type { ReviewerRelationship } from '../../eval/scorecard.js';
import {
  authorFamily, HUMAN_LABEL, outputPath, readOutput, runModel, short, stopLineOfPull, ticketOf, tierAvailability, whyNot,
  worktreeDir,
} from '../context.js';
import type { Comment, PullCommit, PullRequest, StoreReader } from '../github.js';
import {
  LOOP_SIGNATURE, markerAt, newestReview, newestReviewRestart, parseFixMarkers, parseReviewMarkers, renderReviewMarker, reviewMatchesBody,
} from '../markers.js';
import type { Family, LoopPolicy, ReviewTier } from '../policy.js';
import { familyOf, optionalNumericLimit, reviewTiersFor, rung, tierLabel } from '../policy.js';
import { reviewPrompt } from '../prompts.js';
import type { ActResult, Fault, Item, PassContext, StagePlan } from '../types.js';
import { REVIEW_AGAIN_LABEL, STATUS_SKIPPED, STATUS_STOPPED, STATUS_WORKING } from '../labels.js';
import type { StatusLabel } from '../labels.js';

const REVIEW_ACTIONS = ['review'] as const;

/**
 * How long one review run may take, in milliseconds. A `max`-effort model can use
 * most of a half hour on one pull request, and a provider retry restarts its turn,
 * so a review gets the same hour as the sweep and fix runs. A replayed review reuses it.
 */
export const REVIEW_TIMEOUT_MS = 3_600_000;

export interface ParsedFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
}

/** Findings as the side-effect-free replay prompt asks for them. */
export function parseFindings(review: string): ParsedFinding[] {
  const out: ParsedFinding[] = [];
  for (const m of review.matchAll(/^\s*\d+\.\s*\*{0,2}\[(critical|high|medium|low)\]\*{0,2}\s*(.+)$/gim)) {
    out.push({ severity: m[1]!.toLowerCase() as ParsedFinding['severity'], summary: m[2]!.trim() });
  }
  return out;
}

export interface ReviewResult {
  head: string;
  findings: number;
}

/** The live `/review-pr` wrapper's completion line. */
export function parseReviewResult(review: string): ReviewResult | undefined {
  const line = review.trimEnd().split(/\r?\n/).at(-1)?.trim();
  const match = line ? /^REVIEW_RESULT\s+head=([0-9a-f]{7,64})\s+findings=(\d+)$/.exec(line) : undefined;
  if (!match) return undefined;
  const findings = Number(match[2]);
  if (!Number.isSafeInteger(findings)) return undefined;
  return { head: match[1]!, findings };
}

/** The Loop limits rows that bound the loop's reviews of a pull request it did not open. */
export const OUTSIDE_REVIEWS_ROW = 'reviews per outside pull request';
export const OUTSIDE_QUIET_ROW = 'outside pull request quiet minutes';

export interface OutsideReviewRules {
  /** Heads the loop reviews before it leaves the pull request for a person. */
  reviews: number;
  /** How old a pull request's newest commit must be before the loop reviews it. */
  quietMinutes: number;
}

/** The two rows, or their defaults where the store configuration has none. */
export function outsideReviewRules(policy: LoopPolicy): OutsideReviewRules {
  return { reviews: optionalNumericLimit(policy, OUTSIDE_REVIEWS_ROW, 3), quietMinutes: optionalNumericLimit(policy, OUTSIDE_QUIET_ROW, 30) };
}

/**
 * How far a commit date may sit ahead of this machine's clock before it stops being
 * believed. Less is drift; more is a date nobody can wait out.
 */
const MAX_CLOCK_AHEAD_MS = 5 * 60_000;

const minutes = (ms: number): number => Math.ceil(ms / 60_000);

/**
 * Why the loop holds back from reviewing a pull request it did not open at its current head, if it does.
 *
 * Its author works on it in parallel and may push after every review, so two things end the
 * cycle. The loop stops after a fixed number of reviews at distinct heads, counted from its
 * run records because a review whose head moved under it left no comment; and it waits for the
 * newest commit to be old enough that a review has a head to settle on.
 */
async function outsideHold(
  ctx: PassContext, pr: PullRequest, comments: readonly Comment[], rules: OutsideReviewRules,
): Promise<{ reason: string; owner: StatusLabel } | undefined> {
  const head = pr.headRefOid.toLowerCase();
  const digest = createHash('sha256').update(pr.body).digest('hex');
  const reviews = ctx.commands.reviewsRun(ctx.slug, pr.number);
  const restart = newestReviewRestart(comments);
  const counted = reviews.slice(restart?.counted ?? 0).length;
  // A review is a head and a description: a commit or a description edit starts a new one. Only a
  // redo of what was already reviewed — the same head and description, as when an independent tier
  // became reachable for a not-independent review — adds nothing, so it cannot lengthen what the limit bounds.
  if (counted >= rules.reviews && !reviews.some((r) => r.head === head && r.bodyDigest === digest)) {
    const since = restart ? ` since the restart at ${short(restart.head)}` : '';
    const asked = (pr.labels ?? []).includes(REVIEW_AGAIN_LABEL);
    return {
      owner: STATUS_STOPPED,
      reason: `review limit reached (${counted}/${rules.reviews}): the loop did not open this pull request and has run ${counted} reviews of it${since}; `
        + `left for a person — ${asked ? `${REVIEW_AGAIN_LABEL} is on it, and the next real pass restarts the count` : `the ${REVIEW_AGAIN_LABEL} label allows ${rules.reviews} more`}`,
    };
  }
  const newest = (await ctx.commits(pr.number)).at(-1);
  const committed = Date.parse(newest?.committedDate ?? '');
  const age = Number.isFinite(committed) ? ctx.startedAt.getTime() - committed : undefined;
  const waitMs = rules.quietMinutes * 60_000;
  if (age !== undefined && age >= -MAX_CLOCK_AHEAD_MS && age < waitMs) {
    // Queued, not stopped: the loop reviews it once the wait is over, which is what `loop:working` says.
    return {
      owner: STATUS_WORKING,
      reason: `waiting for a quiet period: its newest commit ${short(newest!.oid)} is ${minutes(Math.max(0, age))} min old and the loop reviews a pull request it did not open `
        + `once that commit is ${rules.quietMinutes} min old, about ${minutes(waitMs - Math.max(0, age))} min more`,
    };
  }
  return undefined;
}

export type MarkerStanding =
  | { kind: 'on-pull' | 'replaced' | 'never' }
  | { kind: 'unreadable'; reason: string };

const namesCommit = (oid: string, sha: string): boolean => oid.toLowerCase().startsWith(sha.toLowerCase());

/**
 * Where the commit a review marker names stands against a pull request: among
 * its commits now, among those it had before a force-push replaced its head, or
 * never on it. A commit the pull request once had is the commits a replaced head
 * added to the base, so a base-branch commit the branch was built on does not
 * count. The force-push history is read only when the commits now do not name it.
 */
export async function markerStanding(
  store: Pick<StoreReader, 'replacedPullHeads' | 'commitsAbove'>,
  pr: Pick<PullRequest, 'number' | 'baseRefName'>,
  sha: string,
  current: PullCommit[],
): Promise<MarkerStanding> {
  if (current.some((c) => namesCommit(c.oid, sha))) return { kind: 'on-pull' };
  let unreadable: string | undefined;
  try {
    for (const replaced of new Set(await store.replacedPullHeads(pr.number))) {
      if (namesCommit(replaced, sha)) return { kind: 'replaced' };
      try {
        if ((await store.commitsAbove(pr.baseRefName, replaced)).some((oid) => namesCommit(oid, sha))) return { kind: 'replaced' };
      } catch (err) {
        unreadable ??= err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    unreadable ??= err instanceof Error ? err.message : String(err);
  }
  return unreadable === undefined ? { kind: 'never' } : { kind: 'unreadable', reason: unreadable };
}

const independentOf = (tier: ReviewTier, author: Family): boolean => familyOf(tier.runtime) !== author;
const REVIEW_PR_MARKER = /<!--\s*manifest-dev:review-pr(?:\s|--)/;
const JUDGMENT_MARKER = /<!--\s*manifest-dev:review-pr\s+judgment(?:\s|--)/;

async function verifiedFindingCount(ctx: PassContext, pr: PullRequest): Promise<number> {
  const threads = await ctx.store.reviewThreads(pr.number);
  return threads.filter((thread) => !thread.resolved && thread.comments.some((comment) => {
    // Judgment questions are non-blocking in review-pr and must not trigger a fix.
    if (JUDGMENT_MARKER.test(comment.body)) return false;
    if (!REVIEW_PR_MARKER.test(comment.body)) return false;
    return true;
  })).length;
}

/**
 * Rung 3: every open pull request against the base branch gets a review at its
 * current head from a model of a different family than the one that wrote it.
 *
 * The ladder is the store configuration's. Its independent rows are tried in
 * order; the author's own family runs only when none of them could run in this
 * pass, and its review is marked `independent=no`. `/review-pr` posts the
 * substantive review; the loop records the exact head and finding count it
 * returned for fix and merge.
 */
export async function planReview(ctx: PassContext): Promise<StagePlan> {
  const stageRung = rung(ctx.policy, 'reviewed');
  const plan: StagePlan = { stage: 'review', rung: stageRung, items: [], notes: [], faults: [] };

  const pulls = ctx.pulls.filter((p) => p.baseRefName === ctx.base).sort((a, b) => a.number - b.number);
  const outside = outsideReviewRules(ctx.policy);
  for (const pr of pulls) {
    const ref = `PR #${pr.number}`;
    const stopLine = await stopLineOfPull(ctx, pr);
    const skip = (reason: string, owner?: StatusLabel): void => {
      plan.items.push({ ref, stopLine, decision: { kind: 'skip', reason, ...(owner ? { owner } : {}) } });
    };
    if (stopLine.labels.includes(HUMAN_LABEL)) { skip('carries HUMAN — not store-defined, left for the operator', STATUS_SKIPPED); continue; }
    if (pr.isDraft) { skip('draft', STATUS_SKIPPED); continue; }
    if (stopLine.rung < stageRung.number) { skip(`stop-line ${stopLine.rung} below this stage (${stageRung.number})`, STATUS_STOPPED); continue; }

    const comments = await ctx.comments(pr.number);
    const newest = newestReview(comments);
    const head = pr.headRefOid;
    const reviewAt = comments.findLastIndex((c) => parseReviewMarkers(c.body).length > 0);
    // A fix round that answered at this head without changing code comes after the
    // review it answered; that review is then redone, with the answer in hand.
    const answeredAt = comments.findLastIndex((c) => parseFixMarkers(c.body)
      .some((m) => m.from === m.to && head.toLowerCase().startsWith(m.to.toLowerCase())));
    const answeredWithoutCode = answeredAt > reviewAt && reviewAt >= 0;
    const needsFreshReview = !reviewMatchesBody(newest, pr.body, true) || answeredWithoutCode;

    // A marker naming a commit the pull request never had credits a review to
    // code nobody read. A marker for an older commit on the branch, or for one a
    // force-push replaced, is just stale.
    if (newest && !markerAt(newest, head)) {
      const commits = await ctx.commits(pr.number);
      const standing = await markerStanding(ctx.store, pr, newest.sha, commits);
      if (standing.kind === 'never') {
        plan.faults.push({
          stage: 'review', kind: 'breach', subject: ref,
          detail: 'the newest review marker names a commit that is not on the pull request',
          evidence: `marker sha=${newest.sha}; pull request head ${head}; commits: ${commits.map((c) => short(c.oid)).join(' ')}`,
        });
      } else if (standing.kind === 'unreadable') {
        ctx.log(`review: ${ref}: could not check whether marker ${short(newest.sha)} names a commit the pull request once had (${standing.reason}); no breach raised this pass`);
      }
    }

    const { family, basis } = await authorFamily(ctx, pr);
    const tiers = reviewTiersFor(ctx.policy, family);
    const taskBase = `loop-review-pr${pr.number}-${short(head)}`;

    if (newest && markerAt(newest, head) && !needsFreshReview) {
      if (newest.independent) { skip(`reviewed at head (findings=${newest.findings})`); continue; }
      // Reviewed at head, but not independently. That stands only while no
      // independent tier is reachable; once one is, the review is redone by it.
      const reachable = await firstReachable(ctx, tiers.filter((t) => independentOf(t, family)), taskBase);
      // The loop writes a same-family review only when nothing independent could
      // run, and records the comment it posted. One that states independent=no and
      // is not in that record was written by something else, which is what the rule
      // forbids. A review from before independence was recorded states nothing.
      const reviewComment = [...comments].reverse().find((c) => parseReviewMarkers(c.body).length > 0);
      const byLoop = reviewComment !== undefined && ctx.commands.wroteComment(reviewComment.id);
      if (newest.stated && !byLoop) {
        plan.faults.push({
          stage: 'review', kind: 'breach', subject: ref,
          detail: 'the newest review at head is marked independent=no and was not the loop\'s fallback',
          evidence: `marker sha=${newest.sha} independent=no reviewer=${newest.reviewer ?? 'unnamed'}; author family ${family} (${basis}); comment ${reviewComment?.id ?? 'unknown'}`,
        });
      }
      if (!reachable.tier) {
        plan.items.push({ ref, stopLine, decision: { kind: 'blocked', reason: `reviewed at head, not independent; no independent tier reachable (${reachable.reasons.join('; ')})` } });
        continue;
      }
    }

    // Only a pull request the loop did not open: its author may push after every review.
    if (ticketOf(pr) === undefined) {
      const hold = await outsideHold(ctx, pr, comments, outside);
      if (hold) { skip(hold.reason, hold.owner); continue; }
    }

    // When the newest loop review sits at an older head — whoever pushed since — or a fix round
    // answered it at this head without changing code, this is a re-review: previous findings are
    // rechecked, and new ones block only in the change since unless high or critical.
    const priorContext = newest && (!markerAt(newest, head) || answeredWithoutCode) && reviewAt >= 0
      ? { reviewBody: comments[reviewAt]!.body, head: newest.sha, ...(answeredWithoutCode ? { answer: comments[answeredAt]!.body } : {}) }
      : undefined;

    const item: Item = {
      ref,
      stopLine,
      decision: { kind: 'dispatch', detail: `${newest ? `last reviewed at ${short(newest.sha)}` : 'never reviewed'}; author ${family} (${basis})` },
    };
    item.act = () => reviewOne(ctx, pr, family, tiers, taskBase, stopLine.workType, stopLine.rung, priorContext);
    plan.items.push(item);
  }

  // A dry run says which tier each review would go to, or why none can.
  if (ctx.options.dryRun) {
    for (const item of plan.items) {
      if (item.decision.kind !== 'dispatch') continue;
      const pr = pulls.find((p) => `PR #${p.number}` === item.ref)!;
      const { family } = await authorFamily(ctx, pr);
      const tiers = reviewTiersFor(ctx.policy, family);
      const reachable = await firstReachable(ctx, tiers, `loop-review-pr${pr.number}-${short(pr.headRefOid)}`);
      item.decision = reachable.tier
        ? { kind: 'dispatch', detail: `${item.decision.detail}; would review on ${tierLabel(reachable.tier)}, independent=${independentOf(reachable.tier, family) ? 'yes' : 'no'}` }
        : { kind: 'blocked', reason: `tier unavailable: ${reachable.reasons.join('; ')}` };
    }
  }
  return plan;
}

async function firstReachable(ctx: PassContext, tiers: ReviewTier[], taskBase: string): Promise<{ tier?: ReviewTier; reasons: string[] }> {
  const reasons: string[] = [];
  for (const tier of tiers) {
    const available = await tierAvailability(ctx, 'review', tier, `${taskBase}-t${tier.order}`, [...REVIEW_ACTIONS], 'review-pr');
    if (available.ok) return { tier, reasons };
    reasons.push(`${tierLabel(tier)}: ${available.reason}`);
  }
  return { reasons };
}

async function reviewOne(
  ctx: PassContext, pr: PullRequest, family: Family, tiers: ReviewTier[], taskBase: string, workType: string, stopLine: number,
  priorContext?: { reviewBody: string; head: string; answer?: string },
): Promise<ActResult> {
  const head = pr.headRefOid;
  const bodyDigest = createHash('sha256').update(pr.body).digest('hex');
  const unchanged = async (): Promise<boolean> => {
    const live = (await ctx.store.pullsFromHead(pr.headRefName)).find((p) => p.number === pr.number && p.state === 'OPEN');
    return live?.headRefOid === head && live.body === pr.body;
  };
  const dir = worktreeDir(ctx, `review-${pr.number}`);
  await ctx.repo.fetch([`+refs/pull/${pr.number}/head:refs/remotes/origin/pr/${pr.number}`, ctx.base]);
  await ctx.repo.addWorktree(dir, head);
  const faults: Fault[] = [];
  try {
    const unreachable: string[] = [];
    // Independent rows first, in the table's order; the author's family only after all of them.
    const ordered = [...tiers.filter((t) => independentOf(t, family)), ...tiers.filter((t) => !independentOf(t, family))];
    for (const tier of ordered) {
      if (!await unchanged()) {
        return { produced: false, summary: 'PR changed before review dispatch', blocked: 'description or head changed; review the current PR in a new pass', faults };
      }
      const independent = independentOf(tier, family);
      const taskId = `${taskBase}-t${tier.order}`;
      const out = outputPath(ctx, taskId);
      const result = await runModel(ctx, {
        outputPath: out, loop: { stage: 'review', item: `PR #${pr.number}`, workType, stopLine, head, bodyDigest, independent },
        stage: 'review', template: 'review', tier, taskId, cwd: dir, actions: [...REVIEW_ACTIONS], entry: 'review-pr', timeoutMs: REVIEW_TIMEOUT_MS,
        prompt: reviewPrompt({ repo: ctx.slug, pr: { number: pr.number, title: pr.title, body: pr.body, base: ctx.base }, head, outputPath: out,
          ...(priorContext ? { previousReviewBody: priorContext.reviewBody, previousHead: priorContext.head } : {}),
          ...(priorContext?.answer ? { fixAnswer: priorContext.answer } : {}) }),
      });
      const text = result.outcome.kind === 'completed' ? readOutput(out, result) : undefined;
      if (!text) {
        // A tier that could not start — no authority, not ready, admission or a
        // usage limit refused it — was unreachable, and the ladder steps down. A
        // tier that ran and failed was reachable: stepping down to the author's
        // family then would be exactly the review the store configuration forbids.
        const couldNotStart = !result.runtimeDispatched || result.outcome.kind === 'quota-waiting' || result.outcome.kind === 'setup-blocked'
          || (result.outcome.kind === 'checks-failed' && result.outcome.promptNotSent === true);
        unreachable.push(`${tierLabel(tier)}: ${whyNot(result)}`);
        if (couldNotStart) continue;
        return { produced: false, summary: `the review on ${tierLabel(tier)} ran and produced nothing`, blocked: `review failed: ${whyNot(result)}`, faults };
      }

      const review = parseReviewResult(text);
      if (!review) {
        return {
          produced: false,
          summary: 'the /review-pr run finished without a REVIEW_RESULT line',
          blocked: 'review output must end with a full-head REVIEW_RESULT line',
          faults,
        };
      }
      if (!head.toLowerCase().startsWith(review.head.toLowerCase())) {
        return {
          produced: false,
          summary: `the /review-pr result names ${short(review.head)}, not the checked-out head ${short(head)}`,
          blocked: 'review output names a different head; the result was not recorded',
          faults,
        };
      }

      let findings = review.findings;
      if (findings === 0) {
        try {
          findings = await verifiedFindingCount(ctx, pr);
        } catch (err) {
          return {
            produced: false,
            summary: 'the /review-pr run reported a clean result, but active review threads could not be verified',
            blocked: err instanceof Error ? err.message : String(err),
            faults,
          };
        }
      }
      if (!await unchanged()) {
        return { produced: false, summary: 'PR changed during review', blocked: 'description or head changed; the review result was not recorded', faults };
      }
      const reviewer = `${tier.model}·${tier.effort}`;
      // `/review-pr` owns the substantive GitHub review. This comment is only
      // the loop's durable handoff to fix/merge, carrying its cycle summary and
      // the fields those stages need without masquerading as another review.
      const body = `${text}\n\n${renderReviewMarker({ sha: head, findings, independent, reviewer, bodyDigest })}\n— ${reviewer} on ${tier.runtime}, ${LOOP_SIGNATURE} in pass ${ctx.passId}\n`;
      const commentId = await ctx.store.createComment(pr.number, body);

      // Whatever the table says, what ran is what the scorecard reports; a run whose
      // observed model is not the tier's is a dispatch the table does not carry.
      const observed = result.run?.settings.observed.model;
      if (observed && observed !== 'unknown' && observed !== tier.model) {
        faults.push({
          stage: 'review', kind: 'breach', subject: `PR #${pr.number}`,
          detail: `the review ran on ${observed}, which is not the tier the store configuration names`,
          evidence: `dispatched ${tierLabel(tier)} (${tier.line}); run ${result.run?.id} observed ${observed}`,
        });
      }

      const relationship: ReviewerRelationship = independent ? 'independent' : 'not-independent';
      ctx.commands.recordReview(taskId, {
        author: `${family}-family author of PR #${pr.number}`,
        reviewer: { id: `${tier.runtime}:${tier.model}:${result.run?.sessionId ?? result.run?.id ?? taskId}`, relationship },
        source: `https://github.com/${ctx.slug}/pull/${pr.number}`,
        head,
        findings: [],
        findingCount: findings,
      });
      ctx.commands.recordLoop(taskId, {
        stage: 'review', item: `PR #${pr.number}`, workType, stopLine, head, independent, findings, wrote: `comment ${commentId}`,
      });
      const fellBack = independent ? '' : ` — not independent; every independent tier was unreachable (${unreachable.join('; ')})`;
      return { produced: true, summary: `/review-pr completed; loop record comment ${commentId}: findings=${findings} on ${tierLabel(tier)}${fellBack}`, faults };
    }
    return { produced: false, summary: 'no tier produced a review', blocked: `tier unavailable: ${unreachable.join('; ')}`, faults };
  } finally {
    await ctx.repo.removeWorktree(dir);
  }
}
