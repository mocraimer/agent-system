import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FileStore } from './file-store.js';
import { issue, pull, snapshot, writeStoreFile } from './testkit.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'console-file-store-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('who applied a label, from the store file', () => {
  const event = (type: 'labeled' | 'unlabeled', label: string, actor: string) => ({ type, label, actor, at: '2026-10-01T00:00:00Z' });

  it('is the actor of the newest labeled event for that label on an issue', async () => {
    const path = join(dir, 'store.json');
    writeStoreFile(path, snapshot({
      issues: [issue(1, { events: [event('labeled', 'apply-comment', 'first'), event('labeled', 'auto', 'other'), event('labeled', 'apply-comment', 'second')] })],
    }));
    const store = new FileStore(path);
    assert.equal(await store.labelActor(1, 'apply-comment'), 'second');
    assert.equal(await store.labelActor(1, 'review-again'), undefined);
    assert.equal(await store.labelActor(99, 'apply-comment'), undefined, 'an item the file does not hold');
  });

  it('is unknown, not an error, where the file holds no event list for an issue', async () => {
    const path = join(dir, 'store.json');
    writeStoreFile(path, snapshot({ issues: [issue(1, { events: null as never })] }));
    assert.equal(await new FileStore(path).labelActor(1, 'apply-comment'), undefined);
  });

  it('is unknown for a pull request, which carries no event history in the file, so the loop would not act on it', async () => {
    const path = join(dir, 'store.json');
    writeStoreFile(path, snapshot({ pulls: [pull(750)] }));
    assert.equal(await new FileStore(path).labelActor(750, 'apply-comment'), undefined);
  });
});
