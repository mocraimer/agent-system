import type { Scorecard } from '../eval/scorecard.js';
import { findingsAcceptedAt, fixRounds, markerAt, newestReview, parseFaultMarker, reviewMatchesBody } from '../loop/markers.js';
import { ACCEPT_FINDINGS_LABEL, HUMAN_LABEL, REVIEW_AGAIN_LABEL, STATUS_STOPPED } from '../loop/labels.js';
import type { LoopPolicy } from '../loop/policy.js';
import { resolveStopLine } from '../loop/policy.js';
import type { Classification, PassReport } from '../loop/supervisor.js';
import type { IssueFact, PullFact, SnapshotRead } from './snapshot.js';
import type { VerdictRecord } from './verdicts.js';
import { derivationContext, verdictsFor } from './verdicts.js';

/**
 * The board: every open ticket and pull request of the target store, placed in
 * one column for a stated reason, and the system's state in one line.
 *
 * Pure: it reads a snapshot of the store and the coordinator's records and
 * stores nothing. The console, the inbox and the loop's own notifications are all
 * views over what this returns.
 */

export type Column = 'Working' | 'Needs you' | 'In review' | 'Ready to merge' | 'not in play';
export const COLUMNS: readonly Column[] = ['Working', 'Needs you', 'In review', 'Ready to merge'];

/** The one thing the operator can do about a Needs-you item from the inbox. */
export type ActionKind =
  | 'apply-shaped' | 'apply-auto' | 'merge' | 'close-not-planned' | 'close-completed'
  | 'release-claim' | 'dismiss-fault' | 'answer-escalation' | 'open';

export interface BoardItem {
  /** `#123` or `PR #456`. */
  ref: string;
  kind: 'issue' | 'pull';
  number: number;
  title: string;
  /** Store timestamps; absence means the item age is unknown, not fresh. */
  createdAt?: string;
  updatedAt?: string;
  column: Column;
  /** The fact that placed it: a label event, a marker, a check conclusion, a run, a claim. */
  because: string;
  /** Needs-you and Ready-to-merge items: what it waits for, and the one action. */
  waitsFor?: string;
  action?: ActionKind;
  /** What the action acts on when it is not the item itself: a claim comment, an assignee. */
  actionTarget?: string;
  /** Scorecards about this item, newest first, for Inspect and the explicit verdict. */
  cards: string[];
  url: string;
}

export type SystemStateName = 'Nothing to do' | 'Waiting' | 'Progress' | 'Stalled' | 'Breach' | 'No pass yet' | 'Needs you' | 'Blocked' | 'Unknown';

export interface SystemState {
  name: SystemStateName;
  /** The current operator-facing reason, not just the last loop classification. */
  because: string;
  /** Loop activity is separate from the number of decisions waiting on a person. */
  loop: { status: 'running' | 'blocked' | 'waiting' | 'unknown'; running: number; blocked: number };
  lastPass?: { id: string; endedAt: string; classification: Classification; dryRun: boolean };
}

export interface RunInFlight {
  runId: string;
  taskId: string;
  runtime: string;
  startedAt: string;
}

/** The coordinator's side of the facts. */
export interface CoordinatorFacts {
  runsInFlight: RunInFlight[];
  scorecards: Scorecard[];
  lastPass?: PassReport;
  paused: Record<string, { by: string; at: string }>;
}

/** The target repository's own markers, from its queue modules. */
export interface StoreRules {
  SHAPE_MARKER: string;
  issueBodyHash(body: string): string;
  readShapeFingerprint(commentBody: string): string | null;
  isClaim(commentBody: string): boolean;
}

export interface Board {
  repo: string;
  /** When the snapshot behind the columns was read. */
  snapshotAt?: string;
  /** Set when the latest read failed: the columns are the last good snapshot's, or empty when there is none. */
  stale?: { error: string; ageSeconds?: number; failedAt: string };
  state: SystemState;
  items: BoardItem[];
  counts: Record<Column, number>;
  verdicts: VerdictRecord[];
  paused: Record<string, { by: string; at: string }>;
}

export interface BoardInput {
  read: SnapshotRead;
  coordinator: CoordinatorFacts;
  rules: StoreRules;
  policy: LoopPolicy;
}

const DEV_RUNG = 'dev';
const TRACKING_LABEL = 'effort';

/** Which stage's task ids belong to an item, so a run in flight can be matched to it. */
function tasksFor(kind: 'issue' | 'pull', n: number): RegExp {
  return kind === 'issue' ? new RegExp(`^loop-(sweep|shape)-${n}(-|$)`) : new RegExp(`^loop-(review|fix|merge)-pr${n}-`);
}

function cardsFor(cards: Scorecard[], ref: string): string[] {
  return cards.filter((c) => c.loop?.item === ref).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => c.id);
}

function placeIssue(issue: IssueFact, input: BoardInput, openPulls: PullFact[], closedPulls: PullFact[]): Omit<BoardItem, 'ref' | 'kind' | 'number' | 'title' | 'cards' | 'url'> {
  const { rules } = input;
  const labels = issue.labels;
  const needs = (waitsFor: string, action: ActionKind, because: string, actionTarget?: string) => ({
    column: 'Needs you' as const, waitsFor, action, because, ...(actionTarget ? { actionTarget } : {}),
  });

  if (parseFaultMarker(issue.body) !== undefined) {
    return needs('a person to read the fault and close it', 'dismiss-fault', `the loop's fault issue: ${issue.title}`);
  }
  if (labels.includes(TRACKING_LABEL)) return { column: 'not in play', because: `tracking issue (label \`${TRACKING_LABEL}\`)` };
  if (labels.includes('question')) return { column: 'not in play', because: 'question ticket (label `question`)' };
  if (labels.includes('escalated')) {
    const at = [...issue.events].reverse().find((e) => e.type === 'labeled' && e.label === 'escalated');
    return needs('an answer to the escalation', 'answer-escalation', `labeled escalated${at ? ` by ${at.actor} ${at.at}` : ''}`);
  }
  const running = input.coordinator.runsInFlight.find((r) => tasksFor('issue', issue.number).test(r.taskId));
  if (running) return { column: 'Working', because: `run ${running.runId} (${running.taskId}) in flight on ${running.runtime} since ${running.startedAt}` };
  if (issue.assignees.length > 0) {
    return needs(`the assignee (${issue.assignees.join(', ')}) or a release back to the loop`, 'release-claim', `human assignee: ${issue.assignees.join(', ')}`, `assignee:${issue.assignees.join(',')}`);
  }
  if (labels.includes('HUMAN')) return { column: 'not in play', because: 'label HUMAN: left to a person, outside the loop' };

  const claim = issue.comments.filter((c) => rules.isClaim(c.body)).pop();
  if (claim) {
    const open = openPulls.find((p) => p.headRefName === `ticket/${issue.number}`);
    if (open) return { column: 'not in play', because: `claimed; its pull request #${open.number} is on the board` };
    const merged = closedPulls.find((p) => p.headRefName === `ticket/${issue.number}` && p.state === 'MERGED');
    if (merged) {
      return needs('closing: its pull request merged', 'close-completed', `claimed; pull request #${merged.number} merged${merged.mergedBy ? ` by ${merged.mergedBy}` : ''}${merged.mergedAt ? ` ${merged.mergedAt}` : ''}`);
    }
    return { column: 'Working', because: `claimed by the loop (comment ${claim.id}, ${claim.createdAt}); no run in flight — the next pass recovers it` };
  }

  const inEffort = labels.some((l) => l.startsWith('effort:'));
  if (labels.includes('shaped')) {
    if (labels.includes('auto')) return { column: 'not in play', because: inEffort ? 'granted `auto`; queued for the sweep' : 'granted `auto` but in no effort; the sweep passes it over' };
    if (!inEffort) return { column: 'not in play', because: 'shaped, in no effort; no assessment covers it' };
    const shaped = [...issue.events].reverse().find((e) => e.type === 'labeled' && e.label === 'shaped');
    return needs('a decision on `auto`', 'apply-auto', `labeled shaped${shaped ? ` by ${shaped.actor} ${shaped.at}` : ''}; assessment awaits a grant`);
  }
  const proposal = issue.comments.filter((c) => c.body.includes(rules.SHAPE_MARKER)).pop();
  if (proposal && rules.readShapeFingerprint(proposal.body) === rules.issueBodyHash(issue.body)) {
    return needs('`shaped`, or closing as not planned', 'apply-shaped', `proposal comment ${proposal.id} matches the current body`);
  }
  return { column: 'not in play', because: proposal ? 'proposal stale: the body changed since; queued for the shape stage' : 'no proposal yet; queued for the shape stage' };
}

function placePull(pr: PullFact, input: BoardInput, fixCap: number | undefined): Omit<BoardItem, 'ref' | 'kind' | 'number' | 'title' | 'cards' | 'url'> {
  const head = pr.headRefOid;
  const short = head.slice(0, 8);
  if (pr.isDraft) return { column: 'not in play', because: 'draft' };
  const releaseBranch = input.policy.protocol.releaseBranch.value;
  if (pr.baseRefName === releaseBranch) return { column: 'not in play', because: `into ${releaseBranch}: only a person merges it, on GitHub` };
  const ticket = /^ticket\/(\d+)$/.exec(pr.headRefName);
  // Closed ticket labels still govern its open pull request.
  const issue = ticket ? [...(input.read.snapshot?.issues ?? []), ...(input.read.snapshot?.referencedIssues ?? [])].find((i) => i.number === Number(ticket[1])) : undefined;
  if ([...(pr.labels ?? []), ...(issue?.labels ?? [])].includes(HUMAN_LABEL)) {
    return { column: 'Needs you', waitsFor: 'the operator; the HUMAN hold keeps this outside the loop', action: 'open', because: 'carries HUMAN; no automated fix or merge is offered' };
  }
  if (pr.checks === 'failure') {
    return { column: 'Needs you', waitsFor: 'a look at the failing checks', action: 'open', because: `checks failed at ${short}` };
  }
  const running = input.coordinator.runsInFlight.find((r) => tasksFor('pull', pr.number).test(r.taskId));
  if (running) return { column: 'Working', because: `run ${running.runId} (${running.taskId}) in flight on ${running.runtime} since ${running.startedAt}` };

  const review = newestReview(pr.comments);
  const attested = input.coordinator.scorecards.filter((c) => c.repo === input.read.snapshot?.repo)
    .flatMap((c) => c.attestedDeliveries ?? (c.loop?.attestedDelivery ? [c.loop.attestedDelivery] : []))
    .filter((d) => d.kind === 'description' && d.pr === pr.number && d.head === head)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (review && markerAt(review, head) && !reviewMatchesBody(review, pr.body ?? '', true)) {
    return { column: 'In review', because: `The review does not establish it covers the current description at ${short}; an independent review of these bytes is needed. This is not a clean review.` };
  }
  if (!review || !markerAt(review, head)) {
    // A pull request the loop did not open that it has stopped reviewing is waiting on a person, not on a review.
    if (!ticket && (pr.labels ?? []).includes(REVIEW_AGAIN_LABEL)) {
      return { column: 'In review', because: `${REVIEW_AGAIN_LABEL} is on it; the next pass restarts the review count (head ${short})` };
    }
    if (!ticket && (pr.labels ?? []).includes(STATUS_STOPPED)) {
      return {
        column: 'Needs you', waitsFor: 'a person: the loop has stopped reviewing this pull request', action: 'open',
        because: `carries ${STATUS_STOPPED} and no review at ${short}; the pass log says why, and ${REVIEW_AGAIN_LABEL} brings back a pull request stopped at its review limit`,
      };
    }
    return { column: 'In review', because: review ? `review pending: the newest review is at ${review.sha.slice(0, 8)}, the head is ${short}` : `review pending: never reviewed (head ${short})` };
  }
  const accepted = findingsAcceptedAt(pr.comments, head);
  const marker = `findings=${review.findings} independent=${review.independent ? 'yes' : 'no'} sha=${review.sha.slice(0, 8)}${accepted ? '; findings accepted by the operator for this head' : ''}`;
  if (review.findings > 0 && !accepted && (pr.labels ?? []).includes(ACCEPT_FINDINGS_LABEL)) {
    return { column: 'In review', because: `${marker}; acceptance instruction has not been pinned to this head by the loop` };
  }
  if (review.findings > 0 && !accepted) {
    const rounds = fixRounds(pr.comments);
    const roundCount = Math.max(rounds.length, attested?.round ?? 0);
    const last = rounds[rounds.length - 1];
    if (!ticket) return { column: 'Needs you', waitsFor: 'its author to fix the findings', action: 'open', because: `${marker}; not a pull request the loop opened` };
    if (last && head.toLowerCase().startsWith(last.from.toLowerCase()) && last.from === last.to && (attested?.round ?? 0) <= last.round) {
      return { column: 'Needs you', waitsFor: 'a person: the last fix pushed nothing', action: 'open', because: `${marker}; round ${last.round} left the head at ${short}` };
    }
    if (fixCap !== undefined && roundCount >= fixCap) {
      return { column: 'Needs you', waitsFor: 'a person: the fix round cap is reached', action: 'open', because: `${marker}; ${roundCount}/${fixCap} fix rounds` };
    }
    return { column: 'In review', because: `${marker}; fix round ${roundCount + 1} next` };
  }
  if (!review.independent) return { column: 'In review', because: `${marker}; waiting for an independent reviewer` };
  if (pr.checks === 'pending' || pr.checks === 'none' || pr.mergeable !== 'MERGEABLE') {
    return { column: 'In review', because: `${marker}; checks ${pr.checks}, mergeable ${pr.mergeable.toLowerCase()}` };
  }
  const devRung = input.policy.rungs.find((r) => r.name === DEV_RUNG)?.number;
  const stop = resolveStopLine(input.policy, ticket ? issue?.labels ?? [] : []);
  if (ticket && devRung !== undefined && stop.rung >= devRung) {
    return {
      column: 'Ready to merge', waitsFor: 'the merge stage, on the next pass or now', action: 'merge',
      because: `${marker}; checks green, mergeable; stop-line ${stop.rung} reaches ${DEV_RUNG} (${stop.line})`,
    };
  }
  // The console merges only through the merge stage, which never goes below the
  // work's stop-line; below it, merging is a person's act on GitHub.
  return {
    column: 'Needs you',
    waitsFor: 'a person to merge it on GitHub',
    action: 'open',
    because: `${marker}; checks green, mergeable; ${ticket ? `stop-line ${stop.rung} stops below ${DEV_RUNG}, where the merge stage cannot go` : 'not a pull request the loop opened'}`,
  };
}

function systemState(input: BoardInput, counts: Record<Column, number>): SystemState {
  const { lastPass: last, runsInFlight } = input.coordinator;
  const running = runsInFlight.length;
  const blocked = last?.stages.reduce((n, stage) => n + stage.counts.blocked, 0) ?? 0;
  const loop: SystemState['loop'] = { status: blocked || last?.classification === 'blocked' ? 'blocked' : running ? 'running' : last ? 'waiting' : 'unknown', running, blocked };
  const details = { loop, ...(last ? { lastPass: { id: last.passId, endedAt: last.endedAt, classification: last.classification, dryRun: last.dryRun } } : {}) };
  if (input.read.stale) return { name: 'Unknown', because: `The latest read failed; the displayed store may be stale: ${input.read.stale.error}`, ...details };
  if (last?.classification === 'breach') return { name: 'Breach', because: last.because, ...details };
  if (last?.classification === 'stalled') return { name: 'Stalled', because: last.because, ...details };
  if (blocked || last?.classification === 'blocked') return { name: 'Blocked', because: blocked ? `${blocked} technical blocker(s) in the last pass; ${counts['Needs you']} item(s) need your decision.` : last!.because, ...details };
  if (counts['Needs you']) return { name: 'Needs you', because: `${counts['Needs you']} item(s) need your decision; ${running} recorded run(s) active.`, ...details };
  if (running) return { name: 'Progress', because: `${running} recorded run(s) active.`, ...details };
  const queued = counts.Working + counts['In review'] + counts['Ready to merge'];
  if (queued) return { name: 'Waiting', because: `${queued} item(s) awaiting loop work or review; no recorded run active.`, ...details };
  if (!last) return { name: 'No pass yet', because: 'the loop has recorded no pass for this repository', ...details };
  const name: SystemStateName = last.classification === 'idle-empty' ? 'Nothing to do' : last.classification === 'waiting' ? 'Waiting' : 'Progress';
  return { name, because: last.because, ...details };
}

/** Build the board. With no snapshot at all the columns are empty and `stale` says why; nothing is invented. */
export function buildBoard(input: BoardInput): Board {
  const { read, coordinator, policy } = input;
  const snapshot = read.snapshot;
  const fixCapRow = policy.limits.get('fix rounds per pull request');
  const fixCap = fixCapRow ? Number(fixCapRow.value) : undefined;
  const items: BoardItem[] = [];
  if (snapshot) {
    const base = `https://github.com/${snapshot.repo}`;
    for (const issue of [...snapshot.issues].sort((a, b) => a.number - b.number)) {
      const ref = `#${issue.number}`;
      items.push({ ref, kind: 'issue', number: issue.number, title: issue.title, ...(issue.createdAt ? { createdAt: issue.createdAt } : {}), ...(issue.updatedAt ? { updatedAt: issue.updatedAt } : {}), ...placeIssue(issue, input, snapshot.pulls, snapshot.referencedPulls), cards: cardsFor(coordinator.scorecards, ref), url: `${base}/issues/${issue.number}` });
    }
    for (const pr of [...snapshot.pulls].sort((a, b) => a.number - b.number)) {
      const ref = `PR #${pr.number}`;
      const ticket = /^ticket\/(\d+)$/.exec(pr.headRefName)?.[1];
      const cards = [...cardsFor(coordinator.scorecards, ref), ...(ticket ? cardsFor(coordinator.scorecards, `#${ticket}`).filter((id) => id.startsWith('card_loop-sweep-')) : [])];
      items.push({ ref, kind: 'pull', number: pr.number, title: pr.title, ...(pr.createdAt ? { createdAt: pr.createdAt } : {}), ...(pr.updatedAt ? { updatedAt: pr.updatedAt } : {}), ...placePull(pr, input, Number.isInteger(fixCap) ? fixCap : undefined), cards, url: `${base}/pull/${pr.number}` });
    }
  }
  const counts = { Working: 0, 'Needs you': 0, 'In review': 0, 'Ready to merge': 0, 'not in play': 0 } as Record<Column, number>;
  for (const item of items) counts[item.column]++;
  // A stale snapshot is shown, but nothing is derived from it: a verdict read off
  // old state could credit a merge that has since been reverted, or miss a close.
  const ctx = snapshot && !read.stale ? derivationContext(snapshot, input.rules.SHAPE_MARKER) : undefined;
  return {
    repo: snapshot?.repo ?? coordinator.lastPass?.repo ?? '',
    ...(snapshot ? { snapshotAt: snapshot.takenAt } : {}),
    ...(read.stale ? { stale: read.stale } : {}),
    state: systemState(input, counts),
    items,
    counts,
    verdicts: verdictsFor(coordinator.scorecards.filter((c) => !snapshot || c.repo === snapshot.repo), ctx),
    paused: coordinator.paused,
  };
}

/** The issue and pull-request numbers the loop's scorecards name, so the snapshot reads the closed ones too. */
export function referencedNumbers(cards: Scorecard[]): { issues: number[]; pulls: number[] } {
  const issues = new Set<number>();
  const pulls = new Set<number>();
  for (const card of cards) {
    const loop = card.loop;
    if (!loop) continue;
    const n = Number(/#(\d+)/.exec(loop.item)?.[1]);
    if (!Number.isInteger(n)) continue;
    if (loop.item.startsWith('PR #')) pulls.add(n);
    else issues.add(n);
    const wrote = /^PR #(\d+)$/.exec(loop.wrote ?? '');
    if (wrote) pulls.add(Number(wrote[1]));
  }
  return { issues: [...issues].sort((a, b) => a - b), pulls: [...pulls].sort((a, b) => a - b) };
}
