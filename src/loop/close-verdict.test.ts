import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { VERDICT_CLOSE_MARKER } from './markers.js';
import { runPass } from './pass.js';
import { parseCloseVerdicts } from './stages/close.js';
import { FIXTURE_FLOOR, completed, FakeCommands, FakeRepo, FakeStore, fixtureRules, fixtureStoreConfig, outputFileIn, SHA } from './testkit.js';
import type { DispatchTaskInput } from '../commands.js';
import type { DispatchCommandResult } from '../commands.js';
import type { DerivedVerdict } from '../console/verdicts.js';
import { DERIVATION_RULES, derivationContext } from '../console/verdicts.js';
import type { IssueFact, StoreSnapshot } from '../console/snapshot.js';
import type { Scorecard } from '../eval/scorecard.js';

/**
 * Tests for the close stage's verdict-close path.
 *
 * The assess run appends CLOSE_VERDICT lines to its output. The close stage
 * reads those lines from the current assessment comment and closes each listed
 * ticket as not planned, posting one comment with the VERDICT_CLOSE_MARKER.
 *
 * AC-4.1 — a current close verdict closes the ticket in the same pass
 * AC-4.2 — the close path leaves alone what it must
 * AC-4.3 — a failed pass neither duplicates a close nor hides it
 * AC-4.4 — a verdict close by the loop does not count as the owner rejecting a proposal
 */

let box: Sandbox;
beforeEach(() => { box = sandbox(); writeFloor(FIXTURE_FLOOR); });
afterEach(() => box.cleanup());

function deps(store: FakeStore, commands = new FakeCommands(), repo = new FakeRepo()) {
  return { store, commands, repo, rules: fixtureRules() };
}

/** A dispatch that writes `text` to the output file its prompt names. */
function writing(text: (input: DispatchTaskInput) => string) {
  return (input: DispatchTaskInput): DispatchCommandResult => {
    const path = outputFileIn(input.prompt);
    if (path) writeFileSync(path, text(input), 'utf8');
    return completed(input);
  };
}

/**
 * Compute the fingerprint the fixture rules use for a given set of candidate
 * numbers and base SHA. This lets a test pre-populate an assessment comment
 * that the close stage will find current, without first running the assess stage.
 */
function fixtureFingerprint(candidateNumbers: number[], devHead = SHA('origin/dev')): string {
  return createHash('sha256').update(`${devHead}${candidateNumbers.join(',')}`).digest('hex');
}

/**
 * Build an assessment body that the fixture rules will find current for the
 * given candidates, with the supplied CLOSE_VERDICT lines appended.
 */
function assessmentBody(candidateNumbers: number[], closeVerdictLines: string[]): string {
  const fp = fixtureFingerprint(candidateNumbers);
  return [
    '<!-- fixture-assessment -->',
    `<!-- fixture-afp:${fp} -->`,
    '',
    '## Should be closed',
    candidateNumbers.map((n) => `- #${n}: some evidence from the checkout`).join('\n'),
    '',
    ...closeVerdictLines,
  ].join('\n');
}

/** Store configuration with verdict closes enabled. */
const VERDICT_CLOSE_CONFIG = fixtureStoreConfig({
  limitRows: ['| close on assessment verdict | yes |'],
});

/** Store configuration without verdict closes (default). */
const NO_VERDICT_CLOSE_CONFIG = fixtureStoreConfig();

/* ------------------------------------------------------------------ AC-4.1 */

describe('verdict close: AC-4.1 — a current close verdict closes the ticket in the same pass', () => {
  it('closes a ticket on a duplicate verdict in the same pass', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 42, labels: ['effort:home'], title: 'duplicate issue', body: 'body' });
    const body = assessmentBody([42], ['CLOSE_VERDICT: ticket=#42 kind=duplicate dup=#37']);
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    const report = await runPass(d, { dryRun: false, stages: ['close'] });

    const closeItem = report.stages[0]!.items.find((i) => i.ref === '#42');
    assert.equal(closeItem?.decision, 'dispatch', 'verdict close is dispatched');

    assert.equal(store.issues.find((i) => i.number === 42)?.state, 'CLOSED', 'ticket is closed');
    const comments42 = store.commentsBy.get(42) ?? [];
    const verdictComment = comments42.find((c) => c.body.includes(VERDICT_CLOSE_MARKER));
    assert.ok(verdictComment, 'one VERDICT_CLOSE_MARKER comment posted');
    assert.match(verdictComment!.body, /#37/, 'comment names the duplicate');

    const closeWrite = store.writes.find((w) => w.kind === 'close' && w.target === 42);
    assert.equal(closeWrite?.body, 'not planned', 'closed as not planned');
  });

  it('closes a ticket on an already-done verdict in the same pass', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 43, labels: ['effort:home'], body: 'feature already shipped' });
    const body = assessmentBody([43], ['CLOSE_VERDICT: ticket=#43 kind=already-done']);
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });

    assert.equal(store.issues.find((i) => i.number === 43)?.state, 'CLOSED');
    const c = (store.commentsBy.get(43) ?? []).find((c) => c.body.includes(VERDICT_CLOSE_MARKER));
    assert.ok(c, 'verdict close comment posted');
    assert.match(c!.body, /already done/, 'comment states the kind');
    assert.equal(store.writes.find((w) => w.kind === 'close' && w.target === 43)?.body, 'not planned');
  });

  it('closes a ticket on a no-longer-true verdict in the same pass', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 44, labels: ['effort:home'], body: 'now moot' });
    const body = assessmentBody([44], ['CLOSE_VERDICT: ticket=#44 kind=no-longer-true']);
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });

    assert.equal(store.issues.find((i) => i.number === 44)?.state, 'CLOSED');
    const c = (store.commentsBy.get(44) ?? []).find((c) => c.body.includes(VERDICT_CLOSE_MARKER));
    assert.ok(c, 'verdict close comment posted');
    assert.match(c!.body, /no longer true/, 'comment states the kind');
    assert.equal(store.writes.find((w) => w.kind === 'close' && w.target === 44)?.body, 'not planned');
  });

  it('closes multiple tickets in one pass when the assessment lists several verdicts', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 50, labels: ['effort:home'], body: 'dup' });
    store.addIssue({ number: 51, labels: ['effort:home'], body: 'done' });
    const body = assessmentBody([50, 51], [
      'CLOSE_VERDICT: ticket=#50 kind=duplicate dup=#12',
      'CLOSE_VERDICT: ticket=#51 kind=already-done',
    ]);
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });

    assert.equal(store.issues.find((i) => i.number === 50)?.state, 'CLOSED');
    assert.equal(store.issues.find((i) => i.number === 51)?.state, 'CLOSED');
  });
});

/* ------------------------------------------------------------------ AC-4.2 */

describe('verdict close: AC-4.2 — the close path leaves alone what it must', () => {
  function setup(candidateNumbers: number[], verdictLines: string[], config = VERDICT_CLOSE_CONFIG) {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    const body = assessmentBody(candidateNumbers, verdictLines);
    store.addComment(1, body);
    return { store, repo: new FakeRepo(config) };
  }

  it('skips a ticket with a human assignee', async () => {
    const { store, repo } = setup([60], ['CLOSE_VERDICT: ticket=#60 kind=already-done']);
    store.addIssue({ number: 60, labels: ['effort:home'], assignees: ['alice'] });
    const d = deps(store, new FakeCommands(), repo);
    await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 60)?.state, 'OPEN');
    const item = (await runPass(d, { dryRun: false, stages: ['close'] })).stages[0]!.items.find((i) => i.ref === '#60');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /human assignee/);
  });

  it('skips a ticket with the HUMAN label', async () => {
    const { store, repo } = setup([61], ['CLOSE_VERDICT: ticket=#61 kind=already-done']);
    store.addIssue({ number: 61, labels: ['effort:home', 'HUMAN'] });
    const d = deps(store, new FakeCommands(), repo);
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 61)?.state, 'OPEN');
    const item = report.stages[0]!.items.find((i) => i.ref === '#61');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /HUMAN label/);
  });

  it('skips a ticket that carries auto', async () => {
    // auto candidates are excluded from fixtureRules().candidates, so the fingerprint
    // must be computed without them (candidateNumbers=[62] but #62 has auto)
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    // For this test: #62 has auto so it won't be a candidate; fingerprint for empty set
    const fp = fixtureFingerprint([]);
    const body = `<!-- fixture-assessment -->\n<!-- fixture-afp:${fp} -->\n\nsome text about #62\n\nCLOSE_VERDICT: ticket=#62 kind=already-done`;
    store.addComment(1, body);
    store.addIssue({ number: 62, labels: ['effort:home', 'auto'] });

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 62)?.state, 'OPEN');
    const item = report.stages[0]!.items.find((i) => i.ref === '#62');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /auto label/);
  });

  it('skips a ticket that carries escalated', async () => {
    const { store, repo } = setup([63], ['CLOSE_VERDICT: ticket=#63 kind=already-done']);
    store.addIssue({ number: 63, labels: ['effort:home', 'escalated'] });
    const d = deps(store, new FakeCommands(), repo);
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 63)?.state, 'OPEN');
    const item = report.stages[0]!.items.find((i) => i.ref === '#63');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /escalated label/);
  });

  it('skips the effort tracking issue itself', async () => {
    // Tracking issue is #1; if the assessment somehow lists #1 as a close verdict, skip it.
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    const fp = fixtureFingerprint([]);
    const body = `<!-- fixture-assessment -->\n<!-- fixture-afp:${fp} -->\n\ntracking issue evidence\n\nCLOSE_VERDICT: ticket=#1 kind=already-done`;
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 1)?.state, 'OPEN');
    const item = report.stages[0]!.items.find((i) => i.ref === '#1');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /tracking issue/);
  });

  it('skips when the assessment is stale (candidate set changed since it was written)', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    // Write an assessment fingerprinted for no candidates...
    const fp = fixtureFingerprint([]);
    const body = `<!-- fixture-assessment -->\n<!-- fixture-afp:${fp} -->\n\nevidence\n\nCLOSE_VERDICT: ticket=#64 kind=already-done`;
    store.addComment(1, body);
    // ...but then add candidate #64, making the fingerprint stale.
    store.addIssue({ number: 64, labels: ['effort:home'], body: 'a new candidate' });

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 64)?.state, 'OPEN', 'stale assessment: no close');
    // No dispatch for #64 because the whole effort was skipped due to stale assessment.
    const items = (await runPass(d, { dryRun: true, stages: ['close'] })).stages[0]!.items;
    assert.ok(!items.some((i) => i.ref === '#64' && i.decision === 'dispatch'), 'stale assessment skips the effort');
  });

  it('skips a duplicate verdict with no dup number', async () => {
    const { store, repo } = setup([65], ['CLOSE_VERDICT: ticket=#65 kind=duplicate']);
    store.addIssue({ number: 65, labels: ['effort:home'], body: 'dup' });
    const d = deps(store, new FakeCommands(), repo);
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 65)?.state, 'OPEN');
    const item = report.stages[0]!.items.find((i) => i.ref === '#65');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /no dup number/);
  });

  it('skips an already-done verdict whose assessment gives no evidence for the ticket', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    const body = assessmentBody([68], ['CLOSE_VERDICT: ticket=#68 kind=already-done'])
      .replace('- #68: some evidence from the checkout', '- evidence that names no ticket');
    store.addComment(1, body);
    store.addIssue({ number: 68, labels: ['effort:home'], body: 'no evidence' });
    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 68)?.state, 'OPEN');
    assert.deepEqual(store.writes.filter((w) => w.target === 68), [], 'no comment without evidence');
    const item = report.stages[0]!.items.find((i) => i.ref === '#68');
    assert.equal(item?.decision, 'skip');
    assert.match(item?.reason ?? '', /no prose evidence/);
  });

  it('skips when setting is absent (default off)', async () => {
    const { store } = setup([66], ['CLOSE_VERDICT: ticket=#66 kind=already-done'], NO_VERDICT_CLOSE_CONFIG);
    store.addIssue({ number: 66, labels: ['effort:home'], body: 'default off' });
    const d = deps(store, new FakeCommands(), new FakeRepo(NO_VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 66)?.state, 'OPEN', 'without the setting, verdict closes are off');
  });

  it('an assessment with no CLOSE_VERDICT lines is posted and read exactly as before', async () => {
    // The assess stage and the console's assessmentGrantsTicket must both work with
    // an assessment that has no CLOSE_VERDICT lines (the common case).
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 67, labels: ['effort:home'] });
    // Run assess stage (scripted to produce a plain assessment with no CLOSE_VERDICT lines)
    const plainAssessment = '### Ready to grant\n- #67: meets all conditions (ready to grant)';
    const d = deps(store, new FakeCommands(writing(() => plainAssessment)), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['assess'] });
    // The close stage should not interact with this assessment (no CLOSE_VERDICT lines)
    const beforeClose = store.writes.length;
    await runPass(d, { dryRun: false, stages: ['close'] });
    const closingWrites = store.writes.slice(beforeClose).filter((w) => w.target === 67);
    assert.deepEqual(closingWrites, [], 'close stage does not touch a ticket with no close verdict');
  });
});

/* ------------------------------------------------------------------ AC-4.3 */

describe('verdict close: AC-4.3 — a failed pass neither duplicates a close nor hides it', () => {
  it('finishes the close on a retry without posting a second VERDICT_CLOSE comment', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 70, labels: ['effort:home'], body: 'duplicate' });
    const body = assessmentBody([70], ['CLOSE_VERDICT: ticket=#70 kind=duplicate dup=#5']);
    store.addComment(1, body);

    const realClose = store.closeIssue.bind(store);
    let failures = 1;
    store.closeIssue = (n: number, reason?: 'completed' | 'not planned') =>
      failures-- > 0 ? Promise.reject(new Error('GitHub 503')) : realClose(n, reason);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));

    // First pass: posts the comment, fails to close.
    const first = await runPass(d, { dryRun: false, stages: ['close'] });
    assert.match(first.stages[0]!.items[0]!.result ?? '', /error: GitHub 503/);
    assert.equal(store.issues.find((i) => i.number === 70)?.state, 'OPEN');
    const commentCount = (store.commentsBy.get(70) ?? []).filter((c) => c.body.includes(VERDICT_CLOSE_MARKER)).length;
    assert.equal(commentCount, 1, 'exactly one VERDICT_CLOSE comment after the failed first pass');

    // Second pass: finds the comment, skips reposting, closes the ticket.
    await runPass(d, { dryRun: false, stages: ['close'] });
    assert.equal(store.issues.find((i) => i.number === 70)?.state, 'CLOSED');
    assert.equal(
      (store.commentsBy.get(70) ?? []).filter((c) => c.body.includes(VERDICT_CLOSE_MARKER)).length,
      1, 'still exactly one VERDICT_CLOSE comment after the retry',
    );
  });

  it('writes no comment and no close for a ticket that is already closed', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    // #71 is already closed
    store.addIssue({ number: 71, labels: ['effort:home'], state: 'CLOSED', body: 'done' });
    // The fingerprint must match what the already-closed issue contributes; since it's
    // already CLOSED, it won't be in rules.candidates (candidates only takes OPEN issues).
    const fp = fixtureFingerprint([]);
    const body = `<!-- fixture-assessment -->\n<!-- fixture-afp:${fp} -->\n\nevidence\n\nCLOSE_VERDICT: ticket=#71 kind=already-done`;
    store.addComment(1, body);

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    await runPass(d, { dryRun: false, stages: ['close'] });

    const comments71 = store.commentsBy.get(71) ?? [];
    assert.ok(!comments71.some((c) => c.body.includes(VERDICT_CLOSE_MARKER)), 'no comment on an already-closed ticket');
    const closeWrites = store.writes.filter((w) => w.kind === 'close' && w.target === 71);
    assert.deepEqual(closeWrites, [], 'no close write for an already-closed ticket');
  });

  it('records a fault when the store refuses a close, and names the ticket', async () => {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:home'] });
    store.addIssue({ number: 72, labels: ['effort:home'], body: 'duplicate' });
    const body = assessmentBody([72], ['CLOSE_VERDICT: ticket=#72 kind=duplicate dup=#8']);
    store.addComment(1, body);

    store.closeIssue = () => Promise.reject(new Error('GitHub 422 Unprocessable Entity'));

    const d = deps(store, new FakeCommands(), new FakeRepo(VERDICT_CLOSE_CONFIG));
    const report = await runPass(d, { dryRun: false, stages: ['close'] });
    const item = report.stages[0]!.items.find((i) => i.ref === '#72');
    assert.equal(item?.decision, 'dispatch', 'the item was dispatched (not silently skipped)');
    assert.match(item?.result ?? '', /error:/, 'the fault is visible in the item result');
  });
});

/* ------------------------------------------------------------------ AC-4.4 */

describe('verdict close: AC-4.4 — a loop verdict close does not count as the owner rejecting a proposal', () => {
  /** Build a minimal snapshot with a closed issue whose comments control whether
   * the close looks like a loop verdict close or a person close. */
  function buildSnapshot(opts: { hasVerdictCloseComment: boolean; closedAt: string }): StoreSnapshot {
    const comments = opts.hasVerdictCloseComment
      ? [{ id: 1, body: `${VERDICT_CLOSE_MARKER}\nClosing on verdict.`, author: 'operator', createdAt: opts.closedAt }]
      : [];
    const issue: IssueFact = {
      number: 42, title: 'test', state: 'CLOSED', labels: [], assignees: [], body: '', comments,
      events: [], closes: [{ actor: 'operator', at: opts.closedAt, reason: 'NOT_PLANNED' }], edits: [],
    };
    return { repo: 'example-org/larkspur', takenAt: opts.closedAt, issues: [], pulls: [], referencedIssues: [issue], referencedPulls: [] };
  }

  function buildCard(issueNumber: number, createdAt: string): Scorecard {
    return {
      id: 'card-1', taskId: 'task-1', runtime: 'claude-local', finalStatus: 'completed',
      checks: [], reviews: [], repairs: [], runIds: [], stops: [],
      createdAt,
      loop: { stage: 'shape', item: `#${issueNumber}`, workType: 'feature' },
    } as unknown as Scorecard;
  }

  it('gives no rejected verdict when the loop closed the ticket on a verdict', () => {
    const closedAt = '2026-11-05T10:00:00Z';
    const snap = buildSnapshot({ hasVerdictCloseComment: true, closedAt });
    const ctx = derivationContext(snap, '<!-- fixture-shape -->');
    const rule = DERIVATION_RULES.find((r) => r.id === 'closed-not-planned')!;
    const card = buildCard(42, '2026-11-04T10:00:00Z');
    const verdicts = rule.derive(card, ctx);
    assert.deepEqual(verdicts, [], 'no rejected verdict when the loop closed on a verdict');
  });

  it('gives a rejected verdict when a person closed the ticket as not planned', () => {
    const closedAt = '2026-11-05T10:00:00Z';
    const snap = buildSnapshot({ hasVerdictCloseComment: false, closedAt });
    const ctx = derivationContext(snap, '<!-- fixture-shape -->');
    const rule = DERIVATION_RULES.find((r) => r.id === 'closed-not-planned')!;
    const card = buildCard(42, '2026-11-04T10:00:00Z');
    const verdicts = rule.derive(card, ctx) as DerivedVerdict[];
    assert.equal(verdicts.length, 1, 'one rejected verdict when a person closes not planned');
    assert.equal(verdicts[0]!.verdict, 'rejected');
  });
});

/* ----------------------------------------------------- parseCloseVerdicts */

describe('parseCloseVerdicts', () => {
  it('parses valid CLOSE_VERDICT lines', () => {
    const body = [
      '## Should be closed',
      'Some prose about #42.',
      '',
      'CLOSE_VERDICT: ticket=#42 kind=duplicate dup=#37',
      'CLOSE_VERDICT: ticket=#43 kind=already-done',
      'CLOSE_VERDICT: ticket=#44 kind=no-longer-true',
    ].join('\n');
    assert.deepEqual(parseCloseVerdicts(body), [
      { ticket: 42, kind: 'duplicate', dup: 37 },
      { ticket: 43, kind: 'already-done' },
      { ticket: 44, kind: 'no-longer-true' },
    ]);
  });

  it('returns an empty array when there are no CLOSE_VERDICT lines', () => {
    assert.deepEqual(parseCloseVerdicts('No machine-readable lines here.'), []);
  });

  it('ignores malformed lines without silently corrupting the parse', () => {
    const body = [
      'CLOSE_VERDICT: ticket=#42 kind=duplicate dup=#37',
      'CLOSE_VERDICT: not-a-valid-line',
      'CLOSE_VERDICT: ticket=#43 kind=unknown-kind',
      'CLOSE_VERDICT: ticket=#44 kind=already-done',
    ].join('\n');
    const result = parseCloseVerdicts(body);
    assert.equal(result.length, 2, 'only the two valid lines are parsed');
    assert.equal(result[0]!.ticket, 42);
    assert.equal(result[1]!.ticket, 44);
  });

  it('a duplicate kind without dup= has no dup field', () => {
    const result = parseCloseVerdicts('CLOSE_VERDICT: ticket=#10 kind=duplicate');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, 'duplicate');
    assert.equal(result[0]!.dup, undefined, 'no dup field when dup= is absent');
  });
});
