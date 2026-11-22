import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveRun } from './run.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCoordinatorCommands, type DispatchTaskInput } from '../commands.js';
import type { DispatchInput, DispatchResult, RuntimeAdapter } from '../adapters/types.js';
import { OPERATOR, sandbox, type Sandbox } from './testkit.js';
import { listReservations } from './admission.js';

class Adapter implements RuntimeAdapter {
  readonly guardedInteractive = true;
  readonly capabilities = { runtime: 'pi-local' as const, subscriptionId: 'test-interactive', supportsModelSelection: true, supportsEffortSelection: true, effortLevels: ['high'], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: 'guarded' };
  calls = 0; gate: Promise<void> | null = null; fault = false; prepromptFailure = false;
  async readUsage() { return { ok: true as const, reading: { subscriptionId: 'test-interactive', observedAt: new Date().toISOString(), source: 'fixture', windows: [{ kind: 'five-hour' as const, usedPercent: 0, vendorLabel: 'fixture' }, { kind: 'weekly' as const, usedPercent: 0, vendorLabel: 'fixture' }] } }; }
  async checkReadiness() { return undefined; }
  newSessionId() { return 'fixture-session'; }
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.calls++; if (this.gate) await this.gate; if (this.fault) throw new Error('Lost acknowledgement');
    const settings = { model: input.settings.model!, effort: input.settings.effort! };
    if (this.prepromptFailure) return { outcome: { kind: 'setup-blocked', promptNotSent: true, taskId: input.taskId, runId: input.runId, summary: 'fixture preprompt failure; worker teardown verified', nextAction: 'owner setup' }, settings: { requested: settings, resolved: settings, observed: settings } };
    return { outcome: { kind: 'completed', taskId: input.taskId, runId: input.runId, summary: 'fixture turn', nextAction: 'review' }, settings: { requested: settings, resolved: settings, observed: settings }, sessionId: 'fixture-session' };
  }
  async reconcile() { return { kind: 'remote-uncertain' as const, summary: 'fixture uncertainty', nextAction: 'inspect' }; }
}
let state: Sandbox;
beforeEach(() => { state = sandbox(); });
afterEach(() => state.cleanup());
function fixture(adapter: Adapter, maxAttempts = 4, maxConcurrentRuns = 2) {
  const core = createCoordinatorCommands(() => adapter);
  const grant = core.grantCreate(OPERATOR, { repos: ['project'], workClasses: ['interactive'], triggerSources: ['spatial-owner'], actions: ['conversation', 'task-tools', 'delegate-task'], runtimes: ['pi-local'], profiles: ['offline-custom-tools'], perTask: { maxAttempts, maxConcurrentRuns, maxPaidCallUsd: 0 }, aggregate: { maxDispatchesPerWindow: 10, windowHours: 24, maxConcurrentRuns }, reason: 'disposable fixture only' });
  const input: DispatchTaskInput = { taskId: 'parent', repo: 'project', workClass: 'interactive', runtime: 'pi-local', profile: 'offline-custom-tools', actions: ['conversation', 'task-tools', 'delegate-task'], triggerSource: 'spatial-owner', prompt: 'fixture turn', settings: { model: 'provider/exact', effort: 'high' }, estimate: { basis: 'operator-bound', detail: 'fixture', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 }, entry: 'interactive', interactive: { requestId: 'request-1', conversationId: 'conversation-1' } };
  return { core, input, grant };
}
describe('public guarded interactive submission/lookup/current authority contract', () => {
  it('replays one stable request while running and after settlement without dispatch/reservation duplication', async () => {
    const adapter = new Adapter(); let release!: () => void; adapter.gate = new Promise<void>(accept => { release = accept; });
    const { core, input } = fixture(adapter);
    const running = core.interactiveSubmit(input);
    while (adapter.calls === 0) await new Promise(resolve => setImmediate(resolve));
    const duplicate = await core.interactiveSubmit(input);
    assert.equal(duplicate?.run?.status, 'running'); assert.equal(adapter.calls, 1); assert.equal(listReservations().filter(item => item.state !== 'released').length, 1);
    assert.equal(core.currentAuthoritySettings(duplicate!.run!.id, 'task-tools').allowed, true);
    release(); const settled = await running;
    assert.equal(settled?.run?.status, 'completed'); assert.equal((await core.interactiveSubmit(input))?.run?.id, settled?.run?.id); assert.equal(adapter.calls, 1);
    assert.equal(core.currentAuthoritySettings(settled!.run!.id, 'task-tools').allowed, false);
    assert.equal(listReservations().filter(item => item.state !== 'released').length, 0);
  });
  it('rejects forged/reused identities and nonexplicit settings before inference', async () => {
    const adapter = new Adapter(); const { core, input } = fixture(adapter);
    await core.interactiveSubmit(input);
    await assert.rejects(() => core.interactiveSubmit({ ...input, prompt: 'different' }), /reused/);
    await assert.rejects(() => core.interactiveSubmit({ ...input, settings: {} }), /explicit/);
    assert.equal((await core.dispatch({ ...input, interactive: { requestId: 'not-received', conversationId: 'conversation-1' } })).outcome.kind, 'refused');
    assert.equal(adapter.calls, 1);
  });
  it('ordinary shared CLI/MCP/UI dispatch entries cannot turn generic conversation/task capabilities into legacy host tools', async () => {
    const adapter = new Adapter(); const { core, input } = fixture(adapter);
    const { entry: _entry, interactive: _identity, ...ordinary } = input;
    for (const entry of [undefined, 'skill', 'prompt', 'review-pr'] as const) {
      const result = await core.dispatch({ ...ordinary, actions: ['conversation'], ...(entry ? { entry } : {}) });
      assert.equal(result.outcome.kind, 'refused'); assert.equal(result.runtimeDispatched, false);
      assert.match(result.outcome.summary, /guarded interactive submission/);
    }
    assert.equal(adapter.calls, 0); assert.equal(core.status().runs.length, 0); assert.equal(listReservations().length, 0);
  });
  it('retains uncertain effects, run identity and reservations instead of retrying a lost outcome', async () => {
    const adapter = new Adapter(); adapter.fault = true; const { core, input } = fixture(adapter);
    const result = await core.interactiveSubmit(input);
    assert.equal(result?.run?.status, 'remote-uncertain'); assert.equal(listReservations().filter(item => item.state !== 'released').length, 1);
    const restarted = createCoordinatorCommands(() => adapter);
    assert.equal(restarted.interactiveLookup(input.interactive!.requestId)?.run?.id, result?.run?.id);
    await restarted.interactiveSubmit(input); assert.equal(adapter.calls, 1);
  });
  it('rechecks grant version and revocation before tools without reading a cached authority store', async () => {
    const adapter = new Adapter(); let release!: () => void; adapter.gate = new Promise<void>(accept => { release = accept; });
    const { core, input, grant } = fixture(adapter); const result = core.interactiveSubmit(input);
    while (!core.interactiveLookup('request-1')?.run?.runtimeDispatched) await new Promise(resolve => setImmediate(resolve));
    const run = core.interactiveLookup('request-1')!.run!;
    assert.equal(core.currentAuthoritySettings(run.id, 'task-tools').allowed, true);
    core.grantNarrow(OPERATOR, grant.id, { actions: ['conversation'], reason: 'fixture narrowing' });
    assert.equal(core.currentAuthoritySettings(run.id, 'task-tools').allowed, false);
    assert.equal(core.currentAuthoritySettings(run.id, 'conversation').allowed, false);
    core.grantRevoke(OPERATOR, grant.id, 'fixture revocation');
    assert.equal(core.currentAuthoritySettings(run.id).allowed, false); release(); await result;
  });
  it('children share their parent resource envelope, scope and exact authority', async () => {
    const adapter = new Adapter(); const { core, input } = fixture(adapter, 2, 2);
    const parent = await core.interactiveSubmit(input);
    const child = { ...input, taskId: 'child', interactive: { requestId: 'child-request', conversationId: 'child-conversation', parentRunId: parent!.run!.id } };
    const result = await core.interactiveSubmit(child); assert.equal(result?.run?.status, 'completed'); assert.equal(result?.run?.interactive?.rootTaskId, 'parent');
    const third = await core.interactiveSubmit({ ...child, taskId: 'another-child', interactive: { ...child.interactive, requestId: 'third-request', conversationId: 'third' } });
    assert.equal(third?.result?.outcome.kind, 'refused'); assert.equal(adapter.calls, 2);
    const followup = await core.interactiveSubmit({ ...input, interactive: { ...input.interactive!, requestId: 'parent-followup' } });
    assert.equal(followup?.result?.outcome.kind, 'refused'); assert.equal(adapter.calls, 2);
  });
  it('owner reviews atomically pin current run/authority/evidence/head, without issuing delivery or grants', async () => {
    const adapter = new Adapter(); const { core, input, grant } = fixture(adapter);
    const result = await core.interactiveSubmit(input); const run = result!.run!;
    const pin = core.interactiveEvidencePin(run.id);
    const review = { decisionId: 'review-1', requestId: 'inbox-review-1', submissionId: input.interactive!.requestId, pin, text: 'owner fixture review' };
    assert.equal(core.interactiveReviewRecord(OPERATOR, review).by, OPERATOR.id);
    assert.equal(core.interactiveReviewRecord(OPERATOR, review).decisionId, 'review-1');
    assert.throws(() => core.interactiveReviewRecord({ kind: 'agent', id: OPERATOR.id }, review), /operator/);
    writeFileSync(join(run.evidenceDir!, 'changed-artifact.txt'), 'changed evidence');
    assert.throws(() => core.interactiveReviewRecord(OPERATOR, { ...review, decisionId: 'stale-evidence' }), /changed/);
    const current = core.interactiveEvidencePin(run.id);
    saveRun({ ...run, candidate: { repo: 'project', base: 'base', head: 'different-head' } });
    assert.throws(() => core.interactiveReviewRecord(OPERATOR, { ...review, pin: current, decisionId: 'stale-head' }), /changed/);
    const latest = core.interactiveEvidencePin(run.id);
    core.grantRevoke(OPERATOR, grant.id, 'fixture owner revocation');
    assert.throws(() => core.interactiveReviewRecord(OPERATOR, { ...review, pin: latest, decisionId: 'revoked-review' }), /changed/);
    assert.equal(core.approvalList().length, 0); assert.equal(core.status().runs[0]?.run.delivery?.status, 'unverified');
  });
  it('proven guarded preprompt failures release idle capacity and do not spend the attempt envelope', async () => {
    const adapter = new Adapter(); adapter.prepromptFailure = true; const { core, input } = fixture(adapter, 1, 1);
    const first = await core.interactiveSubmit(input);
    assert.equal(first?.run?.status, 'setup-blocked'); assert.equal(first?.run?.promptNotSent, true); assert.equal(first?.run?.runtimeDispatched, false);
    assert.equal(listReservations().filter(item => item.state !== 'released').length, 0); assert.equal(core.status().runs.filter(item => item.active).length, 0);
    adapter.prepromptFailure = false;
    const second = await core.interactiveSubmit({ ...input, interactive: { ...input.interactive!, requestId: 'explicit-new-request-after-setup' } });
    assert.equal(second?.run?.status, 'completed'); assert.equal(second?.run?.attempt, 1);
  });
  it('legacy adapters cannot execute or label interactive submissions as guarded', async () => {
    const adapter = new Adapter(); const { input } = fixture(adapter);
    const legacy: RuntimeAdapter = { capabilities: adapter.capabilities, readUsage: () => adapter.readUsage(), checkReadiness: () => adapter.checkReadiness(), dispatch: value => adapter.dispatch(value), reconcile: () => adapter.reconcile() };
    const core = createCoordinatorCommands(() => legacy);
    const result = await core.interactiveSubmit(input);
    assert.equal(result?.result?.outcome.kind, 'setup-blocked'); assert.equal(adapter.calls, 0);
    assert.equal(core.currentAuthoritySettings('legacy-run').allowed, false);
  });
});
