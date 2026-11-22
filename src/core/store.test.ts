import assert from 'node:assert/strict';
import fs, { closeSync, mkdirSync, openSync, readlinkSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tryLock, unlock } from 'fs-native-extensions';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createGrant, listGrants } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { listRecords, LOCK_STALE_MS, stateRoot, withDispatchFence, withLock, withLockAsync, withLocks } from './store.js';
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

function lockDescriptors(): string[] {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try { const path = readlinkSync(`/proc/self/fd/${fd}`); return path.startsWith(join(box!.root, 'locks') + '/') ? [path] : []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }).sort();
}

describe('ordered whole-set store locks', () => {
  it('deduplicates and acquires in codepoint order, retaining every descriptor through the body', (t) => {
    box = sandbox(); const opened: string[] = [], original = fs.openSync;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return original(...args); });
    syncBuiltinESMExports();
    try {
      assert.equal(withLocks(['z', 'a', 'z', 'A'], () => {
        assert.deepEqual(opened.map(path => path.split('/').at(-1)), ['A.lock', 'a.lock', 'z.lock']);
        assert.equal(lockDescriptors().length, 3);
        for (const name of ['A', 'a', 'z']) {
          const fd = openSync(join(box!.root, 'locks', `${name}.lock`), 'a+');
          try { assert.equal(tryLock(fd), false); } finally { closeSync(fd); }
          assert.throws(() => withLock(name, () => assert.fail('not exclusive')), /busy/);
        }
        return 'whole set';
      }), 'whole set');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(lockDescriptors(), []);
    withLocks(['z', 'a', 'A'], () => assert.equal(lockDescriptors().length, 3));
    assert.equal(withLocks([], () => 42), 42);
  });
  it('does not turn lifetime lock count into recursive call depth', () => {
    box = sandbox(); const names = Array.from({ length: 4097 }, (_, index) => `history-${index}`);
    withLocks(names, () => assert.equal(lockDescriptors().length, names.length));
    assert.deepEqual(lockDescriptors(), []);
  });
  it('unwinds partial acquisition on same-process contention and filesystem failure, without entering the body', () => {
    box = sandbox();
    withLock('b', () => {
      assert.throws(() => withLocks(['c', 'b', 'a'], () => assert.fail('partial body')), /busy/);
      assert.deepEqual(lockDescriptors(), [join(box!.root, 'locks', 'b.lock')]);
      withLock('a', () => {});
    });
    mkdirSync(join(box.root, 'locks', 'b-directory.lock'));
    assert.throws(() => withLocks(['a', 'b-directory'], () => assert.fail('partial body')), /EISDIR/);
    assert.deepEqual(lockDescriptors(), []);
    withLock('a', () => {});
  });
  it('reports OS resource exhaustion without running a partial body or leaking acquired descriptors', (t) => {
    box = sandbox(); const original = fs.openSync;
    const exhausted = Object.assign(new Error('fixture descriptor exhaustion'), { code: 'EMFILE' });
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith('/b.lock')) throw exhausted;
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => withLocks(['a', 'b', 'c'], () => assert.fail('partial resource body')), error => error === exhausted);
      assert.deepEqual(lockDescriptors(), []);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    withLocks(['a', 'b', 'c'], () => {}); assert.deepEqual(lockDescriptors(), []);
  });
  it('bounds real kernel contention and closes partial handles without releasing the other holder', (t) => {
    box = sandbox(); mkdirSync(join(box.root, 'locks'));
    const path = join(box.root, 'locks', 'b.lock'), fd = openSync(path, 'a+');
    assert.equal(tryLock(fd), true); const inode = statSync(path).ino;
    let time = 0; t.mock.method(Date, 'now', () => time += LOCK_STALE_MS * 2 + 1);
    try {
      assert.throws(() => withLocks(['a', 'b', 'c'], () => assert.fail('contended body')), /within 120s/);
      assert.deepEqual(lockDescriptors(), [path]);
      const contender = openSync(path, 'a+');
      try { assert.equal(tryLock(contender), false); } finally { closeSync(contender); }
      assert.equal(statSync(path).ino, inode);
    } finally { closeSync(fd); t.mock.restoreAll(); }
    withLocks(['a', 'b', 'c'], () => {}); assert.deepEqual(lockDescriptors(), []);
  });
  it('releases the full set after a body failure, and after each release failure', (t) => {
    box = sandbox(); const body = new Error('body failure');
    assert.throws(() => withLocks(['a', 'b', 'c'], () => { throw body; }), error => error === body);
    assert.deepEqual(lockDescriptors(), []);
    const original = fs.closeSync, closed: string[] = [];
    t.mock.method(fs, 'closeSync', (fd: number) => {
      const path = readlinkSync(`/proc/self/fd/${fd}`); original(fd); closed.push(path);
      throw new Error(`release failure ${path.split('/').at(-1)}`);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => withLocks(['a', 'b', 'c'], () => { throw body; }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map((item: Error) => item.message), ['body failure', 'release failure c.lock', 'release failure b.lock', 'release failure a.lock']);
        return true;
      });
      assert.equal(closed.length, 3); assert.deepEqual(lockDescriptors(), []);
      assert.throws(() => withLocks(['a'], () => 'successful body'), /release failure a.lock/);
      assert.deepEqual(lockDescriptors(), []);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    withLocks(['a', 'b', 'c'], () => {}); assert.deepEqual(lockDescriptors(), []);
    assert.throws(() => withLocks(['a'], async () => assert.fail('async body')), /synchronous/);
    assert.throws(() => withLocks(['a'], () => Promise.resolve()), /promise/);
    assert.deepEqual(lockDescriptors(), []);
  });
  it('process death releases every retained lock on the same stable inodes', { timeout: 10000 }, async () => {
    box = sandbox(); const names = ['a', 'b', 'c'];
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withLocks } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
      withLocks(${JSON.stringify(names)}, () => { process.send('whole-set-owned'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
    `], { env: { ...process.env, AGENTSYS_STATE: box.root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      const [message] = await once(child, 'message'); assert.equal(message, 'whole-set-owned');
      const inodes = names.map(name => statSync(join(box!.root, 'locks', `${name}.lock`)).ino);
      for (const name of names) {
        const fd = openSync(join(box.root, 'locks', `${name}.lock`), 'a+');
        try { assert.equal(tryLock(fd), false); } finally { closeSync(fd); }
      }
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      withLocks(names, () => assert.deepEqual(names.map(name => statSync(join(box!.root, 'locks', `${name}.lock`)).ino), inodes));
      assert.deepEqual(lockDescriptors(), []);
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
