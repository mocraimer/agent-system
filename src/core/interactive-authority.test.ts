import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCoordinatorCommands, type DispatchTaskInput, type AuthorityConfirmationInput } from '../commands.js';
import type { RuntimeAdapter } from '../adapters/types.js';
import { OPERATOR, sandbox, type Sandbox } from './testkit.js';
let state: Sandbox;
beforeEach(() => { state = sandbox(); });
afterEach(() => state.cleanup());
function fixture() {
  let calls = 0, usage = 0;
  const adapter: RuntimeAdapter = { guardedInteractive: true, capabilities: { runtime: 'pi-local', subscriptionId: 'fixture', supportsModelSelection: true, supportsEffortSelection: true, effortLevels: ['high'], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: 'fixture' },
    async checkReadiness() { return undefined; }, async readUsage() { usage++; return { ok: true, reading: { subscriptionId: 'fixture', observedAt: new Date().toISOString(), source: 'fixture', windows: [{ kind: 'five-hour', usedPercent: 0, vendorLabel: 'fixture' }, { kind: 'weekly', usedPercent: 0, vendorLabel: 'fixture' }] } }; },
    async dispatch(input) { calls++; const settings = { model: input.settings.model!, effort: input.settings.effort! }; return { outcome: { kind: 'completed', taskId: input.taskId, runId: input.runId, summary: 'fixture', nextAction: 'inspect' }, settings: { requested: settings, resolved: settings, observed: settings } }; }, async reconcile() { return { kind: 'remote-uncertain', summary: 'fixture', nextAction: 'inspect' }; } };
  const core = createCoordinatorCommands(() => adapter);
  const original: DispatchTaskInput = { taskId: 'fixture-task', repo: 'fixture-project', workClass: 'interactive', runtime: 'pi-local', profile: 'offline-custom-tools', actions: ['conversation', 'delegate-task'], triggerSource: 'fixture-owner', prompt: 'exact retained prompt', settings: { model: 'fixture/exact', effort: 'high' }, estimate: { basis: 'operator-bound', detail: 'fixture', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 }, entry: 'interactive', interactive: { requestId: 'original', conversationId: 'conversation' } };
  const grant = () => core.grantCreate(OPERATOR, { repos: [original.repo], workClasses: [original.workClass], runtimes: [original.runtime], profiles: [original.profile], triggerSources: ['fixture-owner'], actions: original.actions, perTask: { maxAttempts: 4, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, aggregate: { maxDispatchesPerWindow: 4, maxConcurrentRuns: 1, windowHours: 24 }, reason: 'private fixture only' });
  return { core, original, grant, calls: () => calls, usage: () => usage };
}
function confirmation(original: DispatchTaskInput, authority: AuthorityConfirmationInput['expectedAuthority']): AuthorityConfirmationInput {
  return { original, expectedAuthority: authority, decisionId: 'owner-choice', requestId: 'inbox-request', requestVersion: 1, handoffDigest: 'a'.repeat(64) };
}
describe('owner existing-authority confirmation through public commands', () => {
  it('records scope-only coverage without replay or a provider read; new explicit identity still needs admission', async () => {
    const f = fixture(); const refusal = await f.core.interactiveSubmit(f.original);
    assert.equal(refusal?.result?.outcome.kind, 'awaiting-approval');
    const grant = f.grant(); const preview = f.core.authorityPreviewForOperator(OPERATOR, f.original); assert.equal(preview.allowed, true);
    const before = f.usage(); const input = confirmation(f.original, { type: 'grant', id: grant.id, version: grant.version });
    const receipt = f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist());
    assert.equal(receipt.coverage, 'scope-only'); assert.equal(receipt.submissionFingerprint, refusal!.fingerprint);
    assert.deepEqual(f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist()), receipt);
    assert.equal(f.calls(), 0); assert.equal(f.usage(), before); assert.equal(f.core.status().reservations.length, 0);
    assert.equal((await f.core.interactiveSubmit(f.original))?.result?.outcome.kind, 'awaiting-approval');
    assert.equal((await f.core.interactiveSubmit({ ...f.original, interactive: { ...f.original.interactive!, requestId: 'new-explicit-turn' } }))?.run?.status, 'completed');
    assert.equal(f.calls(), 1);
  });
  it('keeps explicit approval selection distinct from original immutable fingerprint', async () => {
    const f = fixture(); const refused = await f.core.interactiveSubmit(f.original);
    const approval = f.core.approve(OPERATOR, { repo: f.original.repo, taskScope: 'owner-described scope; not task-ID enforcement', workClass: f.original.workClass, runtime: f.original.runtime, profile: f.original.profile, actions: f.original.actions, limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, model: 'fixture/exact', effort: 'high' });
    assert.equal(f.core.authorityPreviewForOperator(OPERATOR, f.original).allowed, false);
    const input = { ...confirmation(f.original, { type: 'approval' as const, id: approval.id, version: approval.version }), binding: { approvalId: approval.id } };
    const receipt = f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist());
    assert.equal(receipt.submissionFingerprint, refused!.fingerprint); assert.equal(f.core.interactiveLookup('original')!.fingerprint, refused!.fingerprint);
    await assert.rejects(() => f.core.interactiveSubmit({ ...f.original, approvalId: approval.id }), /reused/);
    assert.equal((await f.core.interactiveSubmit({ ...f.original, approvalId: approval.id, interactive: { ...f.original.interactive!, requestId: 'bound-new-turn' } }))?.run?.status, 'completed');
  });
  it('refuses revocation after preview, changed received envelope/version, operator spoofing and changed idempotent content', async () => {
    const f = fixture(); await f.core.interactiveSubmit(f.original); const grant = f.grant();
    const input = confirmation(f.original, { type: 'grant', id: grant.id, version: grant.version });
    assert.equal(f.core.authorityPreviewForOperator(OPERATOR, f.original).allowed, true);
    assert.throws(() => f.core.authorityConfirmationRecord({ kind: 'agent', id: 'forged' }, input, persist => persist()));
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, { ...input, original: { ...f.original, prompt: 'changed' } }, persist => persist()), /pinned/);
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, { ...input, expectedAuthority: { ...input.expectedAuthority, version: 2 } }, persist => persist()), /changed/);
    let escaped!: () => unknown;
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, input, persist => { escaped = persist; return Promise.resolve(); }), /synchronous/);
    assert.throws(() => escaped(), /synchronously/);
    const first = f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist());
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, { ...input, requestVersion: 2 }, persist => persist()), /reused/);
    f.core.grantRevoke(OPERATOR, grant.id, 'fixture revoked after preview');
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist()), /revoked/);
    assert.equal(first.expectedAuthority.id, grant.id); assert.equal(f.calls(), 0);
  });
  it('unresolved awaiting-approval handoffs cannot be archived merely because new scope authority exists', async () => {
    const f = fixture(); await f.core.interactiveSubmit(f.original); const grant = f.grant();
    const input = confirmation(f.original, { type: 'grant', id: grant.id, version: grant.version });
    assert.throws(() => f.core.interactiveArchive(OPERATOR, { archiveId: 'fixture-prepared-cutoff', product: { kind: 'task', id: 'product-task' }, receivers: [{ spaceId: 'fixture-space', taskId: 'product-task', conversationId: 'conversation' }], taskIds: [f.original.taskId], runIds: [] }, () => { throw new Error('fixture SQL not acknowledged'); }), /unresolved/);
    assert.equal(f.core.interactiveArchiveLookup(OPERATOR, 'fixture-prepared-cutoff'), undefined);
    assert.equal(f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist()).coverage, 'scope-only');
    assert.equal(f.calls(), 0); assert.equal(f.core.status().reservations.length, 0);
  });
  it('retains one receipt after a lost product acknowledgement and refuses a changed delegation parent', async () => {
    const f = fixture(); await f.core.interactiveSubmit(f.original); const grant = f.grant();
    const input = confirmation(f.original, { type: 'grant', id: grant.id, version: grant.version });
    let retained: unknown;
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, input, persist => { retained = persist(); throw new Error('lost product ACK'); }), /lost product/);
    assert.deepEqual(f.core.authorityConfirmationRecord(OPERATOR, input, persist => persist()), retained);
    const parent = await f.core.interactiveSubmit({ ...f.original, interactive: { ...f.original.interactive!, requestId: 'parent-run' } });
    const child = { ...f.original, taskId: 'child', interactive: { requestId: 'child-refusal', conversationId: 'child-conversation', parentRunId: parent!.run!.id } };
    f.core.grantRevoke(OPERATOR, grant.id, 'fixture parent scope revoked');
    assert.equal((await f.core.interactiveSubmit(child))?.result?.outcome.kind, 'awaiting-approval');
    const replacement = f.grant();
    assert.throws(() => f.core.authorityConfirmationRecord(OPERATOR, { ...confirmation(child, { type: 'grant', id: replacement.id, version: replacement.version }), parentAuthority: parent!.run!.authority }, persist => persist()), /parent/);
    assert.equal(f.calls(), 1);
  });
});
