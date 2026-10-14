import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { FIXTURE_FLOOR } from './testkit.js';
import { saveRun } from '../core/run.js';
import type { RunRecord } from '../core/run.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import type { DispatchCommandResult, DispatchTaskInput } from '../commands.js';
import { ReadOnlyStore } from './github.js';
import { ONE_SHOT_LABELS, REVIEW_AGAIN_LABEL, STATUS_STOPPED, STATUS_WORKING } from './labels.js';
import {
  LOOP_SIGNATURE, newestReview, newestReviewRestart, operatorComment, renderReviewAgainMarker, writtenByLoop,
} from './markers.js';
import { coordinatorCommands, runPass } from './pass.js';
import type { PassDeps } from './pass.js';
import { parseStoreConfig, PolicyError } from './policy.js';
import { outsideReviewRules } from './stages/review.js';
import type { PassReport } from './supervisor.js';
import {
  commitAt, completed, FakeCommands, FakeRepo, FakeStore, fixtureRules, fixtureStoreConfig, outputFileIn, SHA,
} from './testkit.js';
import type { PassOptions } from './types.js';

let box: Sandbox;
beforeEach(() => { box = sandbox(); writeFloor(FIXTURE_FLOOR); });
afterEach(() => box.cleanup());

const REAL: PassOptions = { dryRun: false };
const MIN = 60_000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const SLUG = 'example-org/larkspur';

/** A review that finishes with one finding, naming the head its prompt gave it. */
const finishing = (input: DispatchTaskInput): DispatchCommandResult => {
  const path = outputFileIn(input.prompt);
  const head = /REVIEW_RESULT head=([0-9a-f]{7,64})/i.exec(input.prompt)?.[1];
  if (path) writeFileSync(path, `Found one issue.\nREVIEW_RESULT head=${head} findings=1`, 'utf8');
  return completed(input);
};

/**
 * One pull request and the clock the loop reads it by.
 *
 * With no `ticket` it is an outside pull request, as #750 was: another agent's branch, whose author
 * pushes. With one it is the loop's own `ticket/<n>` pull request, which a person pushes to.
 */
function setup(opts: { ticket?: number; limitRows?: string[] } = {}) {
  const store = new FakeStore();
  store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
  const number = opts.ticket ?? 750;
  if (opts.ticket !== undefined) store.addIssue({ number, labels: ['type:bug', 'auto', 'shaped', 'effort:home'] });
  const first = SHA('outside-0');
  store.addPull({ number, headRefOid: first, ...(opts.ticket === undefined ? { headRefName: 'chore/release-verify' } : {}) });
  store.commitsBy.set(number, [commitAt(first, iso(T0))]);
  const commands = new FakeCommands(finishing);
  const clock = { now: T0 };
  const repo = new FakeRepo(fixtureStoreConfig({ defaultRung: 4, ...(opts.limitRows ? { limitRows: opts.limitRows } : {}) }));
  const d: PassDeps & { store: FakeStore; commands: FakeCommands } = { store, commands, repo, rules: fixtureRules(), now: () => new Date(clock.now) };
  let seq = 0;
  /** The author pushes a commit, committed now. */
  const push = (): string => {
    const head = SHA(`outside-${++seq}`);
    store.pulls[0]!.headRefOid = head;
    store.commitsBy.set(number, [...store.commitsBy.get(number)!, commitAt(head, iso(clock.now))]);
    return head;
  };
  const pass = (options: PassOptions = REAL, over: Partial<PassDeps> = {}): Promise<PassReport> => runPass({ ...d, ...over }, options);
  const review = (report: PassReport) => report.stages.find((s) => s.stage === 'review')!.items.find((i) => i.ref === `PR #${number}`)!;
  const labelWrites = (): number => store.writes.filter((w) => w.kind === 'add-label' || w.kind === 'remove-label').length;
  /** Let the newest commit age past the quiet period, run a pass, and have the author push again. */
  const reviewThenPush = async (): Promise<PassReport> => {
    clock.now += 31 * MIN;
    const report = await pass();
    clock.now += MIN;
    push();
    return report;
  };
  return { store, commands, clock, d, number, push, pass, review, labelWrites, reviewThenPush, head: () => store.pulls[0]!.headRefOid };
}

describe('a review of a pull request the loop did not open ends', () => {
  it('stops the #750 pattern after three reviews, counting the one a push overtook, and leaves it for a person', async () => {
    const s = setup();
    const ageAtDispatch: number[] = [];
    let dispatches = 0;
    s.commands.onDispatch = (input) => {
      ageAtDispatch.push(s.clock.now - Date.parse(s.store.commitsBy.get(s.number)!.at(-1)!.committedDate!));
      dispatches++;
      const result = finishing(input);
      // The author pushes while the second review is running, so its result goes unrecorded.
      if (dispatches === 2) { s.clock.now += 3 * MIN; s.push(); }
      return result;
    };
    const first = s.head();

    s.clock.now = T0 + 10 * MIN;
    const waiting = await s.pass();
    assert.equal(s.review(waiting).decision, 'skip');
    assert.equal(s.commands.dispatched.length, 0, 'a head 10 minutes old is not reviewed');

    s.clock.now = T0 + 31 * MIN;
    const one = await s.pass();
    assert.equal(s.review(one).decision, 'dispatch');
    assert.equal(newestReview(s.store.commentsBy.get(s.number) ?? [])?.sha, first, 'review 1 is recorded at the first head');
    s.clock.now += MIN;
    const second = s.push();

    s.clock.now += 10 * MIN;
    assert.equal(s.review(await s.pass()).decision, 'skip', 'the new head is 10 minutes old');
    s.clock.now += 21 * MIN;
    const two = await s.pass();
    assert.match(s.review(two).result ?? '', /PR changed during review/, 'review 2 was overtaken by a push');
    assert.equal(newestReview(s.store.commentsBy.get(s.number) ?? [])?.sha, first, 'and left no record');
    assert.equal(s.commands.ran.length, 2, 'but it ran');

    s.clock.now += 31 * MIN;
    const three = await s.pass();
    assert.equal(s.review(three).decision, 'dispatch');
    assert.equal(s.commands.ran.length, 3);
    const third = s.head();
    assert.notEqual(third, second);
    assert.equal(newestReview(s.store.commentsBy.get(s.number) ?? [])?.sha, third);

    // The author pushes once more, after the third review.
    s.clock.now += MIN;
    s.push();
    s.clock.now += 31 * MIN;
    const writesBefore = s.store.writes.length;
    const stopped = await s.pass();
    assert.equal(s.review(stopped).decision, 'skip');
    assert.match(s.review(stopped).reason, /review limit reached \(3\/3\)/);
    assert.match(s.review(stopped).reason, /left for a person/);
    assert.match(s.review(stopped).reason, /review-again/);
    assert.equal(s.commands.dispatched.length, 3, 'no fourth review');
    assert.ok(s.store.pulls[0]!.labels.includes(STATUS_STOPPED), 'the pull request carries loop:stopped');
    assert.deepEqual(stopped.faults, [], 'stopping at the limit is not a fault');
    assert.ok(ageAtDispatch.length === 3 && ageAtDispatch.every((age) => age >= 30 * MIN), `each review followed 30 quiet minutes: ${ageAtDispatch.map((a) => a / MIN)}`);

    // Later passes leave it stopped and dispatch nothing.
    for (let i = 0; i < 3; i++) {
      s.clock.now += 15 * MIN;
      const later = await s.pass();
      assert.match(s.review(later).reason, /review limit reached \(3\/3\)/);
    }
    assert.equal(s.commands.dispatched.length, 3);
    assert.ok(s.store.pulls[0]!.labels.includes(STATUS_STOPPED));
    assert.ok(s.store.writes.length >= writesBefore);
    assert.equal(s.store.writes.filter((w) => w.kind === 'comment' && /larkspur-loop-review-again/.test(w.body ?? '')).length, 0);
  });

  it('counts a head and description once, however many reviews ran at them', async () => {
    const s = setup();
    s.commands.onDispatch = (input) => finishing(input);
    await s.reviewThenPush();
    // A second run of the same head and description, as when an independent tier became reachable for a redo.
    const { head, bodyDigest } = s.commands.ran[0]!.loop!;
    s.commands.ran.push(s.commands.ran[0]!);
    assert.deepEqual(s.commands.reviewsRun(SLUG, s.number), [{ head, bodyDigest }]);
  });
});

describe('an outside pull request waits for its newest commit to be quiet', () => {
  it('does not review a head 10 minutes old, says how long it waits, raises no fault and stops nothing', async () => {
    const s = setup();
    // The first pass of a fresh loop says, once and without a model, that no ticket awaits a verdict.
    await s.pass();
    s.clock.now = T0 + 10 * MIN;
    const report = await s.pass();
    const item = s.review(report);
    assert.equal(item.decision, 'skip');
    assert.match(item.reason, /its newest commit [0-9a-f]{8} is 10 min old/);
    assert.match(item.reason, /once that commit is 30 min old, about 20 min more/);
    assert.equal(s.commands.dispatched.length, 0);
    assert.deepEqual(report.faults, []);
    assert.equal(report.classification, 'waiting');
    assert.deepEqual(s.store.pulls[0]!.labels, [STATUS_WORKING], 'queued for review, never loop:stopped');
    // And a later wait, then the review itself, move no label: the wait carries the status the review will.
    const settled = s.labelWrites();
    s.clock.now = T0 + 20 * MIN;
    await s.pass();
    s.clock.now = T0 + 31 * MIN;
    const reviewed = await s.pass();
    assert.equal(s.review(reviewed).decision, 'dispatch');
    assert.equal(s.labelWrites(), settled);
  });

  it('reviews the same pull request at 31 minutes', async () => {
    const s = setup();
    s.clock.now = T0 + 31 * MIN;
    const report = await s.pass();
    assert.equal(s.review(report).decision, 'dispatch');
    assert.equal(s.commands.ran.length, 1);
  });

  it('never makes a pull request the loop opened wait', async () => {
    const s = setup({ ticket: 701 });
    s.clock.now = T0 + MIN;
    s.store.commitsBy.set(701, [commitAt(s.head(), iso(T0))]);
    const report = await s.pass({ dryRun: false, stages: ['review'] });
    assert.equal(s.review(report).decision, 'dispatch', 'a ticket pull request with a 1-minute-old head is reviewed at once');
    assert.equal(s.commands.ran.length, 1);
  });

  it('does not wait on a commit date it cannot trust: missing, unreadable, or further ahead than clock drift explains', async () => {
    for (const committedDate of [undefined, 'not a date', iso(T0 + 3 * 60 * MIN)]) {
      const s = setup();
      s.store.commitsBy.set(s.number, [{ oid: s.head(), message: 'x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>', ...(committedDate ? { committedDate } : {}) }]);
      s.clock.now = T0;
      const report = await s.pass({ dryRun: false, stages: ['review'] });
      assert.equal(s.review(report).decision, 'dispatch', `${committedDate}`);
    }
  });

  it('still waits for a date a little ahead of this clock, which is drift', async () => {
    const s = setup();
    s.store.commitsBy.set(s.number, [commitAt(s.head(), iso(T0 + 2 * MIN))]);
    s.clock.now = T0;
    const report = await s.pass({ dryRun: false, stages: ['review'] });
    assert.equal(s.review(report).decision, 'skip');
    assert.match(s.review(report).reason, /is 0 min old/);
  });
});

describe('the review limit and quiet period come from the store configuration', () => {
  const rows = (reviews: number, quiet: number): string[] => [`| reviews per outside pull request | ${reviews} |`, `| outside pull request quiet minutes | ${quiet} |`];

  it('applies 3 reviews and 30 minutes when the rows are absent', () => {
    assert.deepEqual(outsideReviewRules(parseStoreConfig(fixtureStoreConfig())), { reviews: 3, quietMinutes: 30 });
  });

  it('reads both rows, citing the line of a row it refuses', () => {
    assert.deepEqual(outsideReviewRules(parseStoreConfig(fixtureStoreConfig({ limitRows: rows(2, 5) }))), { reviews: 2, quietMinutes: 5 });
    const bad = fixtureStoreConfig({ limitRows: rows(0, 5) });
    assert.throws(() => outsideReviewRules(parseStoreConfig(bad)), (err: Error) => err instanceof PolicyError
      && /"reviews per outside pull request" must be a positive whole number, in tickets\/store-config\.md:\d+:/.test(err.message));
  });

  it('moves the quiet period with the row', async () => {
    for (const [quiet, age, decision] of [[5, 6, 'dispatch'], [5, 4, 'skip'], [60, 31, 'skip'], [60, 61, 'dispatch']] as const) {
      const s = setup({ limitRows: rows(3, quiet) });
      s.clock.now = T0 + age * MIN;
      assert.equal(s.review(await s.pass({ dryRun: false, stages: ['review'] })).decision, decision, `quiet ${quiet}, age ${age}`);
    }
  });

  it('moves the review limit with the row', async () => {
    const s = setup({ limitRows: rows(2, 5) });
    for (let i = 0; i < 2; i++) await s.reviewThenPush();
    s.clock.now += 6 * MIN;
    const report = await s.pass();
    assert.match(s.review(report).reason, /review limit reached \(2\/2\)/);
    assert.equal(s.commands.ran.length, 2);
  });
});

describe('a person brings a stopped pull request back with review-again', () => {
  /** Three reviews at three heads, a fourth head pushed, and the loop stopped on it. */
  async function stopped(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    for (let i = 0; i < 3; i++) await s.reviewThenPush();
    s.clock.now += 31 * MIN;
    assert.match(s.review(await s.pass()).reason, /review limit reached \(3\/3\)/);
    assert.equal(s.commands.ran.length, 3);
    return s;
  }

  it('records the restart, takes the label back, and allows three more reviews, then stops again the same way', async () => {
    const s = await stopped();
    const stoppedAt = s.head();
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);

    const restart = await s.pass();
    const marker = newestReviewRestart(s.store.commentsBy.get(s.number) ?? []);
    assert.deepEqual(marker, { head: stoppedAt, counted: 3 }, 'the restart names the head and how many were counted before it');
    const note = s.store.commentsBy.get(s.number)!.find((c) => /larkspur-loop-review-again/.test(c.body))!;
    assert.ok(note.body.includes(stoppedAt.slice(0, 8)));
    assert.ok(writtenByLoop(note.body), 'the loop reads its own note as its own');
    assert.equal(operatorComment(s.store.commentsBy.get(s.number) ?? [])?.id === note.id, false);
    assert.ok(note.body.includes(LOOP_SIGNATURE));
    assert.ok(!s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL), 'the label is taken back');
    assert.ok(!s.store.pulls[0]!.labels.includes(STATUS_STOPPED), 'and loop:stopped no longer applies');
    assert.equal(s.review(restart).decision, 'dispatch', 'the head was already quiet, so the first of the next three runs');
    assert.equal(s.commands.ran.length, 4);

    s.clock.now += MIN;
    s.push();
    for (let i = 0; i < 2; i++) await s.reviewThenPush();
    assert.equal(s.commands.ran.length, 6, 'three reviews since the restart');
    assert.equal(s.commands.reviewsRun(SLUG, s.number).length, 6);

    s.clock.now += 31 * MIN;
    const again = await s.pass();
    assert.match(s.review(again).reason, /review limit reached \(3\/3\)/);
    assert.match(s.review(again).reason, new RegExp(`since the restart at ${stoppedAt.slice(0, 8)}`));
    assert.equal(s.commands.ran.length, 6);
    assert.ok(s.store.pulls[0]!.labels.includes(STATUS_STOPPED));
  });

  it('keeps the quiet period after the restart', async () => {
    const s = await stopped();
    s.clock.now += MIN;
    s.push();
    s.clock.now += 5 * MIN;
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    const report = await s.pass();
    assert.ok(newestReviewRestart(s.store.commentsBy.get(s.number) ?? []), 'the count restarted');
    assert.equal(s.review(report).decision, 'skip');
    assert.match(s.review(report).reason, /is 5 min old/);
    assert.equal(s.commands.ran.length, 3);
    assert.ok(!s.store.pulls[0]!.labels.includes(STATUS_STOPPED), 'queued, not stopped');
    s.clock.now += 26 * MIN;
    assert.equal(s.review(await s.pass()).decision, 'dispatch');
  });

  it('leaves the label and writes nothing in a dry run, and says the next real pass restarts the count', async () => {
    const s = await stopped();
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    const writes = s.store.writes.length;
    const report = await s.pass({ dryRun: true }, { store: new ReadOnlyStore(s.store) as never });
    assert.equal(s.store.writes.length, writes);
    assert.ok(s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL));
    assert.equal(newestReviewRestart(s.store.commentsBy.get(s.number) ?? []), undefined);
    assert.match(s.review(report).reason, /review-again is on it, and the next real pass restarts the count/);
  });

  it('posts one note however many passes see the label, and a second label with nothing reviewed since restarts nothing', async () => {
    const s = await stopped();
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    await s.pass({ dryRun: false, stages: ['shape'] });
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    await s.pass({ dryRun: false, stages: ['shape'] });
    const notes = s.store.commentsBy.get(s.number)!.filter((c) => /larkspur-loop-review-again/.test(c.body));
    assert.equal(notes.length, 1);
    assert.ok(!s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL), 'both labels were taken back');
  });

  it('takes the label back from a pull request the loop opened, which has no limit to restart, and says so on it once', async () => {
    const s = setup({ ticket: 701 });
    await s.store.addLabels(701, [REVIEW_AGAIN_LABEL]);
    const lines: string[] = [];
    await s.pass({ dryRun: false, stages: ['shape'] }, { log: (l) => lines.push(l) });
    assert.ok(!s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL));
    const notes = s.store.writes.filter((w) => w.kind === 'comment' && w.target === 701);
    assert.equal(notes.length, 1, 'the operator is told, where the label used to vanish without a word');
    assert.match(notes[0]!.body ?? '', /no review limit applies/);
    assert.ok(writtenByLoop(notes[0]!.body ?? ''), 'and the loop reads that note as its own');
    assert.ok(lines.some((l) => /review-again: PR #701 is a pull request the loop opened/.test(l)));
    await s.pass({ dryRun: false, stages: ['shape'] });
    assert.equal(s.store.writes.filter((w) => w.kind === 'comment' && w.target === 701).length, 1, 'a later pass says nothing more');
  });

  it('says so once when the pull request targets a base this loop does not review, and takes the label back', async () => {
    const s = setup();
    s.store.pulls[0]!.baseRefName = 'main';
    for (let i = 0; i < 2; i++) {
      await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
      await s.pass({ dryRun: false, stages: ['shape'] });
    }
    const notes = s.store.commentsBy.get(s.number)!.filter((c) => /larkspur-loop-declined label=review-again/.test(c.body));
    assert.equal(notes.length, 1, 'answered once, though the label came back');
    assert.match(notes[0]!.body, /targets `main`, and this loop reviews only pull requests against `dev`/);
    assert.ok(writtenByLoop(notes[0]!.body));
    assert.ok(!s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL), 'the label no longer sits on it for good');
  });

  it('says so when a second label finds the restart already standing', async () => {
    const s = await stopped();
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    await s.pass({ dryRun: false, stages: ['shape'] });
    await s.store.addLabels(s.number, [REVIEW_AGAIN_LABEL]);
    await s.pass({ dryRun: false, stages: ['shape'] });
    const notes = s.store.commentsBy.get(s.number)!.filter((c) => /larkspur-loop-declined label=review-again/.test(c.body));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.body, /already start counting again from/);
    assert.ok(!s.store.pulls[0]!.labels.includes(REVIEW_AGAIN_LABEL));
  });

  it('is a label the loop may take back and never apply', async () => {
    assert.ok((ONE_SHOT_LABELS as readonly string[]).includes(REVIEW_AGAIN_LABEL));
    const store = new FakeStore();
    store.addPull({ number: 10, headRefOid: SHA('a'), labels: [REVIEW_AGAIN_LABEL] });
    await assert.rejects(() => store.addLabel(10, REVIEW_AGAIN_LABEL), /person's to apply/);
    await store.removeLabel(10, REVIEW_AGAIN_LABEL);
    assert.deepEqual(store.pulls[0]!.labels, []);
  });

  it('reads only a restart marker of the exact form', () => {
    const head = SHA('h');
    assert.deepEqual(newestReviewRestart([{ body: `x\n${renderReviewAgainMarker({ head, counted: 3 })}` }]), { head, counted: 3 });
    assert.equal(newestReviewRestart([{ body: '<!-- larkspur-loop-review-again head=zz counted=3 -->' }, { body: 'review-again' }]), undefined);
    assert.deepEqual(newestReviewRestart([
      { body: renderReviewAgainMarker({ head, counted: 3 }) }, { body: 'x' }, { body: renderReviewAgainMarker({ head: SHA('later'), counted: 6 }) },
    ]), { head: SHA('later'), counted: 6 });
  });
});

describe('a re-review judges what changed since the loop last reviewed, whoever made the change', () => {
  const rule = (previous: string, head: string): RegExp => new RegExp(`new findings at medium or above that are in ${previous.slice(0, 8)}\\.\\.${head.slice(0, 8)}`);

  it('gives the second review of an outside pull request the previous review, its head, and the rule', async () => {
    const s = setup();
    const first = s.head();
    await s.reviewThenPush();
    const second = s.head();
    s.clock.now += 31 * MIN;
    await s.pass();
    const [one, two] = s.commands.dispatched;
    assert.ok(!/Previous review at/.test(one!.prompt), 'the first review covers the full diff');
    assert.match(two!.prompt, new RegExp(`Previous review at ${first.slice(0, 8)}`));
    assert.ok(two!.prompt.includes('Found one issue.'), 'the previous review travels with it');
    assert.match(two!.prompt, /each finding at medium or above from the previous review that remains unresolved/);
    assert.match(two!.prompt, rule(first, second));
    assert.match(two!.prompt, /a new finding outside that range only when it is high or critical/);
  });

  it('does the same for a pull request the loop opened when someone else pushed to it, with no fix round', async () => {
    const s = setup({ ticket: 701 });
    const first = s.head();
    s.clock.now = T0 + MIN;
    await s.pass({ dryRun: false, stages: ['review'] });
    s.clock.now += MIN;
    const second = s.push();
    await s.pass({ dryRun: false, stages: ['review'] });
    const [one, two] = s.commands.dispatched;
    assert.ok(!/Previous review at/.test(one!.prompt));
    assert.match(two!.prompt, new RegExp(`Previous review at ${first.slice(0, 8)}`));
    assert.match(two!.prompt, rule(first, second));
  });
});

describe('a pull request the loop opened keeps its review cycle', () => {
  it('has no review limit, however many heads it is reviewed at', async () => {
    const s = setup({ ticket: 701 });
    for (let i = 0; i < 5; i++) {
      s.clock.now += MIN;
      s.push();
      const report = await s.pass({ dryRun: false, stages: ['review'] });
      assert.equal(s.review(report).decision, 'dispatch', `review ${i + 1}`);
    }
    assert.equal(s.commands.ran.length, 5);
  });
});

describe('a description edit is a review too', () => {
  const rows = (reviews: number): string[] => [`| reviews per outside pull request | ${reviews} |`, '| outside pull request quiet minutes | 30 |'];

  /** Let the head age past the quiet period, run a pass, and have the author edit only the description. */
  async function reviewThenEdit(s: ReturnType<typeof setup>, n: number): Promise<PassReport> {
    s.clock.now += 31 * MIN;
    const report = await s.pass();
    s.store.pulls[0]!.body = `description, edit ${n}`;
    return report;
  }

  it('stops after the third review when the author only edits the description, as when they push', async () => {
    const s = setup();
    const head = s.head();
    const commits = s.store.commitsBy.get(s.number);
    s.clock.now = T0 + 31 * MIN;
    for (let n = 1; n <= 3; n++) {
      const report = await reviewThenEdit(s, n);
      assert.equal(s.review(report).decision, 'dispatch', `review ${n}`);
    }
    assert.equal(s.head(), head, 'no commit was pushed');
    assert.deepEqual(s.store.commitsBy.get(s.number), commits);
    assert.equal(s.commands.ran.length, 3);
    assert.equal(s.commands.reviewsRun(SLUG, s.number).length, 3, 'one review per description');

    s.clock.now += 31 * MIN;
    const stopped = await s.pass();
    assert.equal(s.review(stopped).decision, 'skip');
    assert.match(s.review(stopped).reason, /review limit reached \(3\/3\)/);
    assert.match(s.review(stopped).reason, /left for a person/);
    assert.ok(s.store.pulls[0]!.labels.includes(STATUS_STOPPED));
    assert.deepEqual(stopped.faults, []);

    // Further edits, and further passes, dispatch nothing.
    for (let n = 4; n <= 6; n++) {
      s.store.pulls[0]!.body = `description, edit ${n}`;
      s.clock.now += 15 * MIN;
      assert.match(s.review(await s.pass()).reason, /review limit reached \(3\/3\)/);
    }
    assert.equal(s.commands.ran.length, 3);
  });

  it('counts commits and description edits together', async () => {
    const s = setup();
    s.clock.now = T0 + 31 * MIN;
    await s.pass();                                  // review 1: head 1, original description
    s.store.pulls[0]!.body = 'description, edit 1';
    s.clock.now += 31 * MIN;
    await s.pass();                                  // review 2: head 1, edited description
    s.clock.now += MIN;
    s.push();
    s.clock.now += 31 * MIN;
    const third = await s.pass();                    // review 3: head 2, edited description
    assert.equal(s.review(third).decision, 'dispatch');
    assert.equal(s.commands.reviewsRun(SLUG, s.number).length, 3);
    s.store.pulls[0]!.body = 'description, edit 2';
    s.clock.now += 31 * MIN;
    assert.match(s.review(await s.pass()).reason, /review limit reached \(3\/3\)/);
    assert.equal(s.commands.ran.length, 3);
  });

  it('does not use a round to redo a not-independent review at the same head and description', async () => {
    const s = setup({ limitRows: rows(1) });
    s.commands.refuse.add('pi-local');
    s.clock.now = T0 + 31 * MIN;
    const first = await s.pass();
    assert.equal(s.review(first).decision, 'dispatch');
    assert.equal(newestReview(s.store.commentsBy.get(s.number) ?? [])?.independent, false, 'only the author\'s own family could run');
    assert.equal(s.commands.reviewsRun(SLUG, s.number).length, 1);

    // The independent tier becomes reachable; the redo is at the limit (1/1) and still runs.
    s.commands.refuse.delete('pi-local');
    s.clock.now += 20 * MIN;
    const redo = await s.pass();
    assert.equal(s.review(redo).decision, 'dispatch', 'redone by the independent tier');
    assert.equal(s.commands.dispatched.at(-1)?.runtime, 'pi-local');
    assert.equal(newestReview(s.store.commentsBy.get(s.number) ?? [])?.independent, true);
    assert.equal(s.commands.ran.length, 2);
    assert.equal(s.commands.reviewsRun(SLUG, s.number).length, 1, 'still one review of that head and description');

    // A description edit is a new review, and the limit of one is reached.
    s.store.pulls[0]!.body = 'description, edit 1';
    s.clock.now += 20 * MIN;
    const stopped = await s.pass();
    assert.match(s.review(stopped).reason, /review limit reached \(1\/1\)/);
    assert.equal(s.commands.ran.length, 2);
  });
});

describe('the loop counts its own review runs for a pull request', () => {
  const run = (id: string, startedAt: string, over: Partial<RunRecord> = {}, loop: Partial<NonNullable<RunRecord['loop']>> = {}): RunRecord => ({
    id, taskId: id, attempt: 1, authority: { type: 'grant', id: 'grant_x', version: 1 },
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, runtime: 'pi-local', profile: 'default', actions: ['review'],
    settings: { requested: { model: 'm', effort: 'e' }, resolved: { model: 'm', effort: 'e' }, observed: { model: 'unknown', effort: 'unknown' } },
    startedAt, status: 'completed', repo: SLUG, workClass: 'loop-review', runtimeDispatched: true,
    loop: { stage: 'review', item: 'PR #750', workType: 'untyped', head: 'a'.repeat(40), ...loop }, ...over,
  });

  it('lists what each review was given, oldest first and each head and description once, whether or not a result was recorded', () => {
    const [a, b, c] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] as [string, string, string];
    const [d1, d2] = ['1'.repeat(64), '2'.repeat(64)] as [string, string];
    // Written newest first, so the order read back is the run's own, not the file system's.
    saveRun(run('run_5', '2026-10-01T16:00:00Z', {}, { head: c, bodyDigest: d2 }));
    saveRun(run('run_1', '2026-10-01T13:00:00Z', {}, { head: a, bodyDigest: d1 }));
    saveRun(run('run_2', '2026-10-01T14:00:00Z', {}, { head: b.toUpperCase(), bodyDigest: d1 }));
    saveRun(run('run_2b', '2026-10-01T14:30:00Z', {}, { head: b, bodyDigest: d1 }));
    // The same head again after the description changed is another review.
    saveRun(run('run_3', '2026-10-01T15:00:00Z', {}, { head: b, bodyDigest: d2 }));
    // A run from before the description was recorded has none, and is its own entry.
    saveRun(run('run_legacy', '2026-10-01T12:00:00Z', {}, { head: a }));
    assert.deepEqual(coordinatorCommands().reviewsRun(SLUG, 750), [
      { head: a }, { head: a, bodyDigest: d1 }, { head: b, bodyDigest: d1 }, { head: b, bodyDigest: d2 }, { head: c, bodyDigest: d2 },
    ]);
  });

  it('leaves out a run that reviewed nothing, another pull request, another repository, and other work', () => {
    saveRun(run('run_ok', '2026-10-01T13:00:00Z', {}, { head: '1'.repeat(40) }));
    saveRun(run('run_unsent', '2026-10-01T13:10:00Z', { runtimeDispatched: false }, { head: '2'.repeat(40) }));
    saveRun(run('run_noprompt', '2026-10-01T13:20:00Z', { promptNotSent: true }, { head: '3'.repeat(40) }));
    saveRun(run('run_quota', '2026-10-01T13:30:00Z', { status: 'quota-waiting' }, { head: '4'.repeat(40) }));
    saveRun(run('run_other_pr', '2026-10-01T13:40:00Z', {}, { head: '5'.repeat(40), item: 'PR #751' }));
    saveRun(run('run_other_repo', '2026-10-01T13:50:00Z', { repo: 'other/repo' }, { head: '6'.repeat(40) }));
    saveRun(run('run_fix', '2026-10-01T14:00:00Z', { workClass: 'loop-fix' }, { head: '7'.repeat(40), stage: 'fix' }));
    const headless = run('run_headless', '2026-10-01T14:10:00Z');
    delete headless.loop!.head;
    saveRun(headless);
    assert.deepEqual(coordinatorCommands().reviewsRun(SLUG, 750), [{ head: '1'.repeat(40) }]);
  });
});
