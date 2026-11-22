import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { checkShape } from './validate.js';
import { tryLock, unlock } from 'fs-native-extensions';
import { setTimeout as delay } from 'node:timers/promises';

type ShapeKind = Parameters<typeof checkShape>[0];

/**
 * Durable state root. Everything the coordinator must survive a restart with lives
 * here — outside any disposable vendor session home, per the Initial Approach.
 */
export function stateRoot(): string {
  const configured = process.env['AGENTSYS_STATE'];
  if (configured !== undefined) return configured;
  // A test that forgets `sandbox()` otherwise writes into the operator's real
  // store, and the damage is invisible: reservations and approvals from test
  // fixtures simply appear in the live ledger.
  if (underTest()) {
    throw new Error(
      'AGENTSYS_STATE is unset inside a test run. Call sandbox() from testkit before '
      + 'touching the store, so the test cannot write to the operator\'s real state.',
    );
  }
  return join(process.cwd(), '.state');
}

/**
 * True when this process is a `node --test` runner.
 *
 * Deliberately does not look at `process.argv`. `--test` is a Node runtime flag,
 * so it reaches `execArgv` in the orchestrator and never appears in a test's own
 * argv — the child that actually runs test bodies is identified by
 * `NODE_TEST_CONTEXT`. Matching user argv instead would fire on an operator
 * running `agentsys ledger --test`, refusing a real command with a message about
 * a test run they are not in.
 */
function underTest(): boolean {
  return process.env['NODE_TEST_CONTEXT'] !== undefined
    || process.execArgv.includes('--test');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Write a JSON document so a reader never observes a partial file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Read a record and check it has the shape its readers assume.
 *
 * `readJson` is the raw form and stays available for small config files where a
 * missing field is handled by a default. Durable records that get spread or
 * iterated go through this instead, so a malformed one fails at the read with a
 * named error rather than as a TypeError somewhere downstream.
 */
export function readRecord<T>(kind: ShapeKind, path: string): T | undefined {
  const raw = readJson<unknown>(path);
  if (raw === undefined) return undefined;
  return checkShape<T>(kind, path, raw);
}

/**
 * Read a whole collection, checking each record.
 *
 * A single malformed file must not take down a listing the dispatch path depends
 * on — `listGrants` feeds authorization, and a `TypeError` there would refuse every
 * grant-authorized dispatch with no indication which file was at fault. Bad records
 * are skipped and named on stderr instead.
 */
export function listRecords<T>(kind: ShapeKind, dir: string): T[] {
  const out: T[] = [];
  for (const { path, value } of listJsonWithPaths(dir)) {
    try {
      out.push(checkShape<T>(kind, path, value));
    } catch (err) {
      console.error(`Skipping unusable ${kind} record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

function listJsonWithPaths(dir: string): Array<{ path: string; value: unknown }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ path: string; value: unknown }> = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const path = join(dir, n);
    const value = readJson<unknown>(path);
    if (value !== undefined) out.push({ path, value });
  }
  return out;
}

export function listJson<T>(dir: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: T[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const v = readJson<T>(join(dir, n));
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Legacy timeout constant retained for callers; live locks are never time-stolen. */
export const LOCK_STALE_MS = 60_000;

/** Bound slow operations under a lock without relying on lock expiration. */
export function maxLockedOperationMs(): number {
  return Math.floor(LOCK_STALE_MS * 0.75);
}

interface LockHandle {
  fd: number;
  key: string;
}

// A synchronous waiter cannot let an async holder on this event loop resume.
// Track the inode, not the path, so aliases cannot evade the busy check.
const localLocks = new Set<string>();
const localAsyncLocks = new Set<string>();
const localSyncHandles = new Map<string, { fd: number; pid: number }>();

function openLock(name: string): LockHandle {
  const path = join(stateRoot(), 'locks', `${name}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+');
  try {
    const stat = fstatSync(fd);
    return { fd, key: `${stat.dev}:${stat.ino}` };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function lockTimeout(name: string): Error {
  return new Error(`Could not acquire lock "${name}" within ${LOCK_STALE_MS * 2 / 1000}s; another holder still owns it.`);
}

function acquireLock(name: string): LockHandle {
  const handle = openLock(name);
  const deadline = Date.now() + LOCK_STALE_MS * 2;
  try {
    if (localLocks.has(handle.key)) {
      throw new Error(`Lock "${name}" is busy in this process; a synchronous wait would block its holder.`);
    }
    while (!tryLock(handle.fd)) {
      if (localAsyncLocks.size > 0) {
        throw new Error(`Lock "${name}" is busy while this process holds an async lock; synchronous waiting could prevent its release.`);
      }
      if (Date.now() >= deadline) throw lockTimeout(name);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    localLocks.add(handle.key);
    localSyncHandles.set(handle.key, { fd: handle.fd, pid: process.pid });
    return handle;
  } catch (err) {
    closeSync(handle.fd);
    throw err;
  }
}

async function acquireLockAsync(name: string): Promise<LockHandle> {
  const handle = openLock(name);
  const deadline = Date.now() + LOCK_STALE_MS * 2;
  try {
    while (!tryLock(handle.fd)) {
      if (Date.now() >= deadline) throw lockTimeout(name);
      await delay(25);
    }
    localLocks.add(handle.key);
    localAsyncLocks.add(handle.key);
    return handle;
  } catch (err) {
    closeSync(handle.fd);
    throw err;
  }
}

function releaseLock(handle: LockHandle): void {
  try {
    unlock(handle.fd);
  } finally {
    localLocks.delete(handle.key);
    localAsyncLocks.delete(handle.key);
    localSyncHandles.delete(handle.key);
    closeSync(handle.fd);
  }
}

/**
 * Kernel-owned cross-process lock on a stable inode. Never unlink these files:
 * doing so lets a new opener lock a different inode while the old holder runs.
 * Closing the owning descriptor (including process death) releases the lock.
 * All writers must use this protocol; old existence/staleness writers must be
 * quiesced before activation. Synchronous bodies must not return promises.
 */
export function withLock<T>(name: string, fn: () => T): T {
  const handle = acquireLock(name);
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}

/** Reuse only this process's still-owned synchronous dispatch descriptor, never an async holder. */
export function withDispatchFence<T>(fn: () => T): T {
  const execute = (): T => {
    if (fn.constructor.name === 'AsyncFunction') throw new Error('Dispatch fence callback must be synchronous.');
    const result = fn();
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') throw new Error('Dispatch fence callback returned an unsupported promise.');
    return result;
  };
  const probe = openLock('dispatch');
  let owns = false;
  try {
    const owner = localSyncHandles.get(probe.key);
    if (localAsyncLocks.has(probe.key)) throw new Error('Dispatch fence has an async holder; synchronous reuse would escape its critical section.');
    if (owner?.pid === process.pid) {
      const stat = fstatSync(owner.fd);
      owns = `${stat.dev}:${stat.ino}` === probe.key && tryLock(owner.fd);
      if (!owns) throw new Error('Synchronous dispatch descriptor ownership could not be proved.');
    }
  } finally { closeSync(probe.fd); }
  return owns ? execute() : withLock('dispatch', execute);
}

/** Same ownership across awaits, with event-loop-friendly bounded acquisition. */
export async function withLockAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLockAsync(name);
  try {
    return await fn();
  } finally {
    releaseLock(handle);
  }
}

/** Stable digest used to bind a record to the exact bytes it was derived from. */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
