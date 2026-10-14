import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { FIXTURE_FLOOR } from './testkit.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import type { SnapshotSource, StoreSnapshot } from '../console/snapshot.js';
import { issue, snapshot } from '../console/testkit.js';
import { STATUS_MARKER, renderReviewMarker } from './markers.js';
import type { Messenger } from './notify.js';
import { renderMessage, telegramFromEnv, transition } from './notify.js';
import { runPass } from './pass.js';
import { FakeCommands, FakeRepo, FakeStore, fixtureRules, SHA } from './testkit.js';

let box: Sandbox;
beforeEach(() => { box = sandbox(); writeFloor(FIXTURE_FLOOR); });
afterEach(() => box.cleanup());

class Sequence implements SnapshotSource {
  current: StoreSnapshot = snapshot();
  read(): Promise<StoreSnapshot> { return Promise.resolve(this.current); }
}

class Outbox implements Messenger {
  sent: string[] = [];
  send(text: string): Promise<void> { this.sent.push(text); return Promise.resolve(); }
}

function world() {
  const store = new FakeStore();
  store.addIssue({ number: 1, title: 'Loop home', labels: ['effort', 'effort:home'] });
  const lines: string[] = [];
  const snapshots = new Sequence();
  const outbox = new Outbox();
  const pass = (messenger: Messenger | { skipped: string } = outbox) => runPass({
    repo: new FakeRepo(), store, commands: new FakeCommands(), rules: fixtureRules(), log: (l) => lines.push(l),
    notify: { snapshots, mention: 'octocat', messenger },
  }, { dryRun: false, stages: ['review'] });
  const status = (): string => [...(store.commentsBy.get(1) ?? [])].reverse().find((c) => c.body.includes(STATUS_MARKER))!.body;
  return { store, lines, snapshots, outbox, pass, status };
}

const waiting = snapshot({ issues: [issue(40, { title: 'Escalated ticket', labels: ['escalated'] })] });

describe('one mention and one message per transition, none otherwise', () => {
  it('empty, empty, an item appears, it persists, it clears, a new fault: notifies on the third and the sixth only', async () => {
    const w = world();
    const mentions: boolean[] = [];
    const sends: number[] = [];
    const step = async (snap: StoreSnapshot, before?: () => void) => {
      w.snapshots.current = snap;
      before?.();
      await w.pass();
      mentions.push(w.status().includes('@octocat'));
      sends.push(w.outbox.sent.length);
    };
    await step(snapshot());
    await step(snapshot());
    await step(waiting);
    await step(waiting);
    await step(snapshot());
    // A review marker naming a commit the pull request never had is a breach: a fault the loop has not seen.
    await step(snapshot(), () => {
      w.store.addIssue({ number: 77, labels: ['type:bug'] });
      w.store.addPull({ number: 77, headRefOid: SHA('real-head') });
      w.store.addComment(77, `review\n\n${renderReviewMarker({ sha: SHA('never-on-the-pr'), findings: 0, independent: true, reviewer: 'm·e' })}`);
    });
    assert.deepEqual(mentions, [false, false, true, false, false, true]);
    assert.deepEqual(sends, [0, 0, 1, 1, 1, 2]);
    assert.match(w.outbox.sent[0]!, /^example-org\/larkspur: 1 item\(s\) now need you: #40\nStatus: https:\/\/github\.com\/example-org\/larkspur\/issues\/1$/);
    assert.match(w.outbox.sent[1]!, /new fault: #\d+ \[loop\] review breach: PR #77/);
  });

  it('a fault announced once is not announced again when its issue shows up as waiting', async () => {
    const w = world();
    w.store.addIssue({ number: 77, labels: ['type:bug'] });
    w.store.addPull({ number: 77, headRefOid: SHA('real-head') });
    w.store.addComment(77, `review\n\n${renderReviewMarker({ sha: SHA('never-on-the-pr'), findings: 0, independent: true, reviewer: 'm·e' })}`);
    await w.pass();
    assert.equal(w.outbox.sent.length, 1);
    const faultIssue = w.store.issues.find((i) => i.title.startsWith('[loop]'))!;
    // The pull request goes away, so the next pass reports nothing new of its own.
    w.store.pulls = [];
    w.snapshots.current = snapshot({ issues: [issue(faultIssue.number, { title: faultIssue.title, body: faultIssue.body })] });
    await w.pass();
    assert.equal(w.outbox.sent.length, 1, 'the next pass sees the fault issue waiting and says nothing new');
  });

  it('with no token the pass logs that it skipped the message, and the mention still fires', async () => {
    const w = world();
    w.snapshots.current = waiting;
    await w.pass(telegramFromEnv({}));
    assert.ok(w.lines.includes('notification skipped: no token'));
    assert.ok(w.status().includes('@octocat — 1 item(s) now need you: #40'));
  });

  it('a message that fails to send is logged and the pass still completes', async () => {
    const w = world();
    w.snapshots.current = waiting;
    const report = await w.pass({ send: () => Promise.reject(new Error('Telegram answered 502')) });
    assert.ok(w.lines.some((l) => l === 'notify: the message was not sent: Telegram answered 502'));
    assert.equal(report.classification, 'idle-empty');
  });

  it('a store read that fails sends nothing and keeps what the last pass knew', async () => {
    const w = world();
    w.snapshots.current = waiting;
    await w.pass();
    w.snapshots.read = () => Promise.reject(new Error('gh api graphql exited 1'));
    await w.pass();
    assert.equal(w.outbox.sent.length, 1);
    assert.ok(w.lines.includes('notify: could not read what needs you: gh api graphql exited 1'));
  });

  it('a dry run notifies nobody', async () => {
    const w = world();
    w.snapshots.current = waiting;
    await runPass({ repo: new FakeRepo(), store: w.store, commands: new FakeCommands(), rules: fixtureRules(), notify: { snapshots: w.snapshots, mention: 'octocat', messenger: w.outbox } }, { dryRun: true, stages: ['review'] });
    assert.equal(w.outbox.sent.length, 0);
  });
});

describe('the transition rule and the Telegram call', () => {
  it('notifies on empty to non-empty and on a new fault, and on nothing else', () => {
    assert.equal(transition(undefined, [], []).reason, undefined);
    assert.equal(transition([], ['#1'], []).reason, '1 item(s) now need you: #1');
    assert.equal(transition(['#1'], ['#1', '#2'], []).reason, undefined, 'more of what was already waiting is not a transition');
    assert.equal(transition(['#1'], [], []).reason, undefined);
    assert.deepEqual(transition(['#1'], [], [{ issue: 9, title: '[loop] x' }]), { reason: 'new fault: #9 [loop] x', remember: ['#9'] });
  });

  it('posts sendMessage with the chat id from the environment, and keeps the token out of an error', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    // Built rather than written out, so no credential-shaped literal sits in the source.
    const token = `${'1'.repeat(9)}:${'A'.repeat(35)}`;
    const ok = telegramFromEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '4242' }, (url, init) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    });
    assert.ok(!('skipped' in ok));
    await ok.send(renderMessage('o/r', '1 item(s) now need you: #5', 12));
    assert.equal(calls[0]!.url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.deepEqual(JSON.parse(calls[0]!.body), { chat_id: '4242', text: 'o/r: 1 item(s) now need you: #5\nStatus: https://github.com/o/r/issues/12', disable_web_page_preview: true });

    const failing = telegramFromEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '4242' }, () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(`Unauthorized for ${token}`) }));
    assert.ok(!('skipped' in failing));
    await assert.rejects(failing.send('x'), (err: Error) => err.message === 'Telegram answered 401: Unauthorized for <token>');
    assert.deepEqual(telegramFromEnv({ TELEGRAM_BOT_TOKEN: token }), { skipped: 'no chat id' });
  });
});
