import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createGrant, listGrants } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { listRecords, stateRoot } from './store.js';
import { OPERATOR, sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
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
