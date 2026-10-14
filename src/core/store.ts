import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { checkShape } from './validate.js';

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

/**
 * How long a held lock may go unrefreshed before another process may break it.
 *
 * Exported because it bounds every operation performed *under* the lock. Nothing
 * refreshes the file while a critical section runs, so an operation slower than
 * this lets a waiter break the lock and enter alongside the holder. Callers derive
 * their timeouts from `maxLockedOperationMs()` rather than picking a number.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * The longest an operation under the lock may take.
 *
 * Three quarters of the staleness window, leaving room for the rest of the
 * critical section after the slow part returns.
 */
export function maxLockedOperationMs(): number {
  return Math.floor(LOCK_STALE_MS * 0.75);
}


interface LockHandle {
  path: string;
  /** Unique per acquisition, so a holder can prove the lock is still its own. */
  token: string;
}

/**
 * Acquire a lock, then verify we actually hold it.
 *
 * `O_EXCL` alone is atomic, but breaking a *stale* lock is not: two processes can
 * both see the same stale file, both unlink it, and both then create one — the
 * second unlink destroying the first's freshly created lock, leaving two holders.
 * So each acquisition writes a unique token and reads it back. Exactly one token
 * survives, and the loser retries rather than running concurrently.
 */
function acquireLock(name: string): LockHandle {
  const path = join(stateRoot(), 'locks', `${name}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS * 2;

  for (;;) {
    const token = `${process.pid}:${randomUUID()}`;
    let created = false;
    try {
      closeSync(openSync(path, 'wx'));
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (created) {
      writeFileSync(path, token, 'utf8');
      if (readLockToken(path) === token) return { path, token };
      // A racing stale-breaker replaced our file; the lock is not ours.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }

    let age = Infinity;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue; // released between our open and our stat; retry immediately
    }
    if (age > LOCK_STALE_MS) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Could not acquire lock "${name}": held for ${Math.round(age / 1000)}s by another process.`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function readLockToken(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Release a lock we still own.
 *
 * After a lost stale-break race the file belongs to someone else, and removing it
 * would let a third process in on top of them.
 */
function releaseLock(handle: LockHandle): void {
  if (readLockToken(handle.path) === handle.token) {
    rmSync(handle.path, { force: true });
  }
}

/**
 * Cross-process exclusive lock.
 *
 * Reservations against a shared subscription are read-modify-write across
 * independent CLI invocations, so a mutex inside one process would not stop two
 * dispatchers spending the same headroom. `O_EXCL` on a shared filesystem is the
 * primitive available without adding a dependency; a stale holder is broken only
 * after it stops being refreshed, so a crashed dispatcher cannot deadlock the rest.
 */
export function withLock<T>(name: string, fn: () => T): T {
  const handle = acquireLock(name);
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}

/**
 * The same lock, held across an awaited body.
 *
 * Separate from `withLock` because a sync wrapper cannot hold a lock across an
 * `await`: it would release as soon as the body returned its promise, leaving the
 * critical section unprotected exactly where concurrency matters most.
 */
export async function withLockAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const handle = acquireLock(name);
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
