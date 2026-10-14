import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { FIXTURE_FLOOR } from '../loop/testkit.js';
import { createCoordinatorCommands } from '../commands.js';
import { OPERATOR, sandbox } from '../core/testkit.js';
import { saveRun } from '../core/run.js';
import type { RunRecord } from '../core/run.js';
import type { Sandbox } from '../core/testkit.js';
import { GitRepo } from '../loop/git.js';
import { promptDigest } from '../loop/prompts.js';
import { fixtureStoreConfig, SHA } from '../loop/testkit.js';
import { createConsoleCommands } from './commands.js';
import { FileStore } from './file-store.js';
import { consoleTarget } from './service.js';
import { fixtureTargetRepo, issue, pull, review, RULES, snapshot, writeStoreFile } from './testkit.js';

let box: Sandbox;
let dir: string;
beforeEach(() => { box = sandbox(); writeFloor(FIXTURE_FLOOR); dir = mkdtempSync(join(tmpdir(), 'console-freeze-')); });
afterEach(() => { box.cleanup(); rmSync(dir, { recursive: true, force: true }); });

describe('Freeze as case from Inspect', () => {
  it('opens a merged pull request by its ref and pins its head, base, ticket body hash, marker, prompt and tier', async () => {
    const { path } = fixtureTargetRepo(dir, fixtureStoreConfig());
    const head = SHA('head-659');
    const storePath = join(dir, 'store.json');
    writeStoreFile(storePath, snapshot({
      referencedIssues: [issue(636, { state: 'CLOSED', body: 'the ticket body' })],
      referencedPulls: [pull(659, { headRefName: 'ticket/636', headRefOid: head, baseRefOid: SHA('base-659'), state: 'MERGED', mergedAt: '2026-09-17T18:23:13Z', mergedBy: 'octocat', comments: [review(head, 0)] })],
    }));
    const store = new FileStore(storePath);
    const repo = new GitRepo(path);
    const c = createConsoleCommands({ target: await consoleTarget(repo, store), store, git: repo, coordinator: createCoordinatorCommands(), mergeStage: () => Promise.reject(new Error('unused')) });

    const outputPath = join(dir, 'partial-output.md');
    writeFileSync(outputPath, 'unfinished review');
    const attempt = {
      id: 'run_recorded659', taskId: 'loop-review-pr659', attempt: 1, authority: { type: 'grant', id: 'grant_fixture', version: 1 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 }, runtime: 'claude-local', profile: 'default', actions: ['review'],
      settings: { requested: { model: 'model-fixture', effort: 'high' }, resolved: { model: 'model-fixture', effort: 'high' }, observed: { model: 'unknown', effort: 'unknown' } },
      repo: 'example-org/larkspur', workClass: 'loop-review', runtimeDispatched: true,
      build: { digest: 'a'.repeat(64), revision: null, dirty: true, builtAt: '2026-09-17T00:00:00Z' },
      startedAt: '2026-09-17T10:00:00Z', endedAt: '2026-09-17T10:01:00Z', status: 'setup-blocked', outputPath,
      delivery: { status: 'unverified', reason: 'interrupted', evidence: [outputPath] },
      loop: { stage: 'review', item: 'PR #659', workType: 'untyped' },
    } as RunRecord;
    saveRun(attempt);
    const inspected = await c.inspect('PR #659');
    assert.equal(inspected.attempts[0]?.id, attempt.id);
    assert.equal(inspected.run?.delivery?.status, 'unverified');
    assert.equal(inspected.run?.build?.digest, 'a'.repeat(64));
    assert.equal(inspected.item.column, 'not in play');
    assert.match(inspected.item.because, /merged 2026-09-17T18:23:13Z by octocat/);

    const frozen = await c.freezeCase(OPERATOR, { ref: 'PR #659', kind: 'reviewer-detects-bad-candidate', expected: 'defect-reported', words: 'the review flags the unbounded retry in sync.ts', defectPattern: 'sync.ts', runId: attempt.id });
    assert.equal(frozen.version, 'incidents-1');
    assert.deepEqual(
      { head: frozen.pins['head'], base: frozen.pins['base'], issue: frozen.pins['issue'], issueBodyHash: frozen.pins['issueBodyHash'], promptDigest: frozen.pins['promptDigest'] },
      { head, base: SHA('base-659'), issue: '636', issueBodyHash: RULES.issueBodyHash('the ticket body'), promptDigest: promptDigest('review') },
    );
    assert.match(frozen.pins['reviewMarker']!, /^sha=[0-9a-f]{40} findings=0 independent=yes reviewer=model·high$/);
    assert.match(frozen.pins['promptDigestSource']!, /current review template/);
    assert.match(frozen.pins['recordedAttempt']!, /run_recorded659/);
    assert.match(frozen.pins['attemptOutputDigest']!, /^[a-f0-9]{64}$/);
    await assert.rejects(c.freezeCase(OPERATOR, { ref: 'PR #659', kind: 'refusal-or-pending', expected: 'pending', words: 'x', runId: 'run_other' }), /not a recorded attempt/);
    await assert.rejects(c.freezeCase({ kind: 'agent', id: 'run_x' }, { ref: 'PR #659', kind: 'approved-repair', expected: 'completed', words: 'x' }), /cannot issue or change authority/);
  });
});
