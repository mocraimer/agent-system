import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tryLock, unlock } from 'fs-native-extensions';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createGrant, listGrants } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { listRecords, LOCK_STALE_MS, stateRoot, withDispatchFence, withLock, withLockAsync } from './store.js';
import { OPERATOR, sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

describe('descriptor-owned store locks', () => {
  it('keeps a stable inode and never steals an old live lock', async () => {
    box = sandbox();
    const path = join(box.root, 'locks', 'probe.lock');
    await withLockAsync('probe', async () => {
      const inode = statSync(path).ino;
      const old = new Date(Date.now() - LOCK_STALE_MS * 3);
      utimesSync(path, old, old);
      const contender = openSync(path, 'a+');
      const unrelated = openSync(path, 'a+');
      closeSync(unrelated);
      assert.equal(tryLock(contender), false, 'unrelated close does not release the owning FD');
      unlock(contender);
      assert.equal(tryLock(contender), false, 'non-owner unlock does not release the owning FD');
      closeSync(contender);
      assert.throws(() => withLock('probe', () => assert.fail('not exclusive')), /busy in this process/);
      assert.equal(statSync(path).ino, inode);
    });
    const inode = statSync(path).ino;
    withLock('probe', () => assert.equal(statSync(path).ino, inode));
    assert.equal(statSync(path).ino, inode, 'release never deletes the namespace file');
  });

  it('reuses only the proven same-process synchronous dispatch descriptor for nested admission', () => {
    box = sandbox();
    withLock('dispatch', () => {
      const path = join(box!.root, 'locks', 'dispatch.lock'), inode = statSync(path).ino;
      withDispatchFence(() => withDispatchFence(() => {
        const contender = openSync(path, 'a+');
        try { assert.equal(tryLock(contender), false); } finally { closeSync(contender); }
      }));
      assert.equal(statSync(path).ino, inode);
      assert.throws(() => withLock('dispatch', () => {}), /busy/, 'generic lock API is not made reentrant');
    });
    withDispatchFence(() => {});
  });

  it('rejects asynchronous dispatch-holder reuse and promise-returning fence callbacks', async () => {
    box = sandbox();
    await withLockAsync('dispatch', async () => {
      assert.throws(() => withDispatchFence(() => assert.fail('must not escape async ownership')), /async holder/);
    });
    assert.throws(() => withDispatchFence(async () => assert.fail('must not start')), /synchronous/);
    assert.throws(() => withDispatchFence(() => Promise.resolve('unsupported')), /promise/);
    withDispatchFence(() => {});
  });

  it('bounds asynchronous contention without releasing another descriptor or replacing its inode', async (t) => {
    box = sandbox();
    const path = join(box.root, 'locks', 'timeout.lock');
    mkdirSync(join(box.root, 'locks'), { recursive: true });
    const holder = openSync(path, 'a+');
    assert.equal(tryLock(holder), true);
    const inode = statSync(path).ino;
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
      const waiting = withLockAsync('timeout', async () => assert.fail('lock was stolen'));
      t.mock.timers.tick(LOCK_STALE_MS * 2 + 1);
      await assert.rejects(waiting, /within 120s/);
      const contender = openSync(path, 'a+');
      try { assert.equal(tryLock(contender), false); } finally { closeSync(contender); }
      assert.equal(statSync(path).ino, inode);
    } finally { closeSync(holder); }
    withLock('timeout', () => assert.equal(statSync(path).ino, inode));
  });

  it('releases ownership when either critical-section API throws', async () => {
    box = sandbox();
    assert.throws(() => withLock('throw', () => { throw new Error('sync failure'); }), /sync failure/);
    await assert.rejects(withLockAsync('throw', async () => { throw new Error('async failure'); }), /async failure/);
    withLock('throw', () => {});
  });

  it('waits asynchronously without preventing the same-process holder from settling', async () => {
    box = sandbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const order: string[] = [];
    const holder = withLockAsync('async', async () => { order.push('holder'); entered(); await gate; order.push('released'); });
    await started;
    const waiter = withLockAsync('async', async () => { order.push('waiter'); });
    setTimeout(release, 10);
    await Promise.all([holder, waiter]);
    assert.deepEqual(order, ['holder', 'released', 'waiter']);
  });

  it('releases a cross-process lock after abrupt death, without deleting its inode', { timeout: 10_000 }, async () => {
    box = sandbox();
    const module = new URL('./store.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withLockAsync } from ${JSON.stringify(module)};
      await withLockAsync('crash', async () => {
        process.send('locked'); await new Promise(() => {});
      });
    `], { env: { ...process.env, AGENTSYS_STATE: box.root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      await once(child, 'message');
      const path = join(box.root, 'locks', 'crash.lock');
      const inode = statSync(path).ino;
      const contender = openSync(path, 'a+');
      try { assert.equal(tryLock(contender), false); } finally { closeSync(contender); }
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      withLock('crash', () => assert.equal(statSync(path).ino, inode));
    } finally { child.kill('SIGKILL'); }
  });
});

/**
 * The point of `listRecords` is that one unusable file does not take down a
 * listing the dispatch path depends on. A reviewer showed the previous suite could
 * not tell: removing the catch entirely left every test green.
 */
describe('a listing survives one unusable record', () => {
  function writeGrantFile(name: string, content: unknown): void {
    const dir = join(stateRoot(), 'grants');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(content), 'utf8');
  }

  it('skips a malformed record and returns the rest', () => {
    box = sandbox();
    const good = createGrant(OPERATOR, {
      repos: ['a/one'], workClasses: ['ci-repair'], triggerSources: ['src'],
      actions: ['author-changes'], runtimes: ['pi-local'], profiles: ['default'],
      perTask: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      aggregate: { maxDispatchesPerWindow: 5, windowHours: 24, maxConcurrentRuns: 1 },
      reason: 'valid',
    });
    // A grant that predates the `repos` field, or was half-written by a crash.
    writeGrantFile('grant_broken.json', { id: 'grant_broken', status: 'active', version: 1 });

    const grants = listGrants();
    assert.equal(grants.length, 1, 'the usable grant is still returned');
    assert.equal(grants[0]?.id, good.id);
  });

  it('lets an authorized dispatch through despite a malformed neighbour', () => {
    box = sandbox();
    createGrant(OPERATOR, {
      repos: ['a/one'], workClasses: ['ci-repair'], triggerSources: ['src'],
      actions: ['author-changes'], runtimes: ['pi-local'], profiles: ['default'],
      perTask: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      aggregate: { maxDispatchesPerWindow: 5, windowHours: 24, maxConcurrentRuns: 1 },
      reason: 'valid',
    });
    writeGrantFile('grant_broken.json', { id: 'grant_broken', status: 'active', version: 1 });

    // Without the skip this throws inside grantMatches on the dispatch hot path.
    const decision = authorizeDispatch({
      repo: 'a/one', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default',
      actions: ['author-changes'], taskId: 'task_1', triggerSource: 'src',
    });
    assert.equal(decision.allowed, true, 'one bad file must not refuse every grant-authorized dispatch');
  });

  it('returns nothing rather than throwing when every record is unusable', () => {
    box = sandbox();
    writeGrantFile('grant_a.json', { id: 'a' });
    writeGrantFile('grant_b.json', { nope: true });
    assert.deepEqual(listRecords('grant', join(stateRoot(), 'grants')), []);
  });

  it('returns an empty list for a directory that does not exist', () => {
    box = sandbox();
    assert.deepEqual(listRecords('run', join(stateRoot(), 'nothing-here')), []);
  });
});
