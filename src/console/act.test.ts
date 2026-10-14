import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCoordinatorCommands } from '../commands.js';
import { OPERATOR, sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { getScorecard, saveScorecard } from '../eval/scorecard.js';
import { GitRepo } from '../loop/git.js';
import { renderReviewMarker } from '../loop/markers.js';
import { fixtureStoreConfig, SHA } from '../loop/testkit.js';
import type { ActResult } from '../loop/types.js';
import { assessmentGrantsTicket, createConsoleCommands } from './commands.js';
import type { StoreFile } from './file-store.js';
import { FileStore } from './file-store.js';
import { consoleTarget } from './service.js';
import { card, comment, fixtureTargetRepo, issue, proposal, pull, review, RULES, snapshot, writeStoreFile } from './testkit.js';

let box: Sandbox;
let dir: string;
beforeEach(() => { box = sandbox(); dir = mkdtempSync(join(tmpdir(), 'console-act-')); });
afterEach(() => { box.cleanup(); rmSync(dir, { recursive: true, force: true }); });

async function world(merge: (ref: string) => Promise<ActResult> = () => Promise.reject(new Error('the merge stage passes over it'))) {
  const root = mkdtempSync(join(dir, 'w-'));
  const { path } = fixtureTargetRepo(root, fixtureStoreConfig({ typeRows: ['| `type:chore` | 5 |'] }));
  const head = SHA('h');
  const storePath = join(root, 'store.json');
  writeStoreFile(storePath, snapshot({
    issues: [issue(1, { body: 'b', comments: [proposal('b')] }), issue(2, { labels: ['type:chore'] })],
    pulls: [pull(102, { headRefName: 'ticket/2', headRefOid: head, comments: [review(head, 0)] })],
  }));
  saveScorecard(card('card_loop-shape-1-aa', { stage: 'shape', item: '#1', workType: 'untyped' }));
  const store = new FileStore(storePath);
  const repo = new GitRepo(path);
  const merges: string[] = [];
  const c = createConsoleCommands({
    target: await consoleTarget(repo, store), store, git: repo, coordinator: createCoordinatorCommands(),
    mergeStage: (ref) => { merges.push(ref); return merge(ref); },
  });
  const writes = (): StoreFile['writes'] => (JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile).writes;
  return { c, writes, merges, storePath, store, repo };
}

async function assessed(w: Awaited<ReturnType<typeof world>>, text: string, stale = false): Promise<void> {
  const data = JSON.parse(readFileSync(w.storePath, 'utf8')) as StoreFile;
  data.issues[0]!.labels = ['shaped', 'effort:e'];
  data.issues.push(issue(3, { labels: ['effort', 'effort:e'] }));
  writeFileSync(w.storePath, JSON.stringify(data));
  const decision = RULES.decide({ issues: await w.store.listOpenIssues(), effortLabel: 'effort:e', dependencyStates: {},
    devHead: await w.repo.revParse('origin/dev'), priorComment: null });
  data.issues.find((entry) => entry.number === 3)!.comments.push(comment(`${RULES.MARKER}\n${RULES.renderFingerprint(stale ? '0'.repeat(64) : decision.fingerprint)}\n\n${text}`));
  writeFileSync(w.storePath, JSON.stringify(data));
}

describe('console actions go through the command layer', () => {
  it('performs the item\'s action and then records the verdict it carries', async () => {
    const { c, writes } = await world();
    const expected = (await c.inspect('#1')).actionToken!;
    const result = await c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected, verdict: { cardId: 'card_loop-shape-1-aa', verdict: 'accepted', reason: 'clear shape' } });
    assert.equal(result.did, 'labeled #1 shaped');
    assert.deepEqual(writes().map((w) => [w.kind, w.target, w.detail]), [['add-labels', 1, 'shaped']]);
    assert.equal(getScorecard('card_loop-shape-1-aa')?.feedback?.verdict, 'accepted');
  });

  it('refuses an action the item does not offer, a scorecard not about it, and anyone but the operator — writing nothing', async () => {
    const { c, writes } = await world();
    const expected = (await c.inspect('#1')).actionToken!;
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'dismiss-fault', expected }), /its action is apply-shaped, not dismiss-fault/);
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected, verdict: { cardId: 'card_other', verdict: 'accepted', reason: 'x' } }), /is not about #1/);
    await assert.rejects(c.act({ kind: 'agent', id: 'run_x' }, { ref: '#1', action: 'apply-shaped', expected }), /cannot issue or change authority/);
    await assert.rejects(c.act(OPERATOR, { ref: '#2', action: 'apply-shaped', expected: (await c.inspect('#2')).actionToken ?? expected }), /is not waiting on you/);
    assert.deepEqual(writes(), []);
  });

  it('shows exact proposal and review content, and refuses a changed fingerprint, head or unreadable store without writes', async () => {
    const { c, writes, storePath } = await world();
    const proposed = await c.inspect('#1');
    assert.equal(proposed.evidence[0]?.kind, 'proposal');
    assert.match(proposed.evidence[0]?.text ?? '', /the draft/);
    assert.equal(proposed.evidence[0]?.current, true);
    const old = proposed.actionToken!;
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
    data.issues[0]!.comments[0]!.body += '\nnew proposal text';
    writeFileSync(storePath, JSON.stringify(data));
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected: old }), /changed since Inspect/);
    data.issues[0]!.comments[0]!.body = proposed.evidence[0]!.text;
    data.issues[0]!.body = 'changed body';
    writeFileSync(storePath, JSON.stringify(data));
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected: old }), /not waiting on you|changed since Inspect/);
    assert.deepEqual(writes(), []);
    data.issues[0]!.body = 'b';
    data.failRead = 'network unavailable';
    writeFileSync(storePath, JSON.stringify(data));
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected: old }), /store read failed/);
    assert.deepEqual(writes(), []);
    delete data.failRead;
    writeFileSync(storePath, JSON.stringify(data));
    const reviewed = await c.inspect('PR #102');
    assert.equal(reviewed.evidence[0]?.kind, 'review');
    assert.equal(reviewed.evidence[0]?.current, true);
    data.pulls[0]!.headRefOid = SHA('new-head');
    writeFileSync(storePath, JSON.stringify(data));
    await assert.rejects(c.act(OPERATOR, { ref: 'PR #102', action: 'merge', expected: reviewed.actionToken! }), /not waiting on you|changed since Inspect/);
    assert.deepEqual(writes(), []);
  });

  it('marks a supported abbreviated review marker current at the full head', async () => {
    const { c, storePath } = await world();
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
    const head = data.pulls[0]!.headRefOid;
    data.pulls[0]!.comments = [review(head.slice(0, 7), 0, true, data.pulls[0]!.body ?? '')];
    writeFileSync(storePath, JSON.stringify(data));
    const inspect = await c.inspect('PR #102');
    assert.equal(inspect.evidence.find((e) => e.kind === 'review')?.current, true);
  });

  it('marks a same-head review stale after the description changes, including digestless historical reviews', async () => {
    const { c, storePath } = await world();
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
    const head = data.pulls[0]!.headRefOid;
    data.pulls[0]!.body = 'Revised description.';
    writeFileSync(storePath, JSON.stringify(data));
    const stale = await c.inspect('PR #102');
    assert.equal(stale.item.column, 'In review');
    assert.equal(stale.evidence.find((e) => e.kind === 'review')?.current, false);

    data.pulls[0]!.comments = [comment(renderReviewMarker({ sha: head, findings: 0, independent: true, reviewer: 'model·high' }))];
    writeFileSync(storePath, JSON.stringify(data));
    assert.equal((await c.inspect('PR #102')).evidence.find((e) => e.kind === 'review')?.current, false);

    data.pulls[0]!.comments.push(review(head, 0, true, data.pulls[0]!.body!));
    writeFileSync(storePath, JSON.stringify(data));
    assert.equal((await c.inspect('PR #102')).evidence.find((e) => e.kind === 'review')?.current, true);
  });

  it('rejects an appended comment between fresh snapshot and the write', async () => {
    const { c, writes, storePath, store } = await world();
    const expected = (await c.inspect('#1')).actionToken!;
    const liveComments = store.comments.bind(store);
    store.comments = async (n) => {
      if (n === 1) {
        const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
        data.issues[0]!.comments.push(comment('A newer instruction after Inspect.'));
        writeFileSync(storePath, JSON.stringify(data));
      }
      return liveComments(n);
    };
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-shaped', expected }), /evidence changed|discussion changed|Refresh Inspect/);
    assert.deepEqual(writes(), []);
  });

  it('does not grant auto where the assessment to read is unavailable', async () => {
    const { c, writes, storePath } = await world();
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
    data.issues[0]!.labels = ['shaped', 'effort:e'];
    writeFileSync(storePath, JSON.stringify(data));
    const inspect = await c.inspect('#1');
    assert.equal(inspect.evidence.some((e) => e.kind === 'assessment'), false);
    assert.equal(inspect.item.action, 'apply-auto');
    await assert.rejects(c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /No assessment is available/);
    assert.deepEqual(writes(), []);
  });

  it('refuses a marked assessment that says another ticket was assessed or the queue was clear', async () => {
    for (const text of ['#2: ready for auto', 'No open ticket awaits a verdict.']) {
      const w = await world();
      await assessed(w, text);
      const inspect = await w.c.inspect('#1');
      assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, false);
      await assert.rejects(w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /current assessment|No assessment/);
      assert.deepEqual(w.writes(), []);
    }
  });

  it('refuses a ticket verdict with a stale queue fingerprint', async () => {
    const w = await world();
    await assessed(w, '#1: ready for auto', true);
    const inspect = await w.c.inspect('#1');
    assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, false);
    await assert.rejects(w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /current assessment/);
    assert.deepEqual(w.writes(), []);
  });

  it('refuses a current assessment saying not yet with an open dependency', async () => {
    const w = await world();
    const data = JSON.parse(readFileSync(w.storePath, 'utf8')) as StoreFile;
    data.issues[0]!.body = 'Depends on: #99';
    data.issues.push(issue(99));
    writeFileSync(w.storePath, JSON.stringify(data));
    await assessed(w, '#1 not yet Depends on #99');
    const inspect = await w.c.inspect('#1');
    assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, false);
    await assert.rejects(w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /current assessment/);
    assert.deepEqual(w.writes(), []);
  });

  it('refuses incidental mentions, negative verdicts and conflicting per-ticket text', () => {
    for (const text of [
      '#1 is discussed here.',
      '## Ready to grant — one ticket\nThe discussion mentions #1 in passing.',
      '## Ready to grant — one ticket\n### #12 — Another ticket',
      '#1: ready to grant\n#1: not yet',
      '## Ready to grant — one ticket\n#1: Not yet',
      '## Should be closed\n### #1 — Sample work',
      '## Should be closed\n### #1 — Sample work\n## Ready to grant — one ticket\n### #1 — Sample work',
      '## Needs reshaping\n### #1 — Sample work',
      '## Ready to grant — one ticket\n### #1 — Sample work\n\n| Ticket | Verdict |\n|---|---|\n| #1 | Should be closed |',
      '| #1 | Ready to grant |\n| #1 | Needs reshaping |',
      '## Should be closed\n\n| #1 | Ready to grant |',
      '## Should be closed\n#1: ready to grant',
      '## Ready to grant — one ticket\n### #1 — Sample work\n| **#1** | Not ready to grant |',
      '## Ready to grant — one ticket\n### #1 — Not ready to grant',
      '| #1 | Not ready to grant |',
      '| #1 | Not currently ready to grant |',
      '| #1 | Never ready for auto |',
      '| #1 | Unready to grant |',
      '#1: Cannot be ready to grant',
      '| #1 | No — ready to grant |',
      '| #1 | Isn’t ready to grant |',
      '| #1 | Won\'t be ready to grant |',
      '| #1 | Can’t be ready to grant |',
      '## Ready to grant — one ticket\n### #1 — Isn\'t ready to grant',
      '## Ready to grant — one ticket\n### #1 — Doesn’t qualify as ready to grant',
      '## Ready to grant — one ticket\n### #1 — Must remain manual',
      '## Ready to grant — one ticket\n### #1 — Ineligible for auto',
      '## Ready to grant — one ticket\n### #1 — Not eligible for auto',
      '## Ready to grant — one ticket\n### #1 — No longer eligible for auto',
      '## Ready to grant — one ticket\n#1: Not grantable',
      '## Ready to grant — one ticket\n### #1 — Blocked',
      '## Ready to grant — one ticket\n### #1 — On hold — not ready to grant',
      '## Ready to grant — one ticket\n#1: On hold — not ready to grant',
      '## Ready to grant — one ticket\n### #1 — Sample work\n#1 should not be granted yet.',
      '| #1 | We are ready to grant |',
      '| #1 | Ready to grant | blocked by #2 |',
      '| #1 | Ready to grant | Blocked',
      '| #1 | Ready to grant | Do not grant yet |',
      '| #1 | Ready to grant | Do not grant yet',
      '| #1 | Ready to grant | Should not grant |',
      '| #1 | Ready to grant — blocked by #2 |',
      '#1: ready to grant, but blocked by #2',
      '## Ready to grant — blocked by #2\n### #1 — Sample work',
      '| #1 | Ready to grant — shouldn’t be granted |',
      '| #1 | Ready to grant — must not be granted |',
      '#1: ready to grant — no longer true',
      '## Ready to grant — no longer true\n### #1 — Sample work',
    ]) assert.equal(assessmentGrantsTicket(text, 1), false, text);
  });

  it('accepts explicit affirmative ticket headings and table verdicts', () => {
    for (const text of [
      '## Ready to grant — one ticket\n\n### #1 — Sample work\n\nThe conditions hold.',
      '#1 is ready to grant; shaped and awaiting a separate operator decision.',
      '| Ticket | Verdict |\n|---|---|\n| #1 | **Ready to grant** — apply `auto` |',
      '| Ticket | Verdict |\n|---|---|\n| **#1** | Ready to grant |',
      '| #1 | Ready to grant',
      '| #1 | Ready to grant — unblocked |',
      '## Ready to grant — one ticket\n\n### #1 — Sample work\n\n| Ticket | Verdict |\n|---|---|\n| #1 | Ready to grant |',
    ]) assert.equal(assessmentGrantsTicket(text, 1), true, text);
    assert.equal(assessmentGrantsTicket(
      '## Ready to grant — one ticket\n### #689 — Highlights export drops the article title\nAll five conditions hold.',
      689,
    ), true, 'a ticket title describing the defect is not a negative verdict');
  });

  it('refuses negative and conflicting assessments through Inspect and Act', async () => {
    for (const text of [
      '## Should be closed\n### #1 — Sample work',
      '## Should be closed\n### #1 — Sample work\n## Ready to grant — one ticket\n### #1 — Sample work',
      '## Ready to grant — one ticket\n### #1 — Blocked',
      '| #1 | Ready to grant | Do not grant yet |',
      '| #1 | Ready to grant — blocked by #2 |',
      '#1: ready to grant, but blocked by #2',
      '| #1 | Ready to grant — shouldn’t be granted |',
      '#1: ready to grant — no longer true',
    ]) {
      const w = await world();
      await assessed(w, text);
      const inspect = await w.c.inspect('#1');
      assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, false);
      await assert.rejects(w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /current assessment/);
      assert.deepEqual(w.writes(), []);
    }
  });

  it('grants a current heading and table assessment through Inspect and Act', async () => {
    const w = await world();
    await assessed(w, '## Ready to grant — one ticket\n### #1 — Sample work\n| #1 | Ready to grant |');
    const inspect = await w.c.inspect('#1');
    assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, true);
    const result = await w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! });
    assert.equal(result.did, 'labeled #1 auto');
    assert.deepEqual(w.writes().map((entry) => [entry.kind, entry.target, entry.detail]), [['add-labels', 1, 'auto']]);
  });

  it('offers current per-ticket evidence for an operator grant and rechecks it before writing', async () => {
    const w = await world();
    await assessed(w, '#1: ready to grant');
    const inspect = await w.c.inspect('#1');
    assert.equal(inspect.evidence.find((e) => e.kind === 'assessment')?.current, true);
    const result = await w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! });
    assert.equal(result.did, 'labeled #1 auto');
    assert.deepEqual(w.writes().map((entry) => [entry.kind, entry.target, entry.detail]), [['add-labels', 1, 'auto']]);
  });

  it('refuses when a different candidate changes the queue after Inspect', async () => {
    const w = await world();
    await assessed(w, '#1: ready for auto');
    const inspect = await w.c.inspect('#1');
    const data = JSON.parse(readFileSync(w.storePath, 'utf8')) as StoreFile;
    data.issues.push(issue(4, { labels: ['shaped', 'effort:e'] }));
    writeFileSync(w.storePath, JSON.stringify(data));
    await assert.rejects(w.c.act(OPERATOR, { ref: '#1', action: 'apply-auto', expected: inspect.actionToken! }), /current assessment/);
    assert.deepEqual(w.writes(), []);
  });

  it('merges only through the merge stage, and a refused merge records no verdict', async () => {
    const { c, merges } = await world();
    const expected = (await c.inspect('PR #102')).actionToken!;
    await assert.rejects(c.act(OPERATOR, { ref: 'PR #102', action: 'merge', expected, verdict: { cardId: 'card_x', verdict: 'accepted', reason: 'x' } }), /is not about PR #102/);
    await assert.rejects(c.act(OPERATOR, { ref: 'PR #102', action: 'merge', expected }), /the merge stage passes over it/);
    assert.deepEqual(merges, ['PR #102']);
    const success = (await world(() => Promise.resolve({ produced: true, summary: 'merged PR #102' }))).c;
    const ok = await success.act(OPERATOR, { ref: 'PR #102', action: 'merge', expected: (await success.inspect('PR #102')).actionToken! });
    assert.equal(ok.did, 'merged PR #102');
  });
});
