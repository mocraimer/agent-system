import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { saveRun } from '../core/run.js';
import type { RunRecord } from '../core/run.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { saveScorecard } from '../eval/scorecard.js';
import { coordinatorFacts } from './service.js';
import { card } from './testkit.js';

let box: Sandbox;
beforeEach(() => { box = sandbox(); });
afterEach(() => { box.cleanup(); });

it('scopes in-flight runs by recorded repository or a legacy linked scorecard, not a shared task-id prefix', () => {
  const attempt = (id: string, repo?: string): RunRecord => ({
    id, taskId: 'loop-shape-1', attempt: 1, authority: { type: 'grant', id: 'grant_fixture', version: 1 },
    limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 }, runtime: 'claude-local', profile: 'default', actions: ['review'],
    settings: { requested: { model: 'm', effort: 'e' }, resolved: { model: 'm', effort: 'e' }, observed: { model: 'unknown', effort: 'unknown' } },
    startedAt: '2026-09-18T00:00:00Z', status: 'running', ...(repo ? { repo } : {}),
  });
  saveRun(attempt('run_target', 'example-org/larkspur'));
  saveRun(attempt('run_elsewhere', 'other/repo'));
  saveRun(attempt('run_legacy'));
  saveRun(attempt('run_unlinked'));
  saveScorecard(card('card_shape', { stage: 'shape', item: '#1', workType: 'untyped' }, { runIds: ['run_legacy'] }));
  assert.deepEqual(coordinatorFacts('example-org/larkspur').runsInFlight.map((r) => r.runId).sort(), ['run_legacy', 'run_target']);
  assert.deepEqual(coordinatorFacts('other/repo').runsInFlight.map((r) => r.runId), ['run_elsewhere']);
});
