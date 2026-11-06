import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATUS_BLOCKED, STATUS_SKIPPED, STATUS_STOPPED, STATUS_WORKING } from './labels.js';
import { parsePrStatus } from './markers.js';
import { causeOf, situationsByPull, syncStatusComments } from './status-comment.js';
import { FakeStore, SHA } from './testkit.js';
import type { Decision, StageName, StagePlan } from './types.js';

const plan = (stage: StageName, items: Array<{ ref: string; decision: Decision }>): StagePlan =>
  ({ stage, rung: { name: 'clean', number: 4, reachedWhen: 'test', line: 'test' }, items, notes: [], faults: [] });

// The strings below are the ones the loop wrote for SmartCaptions#928 and other pull requests.
const NO_TIER = (pct: number, hours: number): string => `tier unavailable: claude-opus-5-5·xhigh on claude-local: weekly ${pct}% used under a 70% ceiling leaves 51% after this run's 3% bound, ${hours}h to reset`;
const REVIEW_LIMIT = 'review limit reached (3/3): the loop did not open this pull request and has run 3 reviews of it; left for a person — the review-again label allows 3 more';

const blocked = (reason: string): Decision => ({ kind: 'blocked', reason });
const stopped = (reason: string): Decision => ({ kind: 'skip', reason, owner: STATUS_STOPPED });

const AT = (minute: number): Date => new Date(Date.UTC(2026, 10, 6, 7, minute));

function setup(...numbers: number[]): FakeStore {
  const store = new FakeStore();
  for (const n of numbers) store.addPull({ number: n, headRefOid: SHA(`h${n}`) });
  return store;
}
const statusComments = (store: FakeStore, n: number) => (store.commentsBy.get(n) ?? []).filter((c) => parsePrStatus(c.body));

// These tests hold docs/adr/20261106-pull-request-status-is-one-editable-comment.md: one comment edited in
// place, silent after the first write, and only for a pull request that needs a person or is refused.
describe('which reason a pull request carries', () => {
  it('keeps the stage and reason of the decision that earned the label, first in plan order on a tie', () => {
    const found = situationsByPull([
      plan('review', [{ ref: 'PR #1', decision: blocked(NO_TIER(6, 160)) }, { ref: 'PR #2', decision: { kind: 'dispatch', detail: 'would review' } }]),
      plan('fix', [{ ref: 'PR #1', decision: stopped('round cap reached (3/3); left for a person') }, { ref: 'PR #2', decision: stopped('no progress: x') }]),
    ]);
    assert.equal(found.get(1)?.label, STATUS_BLOCKED, 'blocked outranks stopped');
    assert.equal(found.get(1)?.stage, 'review');
    assert.match(found.get(1)!.reason, /^tier unavailable/);
    assert.equal(found.get(2)?.label, STATUS_WORKING);
  });
});

describe('the kind of reason', () => {
  it('names no model tier having room the same whatever the quota numbers say', () => {
    const a = causeOf({ label: STATUS_BLOCKED, stage: 'review', reason: NO_TIER(6, 161.5) });
    const b = causeOf({ label: STATUS_BLOCKED, stage: 'review', reason: NO_TIER(12, 159.8) });
    assert.equal(a.cause, 'no-tier');
    assert.deepEqual(a, b);
  });

  it('says what a person can do about a review limit, without the raw reason', () => {
    const c = causeOf({ label: STATUS_STOPPED, stage: 'review', reason: REVIEW_LIMIT });
    assert.equal(c.cause, 'review-limit');
    assert.match(c.next, /add the `review-again` label/);
    assert.doesNotMatch(`${c.why}${c.next}`, /3\/3/);
  });

  for (const [reason, cause] of [
    ['reviewed at head, not independent; no independent tier reachable (x)', 'no-independent-tier'],
    ['the review does not cover the current PR description; re-review before merge', 'stale-review'],
    ['stop-line 3 below this stage (4)', 'stop-line'],
    ['stop-line 3 < 5; current-head findings accepted, awaits a human merge', 'stop-line'],
    ['no progress: round 2 left the head at abc and the re-review still has findings=1; left for a person', 'no-progress'],
    ['round cap reached (3/3); left for a person', 'round-cap'],
    ['no authority for merge-dev: no grant', 'no-authority'],
  ] as const) {
    it(`recognises "${reason.slice(0, 40)}"`, () => {
      assert.equal(causeOf({ label: reason.startsWith('reviewed') || reason.startsWith('no authority') ? STATUS_BLOCKED : STATUS_STOPPED, stage: 'fix', reason }).cause, cause);
    });
  }

  it('recognises a failed release check', () => {
    assert.equal(causeOf({ label: STATUS_BLOCKED, stage: 'verify', reason: 'post-deploy checks for main abc, run 7 attempt 1 did not all pass; inspect the verification comment' }).cause, 'release-check');
  });

  it('falls back to a generic line whose key ignores numbers but not words', () => {
    const k = (reason: string) => causeOf({ label: STATUS_STOPPED, stage: 'merge', reason }).cause;
    assert.equal(k('waiting on 3 checks for 12 minutes'), k('waiting on 4 checks for 45 minutes'));
    assert.notEqual(k('waiting on 3 checks'), k('conflicts with the base'));
  });
});

describe('the status comment on a pull request', () => {
  it('is written once when a pull request is first blocked, and shows the answer in one look', async () => {
    const store = setup(928);
    const plans = [plan('review', [{ ref: 'PR #928', decision: blocked(NO_TIER(6, 161.5)) }])];
    await syncStatusComments(store, store.pulls, 'dev', plans, AT(11), 'pass_1');
    const [c] = statusComments(store, 928);
    assert.equal(statusComments(store, 928).length, 1);
    const visible = c!.body.split('<details>')[0]!;
    assert.match(visible, /^\*\*Loop status: 🔴 blocked\*\* \(since 2026-11-06 07:11 UTC\)\n/);
    assert.match(visible, /\*\*Why:\*\* The review stage wanted to act, and no model tier could start/);
    assert.match(visible, /\*\*Next:\*\* The loop tries again on a later pass\. Nothing is needed from you\./);
    assert.ok(visible.trim().split('\n').length <= 10, 'the visible part fits about ten lines');
    assert.doesNotMatch(c!.body, /weekly 6% used|161\.5h|ceiling/, 'the raw admission string is not in the comment');
    assert.doesNotMatch(c!.body, /@/, 'it mentions nobody');
    assert.match(c!.body, /<details>\n<summary>Last changes<\/summary>\n\n- 2026-11-06 07:11 UTC: first seen → blocked \(review: no model tier has room\)/);
    assert.equal(store.writes.filter((w) => w.kind === 'update-issue' || w.kind === 'pull').length, 0, 'the pull request description is never written');
  });

  it('says who must act and how when a pull request is stopped on a review limit', async () => {
    const store = setup(7);
    await syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #7', decision: stopped(REVIEW_LIMIT) }])], AT(0), 'p');
    const body = statusComments(store, 7)[0]!.body;
    assert.match(body, /Loop status: 🟡 stopped, needs a person/);
    assert.match(body, /\*\*Next:\*\* Needs you: add the `review-again` label to allow more reviews, or review it yourself\./);
  });

  it('gives a pull request that was only ever working or skipped no comment, and a no-opinion one none either', async () => {
    const store = setup(1, 2, 3);
    const plans = [plan('review', [
      { ref: 'PR #1', decision: { kind: 'dispatch', detail: 'would review' } },
      { ref: 'PR #2', decision: { kind: 'skip', reason: 'carries HUMAN — not store-defined, left for the operator', owner: STATUS_SKIPPED } },
    ])];
    await syncStatusComments(store, store.pulls, 'dev', plans, AT(0), 'p');
    assert.deepEqual(store.writes, []);
  });

  it('writes nothing for a pull request against another base', async () => {
    const store = new FakeStore();
    store.addPull({ number: 4, headRefOid: SHA('x'), baseRefName: 'main' });
    await syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #4', decision: blocked('tier unavailable: x') }])], AT(0), 'p');
    assert.deepEqual(store.writes, []);
  });

  it('leaves the comment alone when only the numbers moved, and keeps one comment', async () => {
    const store = setup(928);
    const at = (pct: number, hours: number, minute: number) =>
      syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #928', decision: blocked(NO_TIER(pct, hours)) }])], AT(minute), `pass_${minute}`);
    await at(6, 161.5, 0);
    await at(12, 159.8, 15);
    await at(13, 150, 30);
    assert.deepEqual(store.writes.map((w) => w.kind), ['comment'], 'one create and no edits');
    assert.equal(statusComments(store, 928).length, 1);
  });

  it('edits the same comment when the label, the stage or the kind of reason changes', async () => {
    const store = setup(928);
    const run = (stage: StageName, d: Decision, minute: number) =>
      syncStatusComments(store, store.pulls, 'dev', [plan(stage, [{ ref: 'PR #928', decision: d }])], AT(minute), `pass_${minute}`);
    await run('review', blocked(NO_TIER(6, 160)), 0);
    await run('review', stopped(REVIEW_LIMIT), 15);       // label and cause change
    await run('fix', stopped('round cap reached (3/3); left for a person'), 30); // stage and cause change
    await run('fix', { kind: 'dispatch', detail: 'would fix' }, 45);               // back to working
    assert.deepEqual(store.writes.map((w) => w.kind), ['comment', 'update-comment', 'update-comment', 'update-comment']);
    assert.equal(statusComments(store, 928).length, 1, 'still one comment');
    const body = statusComments(store, 928)[0]!.body;
    assert.match(body, /Loop status: 🔵 working/, 'never contradicts the label');
    assert.match(body, /\*\*Next:\*\* Nothing is needed from you\./);
    const lines = body.split('\n').filter((l) => l.startsWith('- 2026'));
    assert.deepEqual(lines.map((l) => l.replace(/^- \S+ \S+ UTC: /, '')), [
      'stopped → working (fix: the loop is working on it)',
      'stopped → stopped (fix: fix rounds used up)',
      'blocked → stopped (review: review limit reached)',
      'first seen → blocked (review: no model tier has room)',
    ]);
  });

  it('keeps only the last five changes', async () => {
    const store = setup(1);
    for (let i = 0; i < 8; i++) {
      const d: Decision = i % 2 === 0 ? blocked(NO_TIER(1, 1)) : stopped(REVIEW_LIMIT);
      await syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #1', decision: d }])], AT(i), `p${i}`);
    }
    const parsed = parsePrStatus(statusComments(store, 1)[0]!.body)!;
    assert.equal(parsed.changes.length, 5);
    assert.equal(statusComments(store, 1)[0]!.body.split('\n').filter((l) => l.startsWith('- 2026')).length, 5);
  });

  it('explains a pull request that was already blocked and had no comment, and updates one that left the state', async () => {
    const store = new FakeStore();
    store.addPull({ number: 928, headRefOid: SHA('a'), labels: [STATUS_BLOCKED] });
    const blockedPlan = [plan('review', [{ ref: 'PR #928', decision: blocked(NO_TIER(6, 160)) }])];
    await syncStatusComments(store, store.pulls, 'dev', blockedPlan, AT(0), 'p');
    assert.equal(statusComments(store, 928).length, 1, 'a PR already blocked before the rollout is explained');
    await syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #928', decision: { kind: 'skip', reason: 'draft', owner: STATUS_SKIPPED } }])], AT(15), 'p2');
    assert.match(statusComments(store, 928)[0]!.body, /Loop status: ⚪ skipped/);
    // no stage speaks for it at all
    await syncStatusComments(store, store.pulls, 'dev', [plan('fix', [])], AT(30), 'p3');
    assert.match(statusComments(store, 928)[0]!.body, /No stage had a plan for this pull request/);
  });

  it('edits the newest when two status comments somehow exist', async () => {
    const store = setup(1);
    const plans = (d: Decision) => [plan('review', [{ ref: 'PR #1', decision: d }])];
    await syncStatusComments(store, store.pulls, 'dev', plans(blocked(NO_TIER(1, 1))), AT(0), 'p');
    const dup = store.addComment(1, statusComments(store, 1)[0]!.body, 'loop');
    await syncStatusComments(store, store.pulls, 'dev', plans(stopped(REVIEW_LIMIT)), AT(15), 'p2');
    const edited = store.writes.find((w) => w.kind === 'update-comment');
    assert.equal(edited?.target, dup.id);
  });

  it('is skipped by the checks that tell the loop\'s comments from a person\'s', async () => {
    const { writtenByLoop } = await import('./markers.js');
    const store = setup(1);
    await syncStatusComments(store, store.pulls, 'dev', [plan('review', [{ ref: 'PR #1', decision: blocked(NO_TIER(1, 1)) }])], AT(0), 'p');
    assert.equal(writtenByLoop(statusComments(store, 1)[0]!.body), true);
  });

  it('carries on with the other pull requests when one cannot be written', async () => {
    class Hostile extends FakeStore {
      override createComment(n: number, body: string): Promise<number> { return n === 1 ? Promise.reject(new Error('HTTP 403')) : super.createComment(n, body); }
    }
    const store = new Hostile();
    store.addPull({ number: 1, headRefOid: SHA('a') });
    store.addPull({ number: 2, headRefOid: SHA('b') });
    const plans = [plan('review', [{ ref: 'PR #1', decision: blocked('tier unavailable: x') }, { ref: 'PR #2', decision: blocked('tier unavailable: x') }])];
    const lines = await syncStatusComments(store, store.pulls, 'dev', plans, AT(0), 'p');
    assert.ok(lines.some((l) => /PR #1 not written: HTTP 403/.test(l)));
    assert.equal(statusComments(store, 2).length, 1);
  });
});
