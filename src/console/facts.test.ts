import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderAcceptedMarker, renderFaultMarker, renderFixMarker, renderReviewMarker } from '../loop/markers.js';
import { parseStoreConfig } from '../loop/policy.js';
import { fixtureStoreConfig, SHA } from '../loop/testkit.js';
import type { Board, BoardInput } from './facts.js';
import { buildBoard, referencedNumbers } from './facts.js';
import { renderBoard } from './print.js';
import type { SnapshotSource, StoreSnapshot } from './snapshot.js';
import { GhSnapshotSource, LastGoodSnapshot, toIssueFact, toPullFact } from './snapshot.js';
import {
  card, claim, comment, coordinator, issue, pass, proposal, pull, review, RULES, snapshot,
} from './testkit.js';
import {
  countVerdicts, currentVerdict, DERIVATION_RULES, derivationContext, renderVerdictCounts, tallyFindings, verdictsFor,
} from './verdicts.js';

const POLICY = parseStoreConfig(fixtureStoreConfig({ typeRows: ['| `type:bug` | 3 |', '| `type:chore` | 5 |'] }));

function board(snap: StoreSnapshot, over: Partial<BoardInput> = {}): Board {
  return buildBoard({ read: { snapshot: snap }, coordinator: coordinator(), rules: RULES, policy: POLICY, ...over });
}

const placed = (b: Board, ref: string) => {
  const item = b.items.find((i) => i.ref === ref);
  assert.ok(item, `${ref} is on the board`);
  return item;
};

/* ------------------------------------------------------------------ AC-1.1 */

describe('every open ticket and pull request lands in exactly one column for a stated reason', () => {
  it('lists each open issue and pull request once', () => {
    const b = board(snapshot({ issues: [issue(1), issue(2)], pulls: [pull(101)] }));
    assert.deepEqual(b.items.map((i) => i.ref), ['#1', '#2', 'PR #101']);
    const total = Object.values(b.counts).reduce((a, c) => a + c, 0);
    assert.equal(total, 3);
    for (const item of b.items) assert.notEqual(item.because.trim(), '', `${item.ref} states why it is where it is`);
  });

  it('carries recorded item dates without assigning an invented age to legacy items', () => {
    const b = board(snapshot({
      issues: [issue(1, { createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' }), issue(2)],
      pulls: [pull(101, { createdAt: '2026-09-19T00:00:00Z' })],
    }));
    assert.equal(placed(b, '#1').createdAt, '2026-09-20T00:00:00Z');
    assert.equal(placed(b, '#1').updatedAt, '2026-09-21T00:00:00Z');
    assert.equal(placed(b, 'PR #101').createdAt, '2026-09-19T00:00:00Z');
    assert.equal(placed(b, '#2').updatedAt, undefined);
  });

  it('keeps an operator-attested description repair in review until a newer same-head review', () => {
    const pr = pull(101, { body: 'Corrected description.', checks: 'pending' });
    const first = review(pr.headRefOid, 1);
    pr.comments = [first];
    const digest = createHash('sha256').update(pr.body!).digest('hex');
    const attested = card('card_attested-fix', { stage: 'fix', item: 'PR #101', workType: 'bug',
      attestedDelivery: { runId: 'run_attested-fix', kind: 'description', pr: 101, head: pr.headRefOid,
        bodyDigest: digest, reviewCommentAtAttestation: first.id, round: 1, by: 'operator', reason: 'I checked the worker output and PR body', at: '2026-09-18T11:00:00Z' } });
    const facts = { coordinator: coordinator({ scorecards: [attested] }) };
    const pending = placed(board(snapshot({ issues: [issue(1, { labels: ['type:chore'] })], pulls: [pr] }), facts), 'PR #101');
    assert.equal(pending.column, 'In review');
    assert.match(pending.because, /does not establish it covers the current description/);
    const laterCard = { ...attested, loop: { stage: 'fix', item: 'PR #101', workType: 'bug' },
      attestedDeliveries: [attested.loop!.attestedDelivery!] };
    assert.match(placed(board(snapshot({ issues: [issue(1, { labels: ['type:chore'] })], pulls: [pr] }),
      { coordinator: coordinator({ scorecards: [laterCard] }) }), 'PR #101').because, /does not establish it covers the current description/,
    'a later retry does not hide the earlier attested body repair');
    pr.comments.push(review(pr.headRefOid, 0));
    assert.match(placed(board(snapshot({ issues: [issue(1, { labels: ['type:chore'] })], pulls: [pr] }), facts), 'PR #101').because, /does not establish it covers the current description/,
      'a newer marker without body evidence cannot clear the attestation hold');
    pr.comments.push(comment(renderReviewMarker({ sha: pr.headRefOid, findings: 0, independent: true,
      reviewer: 'model·high', bodyDigest: digest })));
    const waiting = placed(board(snapshot({ issues: [issue(1, { labels: ['type:chore'] })], pulls: [pr] }), facts), 'PR #101');
    assert.equal(waiting.column, 'In review');
    assert.match(waiting.because, /checks pending/);
    assert.notEqual(waiting.action, 'merge');
    pr.checks = 'success';
    const ready = placed(board(snapshot({ issues: [issue(1, { labels: ['type:chore'] })], pulls: [pr] }), facts), 'PR #101');
    assert.equal(ready.column, 'Ready to merge');
    assert.equal(ready.action, 'merge');
  });

  it('a current proposal waits on `shaped`', () => {
    const body = 'the ticket';
    const item = placed(board(snapshot({ issues: [issue(1, { body, comments: [proposal(body)] })] })), '#1');
    assert.equal(item.column, 'Needs you');
    assert.equal(item.action, 'apply-shaped');
    assert.match(item.because, /proposal comment \d+ matches the current body/);
  });

  it('a stale or missing proposal is queued for the shape stage, not in play', () => {
    const stale = placed(board(snapshot({ issues: [issue(1, { body: 'new', comments: [proposal('old')] })] })), '#1');
    assert.equal(stale.column, 'not in play');
    assert.match(stale.because, /proposal stale/);
    assert.match(placed(board(snapshot({ issues: [issue(2)] })), '#2').because, /no proposal yet/);
  });

  it('a shaped ticket in an effort waits on `auto`, naming the label event', () => {
    const item = placed(board(snapshot({ issues: [issue(1, {
      labels: ['shaped', 'effort:e'], events: [{ type: 'labeled', label: 'shaped', actor: 'octocat', at: '2026-09-13T17:49:00Z' }],
    })] })), '#1');
    assert.equal(item.column, 'Needs you');
    assert.equal(item.action, 'apply-auto');
    assert.match(item.because, /labeled shaped by octocat 2026-09-13T17:49:00Z/);
  });

  it('a granted ticket is queued for the sweep; tracking issues and questions are not in play', () => {
    const b = board(snapshot({ issues: [
      issue(1, { labels: ['shaped', 'auto', 'effort:e'] }), issue(2, { labels: ['effort', 'effort:e'] }), issue(3, { labels: ['question'] }),
    ] }));
    assert.equal(placed(b, '#1').column, 'not in play');
    assert.match(placed(b, '#1').because, /queued for the sweep/);
    assert.match(placed(b, '#2').because, /tracking issue/);
    assert.match(placed(b, '#3').because, /question ticket/);
  });

  it('escalations, human assignees and the loop\'s fault issues need the operator, each with its action', () => {
    const b = board(snapshot({ issues: [
      issue(1, { labels: ['escalated'] }), issue(2, { assignees: ['someone'] }), issue(3, { title: '[loop] sweep stalled', body: `${renderFaultMarker('a'.repeat(32))}\nfault` }),
    ] }));
    assert.deepEqual([placed(b, '#1').action, placed(b, '#2').action, placed(b, '#3').action], ['answer-escalation', 'release-claim', 'dismiss-fault']);
    assert.ok(b.items.every((i) => i.column === 'Needs you'));
  });

  it('a run in flight or a claim puts a ticket in Working; a claim whose pull request merged waits on a close', () => {
    const b = board(snapshot({
      issues: [issue(1), issue(2, { comments: [claim()] }), issue(3, { comments: [claim()] })],
      referencedPulls: [pull(103, { headRefName: 'ticket/3', state: 'MERGED', mergedAt: '2026-09-13T20:00:00Z', mergedBy: 'octocat' })],
    }), { coordinator: coordinator({ runsInFlight: [{ runId: 'run_a', taskId: 'loop-sweep-1', runtime: 'claude-local', startedAt: 't' }] }) });
    assert.equal(placed(b, '#1').column, 'Working');
    assert.match(placed(b, '#1').because, /run run_a \(loop-sweep-1\) in flight/);
    assert.equal(placed(b, '#2').column, 'Working');
    assert.match(placed(b, '#2').because, /claimed by the loop/);
    assert.equal(placed(b, '#3').column, 'Needs you');
    assert.equal(placed(b, '#3').action, 'close-completed');
    assert.match(placed(b, '#3').because, /pull request #103 merged by octocat/);
  });

  it('a claimed ticket with an open pull request defers to the pull request, so the work is listed once', () => {
    const b = board(snapshot({ issues: [issue(5, { comments: [claim()] })], pulls: [pull(105)] }));
    assert.equal(placed(b, '#5').column, 'not in play');
    assert.match(placed(b, '#5').because, /pull request #105 is on the board/);
  });

  it('a pull request with no review at its head, or with findings and rounds left, is in review', () => {
    const head = SHA('h');
    const b = board(snapshot({ pulls: [
      pull(101), pull(102, { headRefOid: head, comments: [review(SHA('older'), 0)] }), pull(103, { headRefOid: head, comments: [review(head, 2)] }),
    ] }));
    assert.match(placed(b, 'PR #101').because, /never reviewed/);
    assert.match(placed(b, 'PR #102').because, /review pending: the newest review is at/);
    assert.equal(placed(b, 'PR #103').column, 'In review');
    assert.match(placed(b, 'PR #103').because, /findings=2 independent=yes sha=[0-9a-f]{8}; fix round 1 next/);
  });

  it('findings past the round cap, or a fix that pushed nothing, need a person', () => {
    const head = SHA('h');
    const rounds = [1, 2].map((r) => comment(renderFixMarker({ round: r, from: SHA(`r${r}`), to: SHA(`r${r + 1}`) })));
    const stuck = comment(renderFixMarker({ round: 1, from: head, to: head }));
    const b = board(snapshot({ pulls: [
      pull(101, { headRefOid: head, comments: [...rounds, review(head, 1)] }), pull(102, { headRefOid: head, comments: [review(head, 1), stuck] }),
    ] }));
    assert.equal(placed(b, 'PR #101').column, 'Needs you');
    assert.match(placed(b, 'PR #101').because, /2\/2 fix rounds/);
    assert.equal(placed(b, 'PR #102').column, 'Needs you');
    assert.match(placed(b, 'PR #102').because, /left the head/);
  });

  it('current-head accepted findings lead to the human merge decision, not an exhausted fix path', () => {
    const head = SHA('accepted');
    const comments = [review(head, 3), comment(renderFixMarker({ round: 2, from: head, to: head })), comment(renderAcceptedMarker(head))];
    const b = board(snapshot({
      issues: [issue(1, { labels: ['type:bug'] })],
      pulls: [pull(101, { headRefName: 'ticket/1', headRefOid: head, comments })],
    }));
    const item = placed(b, 'PR #101');
    assert.equal(item.column, 'Needs you');
    assert.equal(item.action, 'open');
    assert.match(item.waitsFor ?? '', /merge/);
    assert.match(item.because, /findings accepted/);
    assert.match(item.because, /findings=3/);
    assert.doesNotMatch(item.because, /clean|pushed nothing|fix round cap|findings=0/);

    const moved = placed(board(snapshot({ pulls: [pull(101, { headRefOid: SHA('new-head'), comments })] })), 'PR #101');
    assert.equal(moved.column, 'In review');
    assert.match(moved.because, /review pending/);
    assert.doesNotMatch(moved.because, /findings accepted/);
  });

  it('does not carry an unpinned accept-findings label to a new head', () => {
    const old = SHA('old');
    const head = SHA('new');
    const item = placed(board(snapshot({
      issues: [issue(1, { labels: ['type:chore'] })],
      pulls: [pull(101, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 2), comment(renderAcceptedMarker(old))], labels: ['accept-findings'] })],
    })), 'PR #101');
    assert.equal(item.column, 'In review');
    assert.equal(item.action, undefined);
    assert.match(item.because, /acceptance instruction has not been pinned to this head/);
  });

  it('shows a pull request the loop did not open and has stopped reviewing as waiting on a person, until review-again is asked', () => {
    const head = SHA('outside-head');
    const stopped = pull(101, { headRefName: 'chore/outside', headRefOid: head, comments: [review(SHA('older'), 1)], labels: ['loop:stopped'] });
    const item = placed(board(snapshot({ pulls: [stopped] })), 'PR #101');
    assert.equal(item.column, 'Needs you');
    assert.match(item.because, /carries loop:stopped and no review at/);
    assert.match(item.because, /review-again/);

    const asked = pull(102, { headRefName: 'chore/outside', headRefOid: head, labels: ['loop:stopped', 'review-again'] });
    const pending = placed(board(snapshot({ pulls: [asked] })), 'PR #102');
    assert.equal(pending.column, 'In review');
    assert.match(pending.because, /review-again is on it; the next pass restarts the review count/);
  });

  it('leaves a ticket pull request, or a head the loop did review, where it was whatever label it carries', () => {
    const head = SHA('ticket-head');
    const b = board(snapshot({
      issues: [issue(1, { labels: ['type:chore'] })],
      pulls: [
        pull(101, { headRefName: 'ticket/1', headRefOid: head, labels: ['loop:stopped'] }),
        pull(102, { headRefName: 'chore/outside', headRefOid: head, comments: [review(head, 2)], labels: ['loop:stopped'] }),
      ],
    }));
    assert.equal(placed(b, 'PR #101').column, 'In review');
    assert.match(placed(b, 'PR #101').because, /review pending/);
    assert.equal(placed(b, 'PR #102').column, 'Needs you');
    assert.match(placed(b, 'PR #102').waitsFor ?? '', /its author to fix the findings/);
  });

  it('acceptance does not waive an independent review or checks, nor a HUMAN hold', () => {
    const head = SHA('accepted');
    const accepted = comment(renderAcceptedMarker(head));
    const b = board(snapshot({
      issues: [issue(1, { labels: ['type:chore'] })],
      pulls: [
        pull(101, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 2, false), accepted] }),
        pull(102, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 2), accepted], checks: 'pending' }),
        pull(103, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 2), accepted], labels: ['HUMAN'] }),
        pull(104, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 2), accepted] }),
      ],
    }));
    assert.match(placed(b, 'PR #101').because, /independent reviewer/);
    assert.match(placed(b, 'PR #102').because, /checks pending/);
    assert.equal(placed(b, 'PR #103').action, 'open');
    assert.match(placed(b, 'PR #103').because, /HUMAN/);
    assert.equal(placed(b, 'PR #104').column, 'Ready to merge');
    assert.match(placed(b, 'PR #104').because, /findings accepted/);
  });

  it('failed checks need a person before anything else about the pull request', () => {
    const item = placed(board(snapshot({ pulls: [pull(101, { checks: 'failure' })] })), 'PR #101');
    assert.equal(item.column, 'Needs you');
    assert.match(item.because, /checks failed at/);
  });

  it('a clean, independent review at head with green checks is Ready to merge only where the stop-line reaches dev', () => {
    const head = SHA('h');
    const b = board(snapshot({
      issues: [issue(1, { labels: ['type:chore'] }), issue(2, { labels: ['type:bug'] })],
      pulls: [
        pull(101, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 0)] }),
        pull(102, { headRefName: 'ticket/2', headRefOid: head, comments: [review(head, 0)] }),
        pull(103, { headRefName: 'feature/x', headRefOid: head, comments: [review(head, 0)] }),
        pull(104, { headRefName: 'ticket/1', headRefOid: head, comments: [review(head, 0, false)] }),
        pull(105, { headRefName: 'ticket/1', headRefOid: head, checks: 'pending', comments: [review(head, 0)] }),
      ],
    }));
    assert.equal(placed(b, 'PR #101').column, 'Ready to merge');
    assert.equal(placed(b, 'PR #101').action, 'merge');
    assert.match(placed(b, 'PR #101').because, /findings=0 independent=yes sha=[0-9a-f]{8}; checks green, mergeable; stop-line 5 reaches dev/);
    assert.equal(placed(b, 'PR #102').column, 'Needs you');
    assert.equal(placed(b, 'PR #102').action, 'open', 'below its stop-line the merge stage cannot merge it, so the console does not offer to');
    assert.match(placed(b, 'PR #102').because, /stop-line 3 stops below dev/);
    assert.match(placed(b, 'PR #103').because, /not a pull request the loop opened/);
    assert.match(placed(b, 'PR #104').because, /waiting for an independent reviewer/);
    assert.match(placed(b, 'PR #105').because, /checks pending/);
  });

  it('drafts and pull requests into main are not in play', () => {
    const b = board(snapshot({ pulls: [pull(101, { isDraft: true }), pull(102, { baseRefName: 'main', headRefName: 'dev' })] }));
    assert.match(placed(b, 'PR #101').because, /draft/);
    assert.match(placed(b, 'PR #102').because, /only a person merges it/);
  });

  it('names the system state from the last pass, with Nothing to do apart from Stalled and Breach', () => {
    const names = (['idle-empty', 'progress', 'stalled', 'breach'] as const).map((c) => board(snapshot(), { coordinator: coordinator({ lastPass: pass(c) }) }).state.name);
    assert.deepEqual(names, ['Nothing to do', 'Progress', 'Stalled', 'Breach']);
    assert.equal(board(snapshot()).state.name, 'No pass yet');
    const idle = board(snapshot(), { coordinator: coordinator({ lastPass: pass('idle-empty', "every stage's queue was empty") }) });
    assert.equal(idle.state.because, "every stage's queue was empty");
    assert.equal(idle.state.lastPass?.endedAt, '2026-09-18T11:05:00Z');
  });

  it('calls review work waiting, and a failed last-pass read blocked, not an all-clear', () => {
    const reviewQueue = board(snapshot({ pulls: [pull(101)] }), { coordinator: coordinator({ lastPass: pass('idle-empty') }) });
    assert.equal(reviewQueue.state.name, 'Waiting');
    assert.equal(reviewQueue.counts['In review'], 1);
    const blocked = board(snapshot(), { coordinator: coordinator({ lastPass: pass('blocked', 'workflow history unavailable') }) });
    assert.equal(blocked.state.name, 'Blocked');
    assert.equal(blocked.state.loop.status, 'blocked');
  });

  it('does not call an idle loop all-clear while the operator has decisions', () => {
    const issues = Array.from({ length: 47 }, (_, i) => issue(i + 1, { comments: [proposal(`body of ${i + 1}`)] }));
    const b = board(snapshot({ issues }), { coordinator: coordinator({ lastPass: pass('idle-empty', 'no runnable work') }) });
    assert.equal(b.counts['Needs you'], 47);
    assert.equal(b.state.name, 'Needs you');
    assert.match(b.state.because, /47/);
    assert.doesNotMatch(b.state.because, /all quiet|nothing to do/i);
  });

  it('does not turn a failed store read into an all-clear state', () => {
    const b = buildBoard({
      read: { snapshot: snapshot(), stale: { error: 'GitHub unavailable', failedAt: '2026-09-22T15:00:00Z' } },
      coordinator: coordinator({ lastPass: pass('idle-empty') }), rules: RULES, policy: POLICY,
    });
    assert.equal(b.state.name, 'Unknown');
    assert.match(b.state.because, /unavailable|stale|failed/i);
  });

  it('the printed board lists every item with the fact that placed it and the state line', () => {
    const text = renderBoard(board(snapshot({ issues: [issue(1, { labels: ['question'] })] }), { coordinator: coordinator({ lastPass: pass('idle-empty', 'queues empty') }) }));
    assert.match(text, /Nothing to do — last pass pass_fixture ended 2026-09-18T11:05:00Z \(idle-empty\)/);
    assert.match(text, /#1 {8}ticket 1\n {13}because: question ticket/);
  });
});

/* ------------------------------------------------------------------ AC-1.2 */

describe('derived verdicts name their event, one test per row of the table', () => {
  const shapeCard = card('card_loop-shape-1-aa', { stage: 'shape', item: '#1', workType: 'bug' }, { createdAt: '2026-09-10T09:00:00Z' });
  const verdictsOf = (cards: ReturnType<typeof card>[], snap: StoreSnapshot) => verdictsFor(cards, derivationContext(snap, RULES.SHAPE_MARKER));

  it('names every row the guide documents, and only those', () => {
    assert.deepEqual(DERIVATION_RULES.map((r) => r.id), ['merged', 'granted-unchanged', 'edited-before-grant', 'closed-not-planned', 'fix-replies']);
  });

  it('merged: the sweep and fix cards of a merged pull request are accepted, naming the merge', () => {
    const merged = pull(161, { headRefName: 'ticket/61', state: 'MERGED', mergedAt: '2026-09-13T20:01:30Z', mergedBy: 'octocat' });
    const cards = [
      card('card_loop-sweep-61', { stage: 'sweep', item: '#61', workType: 'bug', wrote: 'PR #161' }),
      card('card_loop-fix-pr161-aa', { stage: 'fix', item: 'PR #161', workType: 'bug' }),
      card('card_loop-review-pr161-aa', { stage: 'review', item: 'PR #161', workType: 'bug', head: SHA('x') }),
    ];
    const v = verdictsOf(cards, snapshot({ referencedPulls: [merged] }));
    assert.deepEqual(v.map((r) => [r.cardId, r.verdict, r.source]), [
      ['card_loop-sweep-61', 'accepted', 'derived'], ['card_loop-fix-pr161-aa', 'accepted', 'derived'],
    ]);
    const first = v[0]!;
    assert.ok(first.source === 'derived');
    assert.deepEqual(first.event, { type: 'merged', id: '#161', actor: 'octocat', at: '2026-09-13T20:01:30Z' });
    assert.equal(first.detail, 'merged #161 by octocat 2026-09-13T20:01Z');
  });

  it('granted-unchanged: `shaped` or `auto` after the proposal with no edit between is accepted', () => {
    const v = verdictsOf([shapeCard], snapshot({ issues: [issue(1, { events: [{ type: 'labeled', label: 'auto', actor: 'octocat', at: '2026-09-13T17:49:10Z' }] })] }));
    assert.equal(v.length, 1);
    assert.equal(v[0]!.verdict, 'accepted');
    assert.equal(v[0]!.detail, 'labeled auto by octocat 2026-09-13T17:49Z');
  });

  it('edited-before-grant: an edit between the proposal and the grant is rework-needed', () => {
    const v = verdictsOf([shapeCard], snapshot({ issues: [issue(1, {
      events: [{ type: 'labeled', label: 'shaped', actor: 'octocat', at: '2026-09-12T00:00:00Z' }],
      edits: [{ at: '2026-09-11T00:00:00Z', editor: 'octocat' }],
    })] }));
    assert.deepEqual(v.map((r) => r.verdict), ['rework-needed']);
    assert.match(v[0]!.detail, /body edited between proposal and grant/);
    assert.ok(v[0]!.source === 'derived' && v[0]!.event.type === 'edited');
  });

  it('an edit before the proposal or after the grant does not count against it', () => {
    const v = verdictsOf([shapeCard], snapshot({ issues: [issue(1, {
      events: [{ type: 'labeled', label: 'shaped', actor: 'octocat', at: '2026-09-12T00:00:00Z' }],
      edits: [{ at: '2026-09-09T00:00:00Z', editor: 'a' }, { at: '2026-09-13T00:00:00Z', editor: 'b' }],
    })] }));
    assert.deepEqual(v.map((r) => r.verdict), ['accepted']);
  });

  it('closed-not-planned: closing as not planned, or `wontfix`, after the proposal is rejected', () => {
    const closed = verdictsOf([shapeCard], snapshot({ referencedIssues: [issue(1, { state: 'CLOSED', closes: [{ actor: 'octocat', at: '2026-09-14T00:00:00Z', reason: 'NOT_PLANNED' }] })] }));
    assert.deepEqual(closed.map((r) => [r.verdict, r.detail]), [['rejected', 'closed not planned by octocat 2026-09-14T00:00Z']]);
    const wontfix = verdictsOf([shapeCard], snapshot({ issues: [issue(1, { events: [{ type: 'labeled', label: 'wontfix', actor: 'octocat', at: '2026-09-14T00:00:00Z' }] })] }));
    assert.deepEqual(wontfix.map((r) => r.verdict), ['rejected']);
    const completed = verdictsOf([shapeCard], snapshot({ referencedIssues: [issue(1, { state: 'CLOSED', closes: [{ actor: 'm', at: '2026-09-14T00:00:00Z', reason: 'COMPLETED' }] })] }));
    assert.deepEqual(completed, [], 'closing as completed is not a rejection');
  });

  it('fix-replies: the fix stage\'s per-finding replies judge the review, keeping the tally', () => {
    const head = SHA('reviewed');
    const reply = (tags: string[]) => comment(`${tags.map((t, i) => `${i + 1}. [${t}] finding ${i + 1}`).join('\n')}\n\n${renderFixMarker({ round: 1, from: head, to: SHA('after') })}`);
    const reviewCard = card('card_loop-review-pr101-aa', { stage: 'review', item: 'PR #101', workType: 'bug', head });
    const cases: Array<[string[], string]> = [[['accepted', 'accepted'], 'accepted'], [['rejected'], 'rejected'], [['accepted', 'rejected', 'out-of-scope'], 'rework-needed']];
    for (const [tags, verdict] of cases) {
      const v = verdictsOf([reviewCard], snapshot({ pulls: [pull(101, { comments: [reply(tags)] })] }));
      assert.equal(v.length, 1);
      assert.equal(v[0]!.verdict, verdict, tags.join(','));
      assert.ok(v[0]!.source === 'derived' && v[0]!.findings !== undefined && v[0]!.event.type === 'fix-reply');
    }
    assert.deepEqual(tallyFindings('1. [accepted] a\n2. **[rejected]** b\n3. [out-of-scope] c\nprose [accepted]'), { accepted: 1, rejected: 1, outOfScope: 1 });
  });

  it('a fix reply for another head says nothing about this review', () => {
    const reviewCard = card('card_loop-review-pr101-aa', { stage: 'review', item: 'PR #101', workType: 'bug', head: SHA('mine') });
    const other = comment(`1. [rejected] x\n\n${renderFixMarker({ round: 1, from: SHA('other'), to: SHA('after') })}`);
    assert.deepEqual(verdictsOf([reviewCard], snapshot({ pulls: [pull(101, { comments: [other] })] })), []);
  });

  it('an explicit verdict supersedes the derived ones for its card, and they are kept', () => {
    const explicit = { ...shapeCard, feedback: { verdict: 'rejected' as const, by: 'octocat', reason: 'wrong scope', at: '2026-09-15T00:00:00Z' } };
    const v = verdictsOf([explicit], snapshot({ issues: [issue(1, { events: [{ type: 'labeled', label: 'shaped', actor: 'octocat', at: '2026-09-12T00:00:00Z' }] })] }));
    assert.deepEqual(v.map((r) => [r.source, r.verdict, r.superseded ?? false]), [['derived', 'accepted', true], ['explicit', 'rejected', false]]);
    assert.equal(currentVerdict(v, explicit.id)?.source, 'explicit');
    assert.equal(currentVerdict(v, explicit.id)?.verdict, 'rejected');
  });

  it('fixture feedback is never an explicit verdict', () => {
    const fixture = { ...shapeCard, feedback: { verdict: 'accepted' as const, by: 'x', reason: 'y', at: 't', isFixture: true } };
    assert.deepEqual(verdictsFor([fixture], undefined), []);
  });

  it('the print shows each derived verdict with its source and event, and marks a superseded one kept', () => {
    const explicit = { ...shapeCard, feedback: { verdict: 'rejected' as const, by: 'octocat', reason: 'wrong scope', at: '2026-09-15T00:00:00Z' } };
    const snap = snapshot({ issues: [issue(1, { events: [{ type: 'labeled', label: 'auto', actor: 'octocat', at: '2026-09-13T17:49:00Z' }] })] });
    const text = renderBoard(board(snap, { coordinator: coordinator({ scorecards: [explicit] }) }));
    assert.match(text, /card_loop-shape-1-aa {2}#1 shape: accepted {2}\[source: derived \(superseded, kept\)\] {2}labeled auto by octocat 2026-09-13T17:49Z/);
    assert.match(text, /card_loop-shape-1-aa {2}#1 shape: rejected {2}\[source: explicit \(current\)\] {2}rejected by octocat: wrong scope/);
  });
});

/* ------------------------------------------------------------------ INV-G6 */

describe('a derived verdict is never counted as an explicit one', () => {
  it('two derived and one explicit on the same scorecard count as derived: 2, explicit: 1, with the explicit one current', () => {
    const c = card('card_loop-shape-1-aa', { stage: 'shape', item: '#1', workType: 'bug' }, {
      createdAt: '2026-09-10T09:00:00Z',
      feedback: { verdict: 'accepted', by: 'octocat', reason: 'good shape', at: '2026-09-16T00:00:00Z' },
    });
    // Granted (accepted), then closed as not planned (rejected): two store events, two derived verdicts.
    const snap = snapshot({ referencedIssues: [issue(1, {
      state: 'CLOSED',
      events: [{ type: 'labeled', label: 'shaped', actor: 'octocat', at: '2026-09-11T00:00:00Z' }],
      closes: [{ actor: 'octocat', at: '2026-09-12T00:00:00Z', reason: 'NOT_PLANNED' }],
    })] });
    const records = verdictsFor([c], derivationContext(snap, RULES.SHAPE_MARKER));
    const counts = countVerdicts(records);
    assert.equal(renderVerdictCounts(counts), 'derived: 2 (accepted 1, rework-needed 0, rejected 1), explicit: 1 (accepted 1, rework-needed 0, rejected 0)');
    assert.match(renderVerdictCounts(counts), /^derived: 2 .*, explicit: 1 /);
    assert.equal(currentVerdict(records, c.id)?.source, 'explicit');
    const derived = records.filter((r) => r.source === 'derived');
    assert.equal(derived.length, 2, 'the superseded derived verdicts are kept');
    assert.ok(derived.every((r) => r.superseded === true && r.source === 'derived' && r.event.actor === 'octocat'));
    assert.doesNotMatch(renderVerdictCounts(counts), /%|rate|total/i);
  });
});

/* ------------------------------------------------------------------ AC-1.3 */

describe('a GitHub read that fails degrades to the last snapshot, visibly', () => {
  class Flaky implements SnapshotSource {
    fail = false;
    constructor(private readonly snap: StoreSnapshot) {}
    read(): Promise<StoreSnapshot> { return this.fail ? Promise.reject(new Error('gh api graphql exited 1: HTTP 502')) : Promise.resolve(this.snap); }
  }

  it('returns the previous snapshot with its age and the error, renders the columns, and derives no verdict from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-snap-'));
    try {
      const merged = pull(161, { headRefName: 'ticket/61', state: 'MERGED', mergedAt: '2026-09-13T20:01:30Z', mergedBy: 'octocat' });
      const source = new Flaky(snapshot({ takenAt: '2026-09-18T12:00:00Z', issues: [issue(1, { labels: ['question'] })], referencedPulls: [merged] }));
      let now = new Date('2026-09-18T12:00:00Z');
      const cache = new LastGoodSnapshot(source, join(dir, 'snap.json'), () => now);
      const cards = [card('card_loop-sweep-61', { stage: 'sweep', item: '#61', workType: 'bug', wrote: 'PR #161' })];

      const fresh = buildBoard({ read: await cache.refresh({ issues: [], pulls: [] }), coordinator: coordinator({ scorecards: cards }), rules: RULES, policy: POLICY });
      assert.equal(fresh.stale, undefined);
      assert.equal(countVerdicts(fresh.verdicts).derived.accepted, 1);

      source.fail = true;
      now = new Date('2026-09-18T12:10:00Z');
      const read = await cache.refresh({ issues: [], pulls: [] });
      assert.equal(read.stale?.error, 'gh api graphql exited 1: HTTP 502');
      assert.equal(read.stale?.ageSeconds, 600);
      const stale = buildBoard({ read, coordinator: coordinator({ scorecards: cards }), rules: RULES, policy: POLICY });
      assert.equal(stale.items.length, 1, 'the last good snapshot still renders');
      assert.equal(stale.snapshotAt, '2026-09-18T12:00:00Z');
      assert.deepEqual(stale.verdicts, [], 'nothing is derived from a stale snapshot');
      assert.match(renderBoard(stale), /STALE: the latest GitHub read failed at 2026-09-18T12:10:00.000Z: gh api graphql exited 1: HTTP 502\n {2}Showing the last good snapshot, taken 2026-09-18T12:00:00Z \(600s old\)\. No verdict is derived from it\./);

      const none = await new LastGoodSnapshot(source, join(dir, 'missing.json')).refresh({ issues: [], pulls: [] });
      assert.equal(none.snapshot, undefined);
      assert.match(none.stale?.error ?? '', /HTTP 502/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading GitHub into facts', () => {
  it('drops a referenced number GitHub has no item for and reads the rest, rather than failing the whole read', async () => {
    const queries: string[] = [];
    const gql = (query: string): Promise<Record<string, unknown>> => {
      queries.push(query);
      if (query.includes('issues(states: OPEN')) return Promise.resolve({ repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } });
      if (query.includes('pullRequests(states: OPEN')) return Promise.resolve({ repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } });
      // GitHub names only some of the missing numbers in one error.
      if (query.includes('p900:')) return Promise.reject(new Error('gh api graphql -f exited 1: gh: Could not resolve to a PullRequest with the number of 900.'));
      if (query.includes('p902:')) return Promise.reject(new Error('gh: Could not resolve to a PullRequest with the number of 902.'));
      return Promise.resolve({ repository: { p901: { number: 901, title: 'kept', state: 'MERGED', commits: { nodes: [] }, comments: { nodes: [] } } } });
    };
    const snap = await new GhSnapshotSource('o/r', gql).read({ issues: [], pulls: [900, 901, 902] });
    assert.deepEqual(snap.referencedPulls.map((p) => p.number), [901]);
    assert.equal(queries.filter((q) => q.includes('p901:')).length, 3, 'asked again until no missing number was left');
    await assert.rejects(new GhSnapshotSource('o/r', () => Promise.reject(new Error('HTTP 502'))).read({ issues: [], pulls: [] }), /HTTP 502/);
  });

  it('maps the GraphQL issue and pull shapes, including label events, closes and body edits', () => {
    const i = toIssueFact({
      number: 7, title: 't', body: 'b', state: 'CLOSED',
      labels: { nodes: [{ name: 'shaped' }] }, assignees: { nodes: [{ login: 'a' }] },
      timelineItems: { nodes: [
        { __typename: 'LabeledEvent', createdAt: '2026-09-01T00:00:00Z', actor: { login: 'm' }, label: { name: 'shaped' } },
        { __typename: 'ClosedEvent', createdAt: '2026-09-02T00:00:00Z', actor: { login: 'm' }, stateReason: 'NOT_PLANNED' },
      ] },
      userContentEdits: { nodes: [{ editedAt: '2026-09-03T00:00:00Z', editor: { login: 'e' } }, { editedAt: '2026-09-01T00:00:00Z', editor: null }] },
      comments: { nodes: [{ databaseId: 9, body: 'c', author: { login: 'x' }, createdAt: 'T' }] },
    });
    assert.deepEqual(i.events, [{ type: 'labeled', label: 'shaped', actor: 'm', at: '2026-09-01T00:00:00Z' }]);
    assert.deepEqual(i.closes, [{ actor: 'm', at: '2026-09-02T00:00:00Z', reason: 'NOT_PLANNED' }]);
    assert.deepEqual(i.edits.map((e) => e.editor), ['ghost', 'e']);
    assert.deepEqual(i.comments, [{ id: 9, body: 'c', author: 'x', createdAt: 'T' }]);
    const p = toPullFact({
      number: 8, title: 't', body: 'The exact current PR description.', headRefName: 'ticket/7', headRefOid: 'abc', baseRefName: 'dev', isDraft: false, state: 'MERGED',
      mergedAt: '2026-09-04T00:00:00Z', mergedBy: { login: 'm' }, mergeable: 'MERGEABLE',
      labels: { nodes: [{ name: 'HUMAN' }] },
      commits: { nodes: [{ commit: { message: 'm', statusCheckRollup: { state: 'FAILURE' } } }] }, comments: { nodes: [] },
    });
    assert.equal(p.checks, 'failure');
    assert.equal(p.body, 'The exact current PR description.');
    assert.equal(p.state, 'MERGED');
    assert.equal(p.mergedBy, 'm');
    assert.deepEqual(p.labels, ['HUMAN'], 'pull labels participate in the same hold rules as the loop');
  });

  it('names the closed items the loop\'s records point at, so their verdicts can be derived', () => {
    const cards = [
      card('card_a', { stage: 'sweep', item: '#61', workType: 'bug', wrote: 'PR #161' }),
      card('card_b', { stage: 'review', item: 'PR #170', workType: 'bug' }),
    ];
    const { loop: _loop, ...handDispatched } = card('card_c', { stage: 'shape', item: '#1', workType: 'bug' });
    cards.push(handDispatched);
    assert.deepEqual(referencedNumbers(cards), { issues: [61], pulls: [161, 170] });
  });
});
