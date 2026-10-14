import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AuthorityError } from './authority.js';
import { AGENT_ACTOR, OPERATOR, sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';
import {
  activateVersion, activeVersion, denyLiveUpdate, listCandidates, recordCandidate,
  rollback, UpdateError, versionForRun, versionHistory,
} from './version.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const V1 = { coordinator: 'sha-aaa', adapters: { 'pi-local': 'a1' }, prompts: 'prompts-1' };
const V2 = { coordinator: 'sha-bbb', adapters: { 'pi-local': 'a2' }, prompts: 'prompts-2' };

describe('exercising a candidate is not activating it', () => {
  it('records an unmerged build without touching the active version', () => {
    box = sandbox();
    const c = recordCandidate({ ...V2, origin: 'branch ops/agent-system-bootstrap', purpose: 'bootstrap build' });
    assert.equal(listCandidates().length, 1);
    assert.equal(activeVersion(), undefined, 'exercising a candidate must not make it the runner');
    assert.equal(c.origin, 'branch ops/agent-system-bootstrap');
  });

  it('refuses to let an agent promote a candidate', () => {
    box = sandbox();
    const c = recordCandidate({ ...V2, origin: 'branch x', purpose: 'self-improvement' });
    const outcome = denyLiveUpdate(AGENT_ACTOR, c);
    assert.equal(outcome.kind, 'refused');
    assert.match(outcome.summary, /cannot replace the running system/);
  });

  it('refuses even the operator without a confirmed merge', () => {
    box = sandbox();
    assert.throws(
      () => activateVersion(OPERATOR, { ...V2, mergedPr: 'https://example.test/pr/1', mergeConfirmed: false }),
      UpdateError,
    );
    assert.equal(activeVersion(), undefined);
  });

  it('refuses an activation that names no pull request', () => {
    box = sandbox();
    assert.throws(
      () => activateVersion(OPERATOR, { ...V2, mergedPr: '', mergeConfirmed: true }),
      /must name the merged pull request/,
    );
  });

  it('refuses an agent outright', () => {
    box = sandbox();
    assert.throws(
      () => activateVersion(AGENT_ACTOR, { ...V2, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true }),
      AuthorityError,
    );
  });
});

describe('activation and rollback', () => {
  it('activates with an operator and a confirmed merge', () => {
    box = sandbox();
    const r = activateVersion(OPERATOR, { ...V1, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true });
    assert.equal(r.coordinator, 'sha-aaa');
    assert.equal(r.activatedBy, OPERATOR.id);
    assert.equal(activeVersion()?.coordinator, 'sha-aaa');
  });

  it('keeps the prior version available to roll back to', () => {
    box = sandbox();
    activateVersion(OPERATOR, { ...V1, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true });
    activateVersion(OPERATOR, { ...V2, mergedPr: 'https://example.test/pr/2', mergeConfirmed: true });
    assert.equal(activeVersion()?.coordinator, 'sha-bbb');
    assert.equal(activeVersion()?.previous?.coordinator, 'sha-aaa');

    const back = rollback(OPERATOR);
    assert.equal(back.coordinator, 'sha-aaa');
    assert.equal(activeVersion()?.coordinator, 'sha-aaa');
    assert.ok(versionHistory().length >= 1, 'superseded versions are kept');
  });

  it('refuses a rollback with nowhere to go', () => {
    box = sandbox();
    activateVersion(OPERATOR, { ...V1, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true });
    assert.throws(() => rollback(OPERATOR), /no previous version/);
  });

  it('refuses a rollback by an agent', () => {
    box = sandbox();
    activateVersion(OPERATOR, { ...V1, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true });
    activateVersion(OPERATOR, { ...V2, mergedPr: 'https://example.test/pr/2', mergeConfirmed: true });
    assert.throws(() => rollback(AGENT_ACTOR), AuthorityError);
  });
});

describe('a run keeps the version it started with', () => {
  it('does not pick up new control code mid-run', () => {
    box = sandbox();
    activateVersion(OPERATOR, { ...V1, mergedPr: 'https://example.test/pr/1', mergeConfirmed: true });
    const startedWith = { ...V1 };
    activateVersion(OPERATOR, { ...V2, mergedPr: 'https://example.test/pr/2', mergeConfirmed: true });
    assert.deepEqual(versionForRun(startedWith), V1, 'the active version moved on; the run did not');
    assert.equal(activeVersion()?.coordinator, 'sha-bbb');
  });
});
