import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tryLock } from 'fs-native-extensions';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCoordinatorCommands, type DispatchTaskInput } from '../commands.js';
import type { DispatchInput, DispatchResult, RuntimeAdapter } from '../adapters/types.js';
import type { InteractiveArchiveInput, InteractiveArchiveObservation, InteractiveArchiveReceipt } from './interactive-archive.js';
import { admitWithReading, listReservations, markOutstanding, releaseReservation } from './admission.js';
import { committedUsd, listCalls, reserveCall, releaseCall, settleCall } from './ledger.js';
import { attachRun, bindJobCandidate, dischargeObligations, getJob, submitJob, saveJob } from './intake.js';
import { getRun, saveRun } from './run.js';
import { authorizeDispatch } from './authorize.js';
import { getScorecard } from '../eval/scorecard.js';
import type { ActionId } from './authority.js';
import { stateRoot, withLock, writeJson } from './store.js';
import { OPERATOR, sandbox, type Sandbox } from './testkit.js';

class Adapter implements RuntimeAdapter {
  readonly guardedInteractive = true;
  readonly capabilities = { runtime: 'pi-local' as const, subscriptionId: 'archive-fixture', supportsModelSelection: true, supportsEffortSelection: true, effortLevels: ['high'], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: 'fixture only' };
  calls = 0; gate: Promise<void> | undefined; usageGate: Promise<void> | undefined; fault = false;
  stopCalls = 0; stopGate: Promise<boolean> | undefined;
  async stop() { this.stopCalls++; return this.stopGate ? await this.stopGate : true; }
  async checkReadiness() { return undefined; }
  async readUsage() { await this.usageGate; return reading(); }
  async reconcile() { return { kind: 'remote-uncertain' as const, summary: 'fixture uncertainty', nextAction: 'inspect' }; }
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.calls++; await this.gate; if (this.fault) throw new Error('fixture lost acknowledgement');
    const settings = { model: input.settings.model!, effort: input.settings.effort! };
    return { outcome: { kind: 'completed', runId: input.runId, taskId: input.taskId, summary: 'fixture only', nextAction: 'review' }, settings: { requested: settings, resolved: settings, observed: settings } };
  }
}
function reading() { return { ok: true as const, reading: { subscriptionId: 'archive-fixture', observedAt: new Date().toISOString(), source: 'fixture-no-provider', windows: [{ kind: 'five-hour' as const, usedPercent: 0, vendorLabel: 'fixture' }, { kind: 'weekly' as const, usedPercent: 0, vendorLabel: 'fixture' }] } }; }
const estimate = { basis: 'operator-bound' as const, detail: 'disposable fixture', fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 0 };
let box: Sandbox, database: DatabaseSync;
beforeEach(() => {
  box = sandbox(); database = new DatabaseSync(join(box.root, 'product.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE archives (archiveId TEXT PRIMARY KEY, fingerprint TEXT, kind TEXT, entityId TEXT)');
});
afterEach(() => { database.close(); box.cleanup(); });
function inspect(receipt: Readonly<InteractiveArchiveReceipt>): InteractiveArchiveObservation {
  const row = database.prepare('SELECT * FROM archives WHERE archiveId=?').get(receipt.archiveId);
  return { archiveId: receipt.archiveId, fingerprint: row ? String(row.fingerprint) : receipt.fingerprint, product: row ? { kind: String(row.kind) as InteractiveArchiveInput['product']['kind'], id: String(row.entityId) } : receipt.input.product, state: row ? 'archived' : 'uncommitted' };
}
function commit(receipt: Readonly<InteractiveArchiveReceipt>): InteractiveArchiveObservation {
  database.prepare('INSERT OR IGNORE INTO archives VALUES (?,?,?,?)').run(receipt.archiveId, receipt.fingerprint, receipt.input.product.kind, receipt.input.product.id);
  return inspect(receipt);
}
function fixture(adapter = new Adapter(), maxDispatches = 20, maxAttempts = 12) {
  const core = createCoordinatorCommands(() => adapter);
  core.grantCreate(OPERATOR, { repos: ['project'], workClasses: ['fixture'], triggerSources: ['owner'], actions: ['conversation', 'task-tools', 'delegate-task', 'author-changes'], runtimes: ['pi-local'], profiles: ['archive-fixture'], perTask: { maxAttempts, maxConcurrentRuns: 2, maxPaidCallUsd: 2 }, aggregate: { maxDispatchesPerWindow: maxDispatches, maxConcurrentRuns: 2, windowHours: 24 }, reason: 'isolated fixture only; no live grants' });
  const input: DispatchTaskInput = { taskId: 'root', repo: 'project', workClass: 'fixture', runtime: 'pi-local', profile: 'archive-fixture', actions: ['conversation', 'task-tools', 'delegate-task'], triggerSource: 'owner', settings: { model: 'provider/exact', effort: 'high' }, prompt: 'fixture turn', estimate, entry: 'interactive', interactive: { requestId: 'turn-1', conversationId: 'conversation-root' } };
  return { core, adapter, input };
}
function archive(runId: string, taskId = 'root', conversationId = 'conversation-root'): InteractiveArchiveInput {
  return { archiveId: `archive-${taskId}`, product: { kind: 'task', id: `product-${taskId}` }, receivers: [{ spaceId: 'space-1', conversationId, taskId: `product-${taskId}` }], taskIds: [taskId], runIds: [runId] };
}
function child(code: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env, AGENTSYS_STATE: box.root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}
function result(process: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    process.on('message', resolve); process.once('error', reject);
    process.once('exit', code => { if (code !== 0) reject(new Error(`Fixture child exited ${code}`)); });
  });
}

function archiveDescriptors(): string[] {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try { const path = readlinkSync(`/proc/self/fd/${fd}`); return path.startsWith(join(box.root, 'locks') + '/') ? [path] : []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
async function retainedFamily(count = 258) {
  const { core, input, adapter } = fixture(new Adapter(), count, count);
  const root = (await core.interactiveSubmit(input))!.run!;
  const runs = [root], request = archive(root.id);
  for (let index = 1; index < count; index++) {
    const taskId = `child-${String(index).padStart(4, '0')}`, conversationId = `conversation-${taskId}`;
    const submission = (await core.interactiveSubmit({ ...input, taskId, interactive: { requestId: `turn-${taskId}`, conversationId, parentRunId: root.id } }))!;
    assert.ok(submission.run, JSON.stringify(submission.result));
    const run = submission.run;
    assert.equal(run.status, 'completed'); runs.push(run);
    request.taskIds.push(taskId); request.runIds.push(run.id);
    request.receivers.push({ spaceId: 'space-1', conversationId, taskId: `product-${taskId}` });
  }
  assert.equal(adapter.calls, count);
  assert.equal(listReservations().filter(item => item.state !== 'released').length, 0);
  return { core, input, runs, request };
}

describe('owner archive port: durable coordinator cutoff around synchronous product SQL commit', () => {
  it('archives whole lifetime history beyond 256, including archived children, and freezes every identity without leaking descriptors', { timeout: 120000 }, async () => {
    const { core, input, runs, request } = await retainedFamily(); const last = runs.at(-1)!;
    const archivedChild = runs[1]!;
    core.interactiveArchive(OPERATOR, archive(archivedChild.id, archivedChild.taskId, archivedChild.interactive!.conversationId), commit);
    assert.equal(core.currentAuthoritySettings(last.id, 'conversation', false).allowed, true, 'far-end child is not fenced by its archived sibling');
    const paths = runs.flatMap(run => [join(stateRoot(), 'runs', `${run.id}.json`), join(run.evidenceDir!, 'dispatch-request.json')]);
    const bytes = paths.map(path => readFileSync(path));
    const assertComplete = (receipt: Readonly<InteractiveArchiveReceipt>) => {
      assert.deepEqual(receipt.fence.runIds, runs.map(run => run.id).sort());
      assert.deepEqual(receipt.fence.taskIds, [...request.taskIds, ...request.receivers.map(receiver => receiver.taskId!)].sort());
      assert.deepEqual(receipt.fence.conversationIds, request.receivers.map(receiver => receiver.conversationId).sort());
      assert.deepEqual(Object.keys(receipt.runPins).sort(), receipt.fence.runIds);
      assert.ok(Object.values(receipt.runPins).every(pin => /^[a-f0-9]{64}$/.test(pin.record) && /^[a-f0-9]{64}$/.test(pin.evidence)));
    };
    const assertLastFrozen = () => {
      assert.throws(() => core.interactiveRuntimeResultRecord(last.id, last.interactive!.requestId, { outcome: { kind: 'completed', runId: last.id, summary: 'late writer', nextAction: 'review' }, settings: last.settings }), /archive cutoff/);
      assert.throws(() => core.feedbackRecord(OPERATOR, `card_${last.taskId}`, { verdict: 'accepted', reason: 'late audit' }), /archive cutoff/);
      assert.equal(reserveCall({ taskId: 'unrelated-new-task', runId: last.id, operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }).allowed, false);
      assert.equal(core.currentAuthoritySettings(last.id, 'conversation', false).allowed, false);
    };
    const receipt = core.interactiveArchive(OPERATOR, request, prepared => {
      assertComplete(prepared); assertLastFrozen();
      assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'prepared');
      assert.equal(archiveDescriptors().length, runs.length + 1, 'dispatch and every run descriptor remain owned through SQL');
      for (const run of [runs[0]!, last]) {
        const fd = openSync(join(box.root, 'locks', `run-${run.id}.lock`), 'a+');
        try { assert.equal(tryLock(fd), false); } finally { closeSync(fd); }
      }
      const observation = commit(prepared);
      // The SQL callback sees a detached inventory; it cannot alter the persisted cutoff.
      prepared.fence.runIds.pop(); prepared.fence.taskIds.pop(); prepared.fence.conversationIds.pop();
      delete prepared.runPins[last.id]; prepared.input.runIds.pop();
      return observation;
    });
    assertComplete(receipt); assertLastFrozen(); assert.deepEqual(archiveDescriptors(), []);
    assert.deepEqual(core.interactiveArchive(OPERATOR, request, () => assert.fail('duplicate commit')), receipt);
    assert.deepEqual(core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect), receipt);
    assert.deepEqual(archiveDescriptors(), []);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]));
    await assert.rejects(() => core.interactiveSubmit({ ...input, taskId: 'future-descendant', interactive: { requestId: 'future-descendant', conversationId: 'future-descendant', parentRunId: last.id } }), /archive cutoff/);
    assert.equal(core.status().runs.length, runs.length);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 2);
    const evidencePath = join(last.evidenceDir!, 'dispatch-request.json'), originalEvidence = readFileSync(evidencePath);
    writeFileSync(evidencePath, 'trusted fixture changed far-end evidence');
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /inventory changed/);
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect), /inventory changed/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'archived');
    assert.deepEqual(archiveDescriptors(), []); writeFileSync(evidencePath, originalEvidence);
  });
  it('expands the whole family from one root and refuses active, uncertain or queued work past 256 before SQL; same-key crash reconciliation retains all locks and history', { timeout: 120000 }, async () => {
    const { core, runs, request } = await retainedFamily(257); const last = runs.at(-1)!;
    const expanded = { ...request, taskIds: ['root'], runIds: [runs[0]!.id] };
    for (const status of ['running', 'remote-uncertain'] as const) {
      saveRun({ ...last, status });
      assert.throws(() => core.interactiveArchive(OPERATOR, expanded, () => assert.fail('unsafe SQL')), /active.*uncertain/);
      assert.deepEqual(archiveDescriptors(), []);
    }
    saveRun(last);
    const queued = join(stateRoot(), 'interactive-submissions', 'far-end-queue.json');
    for (const state of ['submitting', 'uncertain'] as const) {
      writeJson(queued, { requestId: 'far-end-queue', taskId: 'far-end-queued-task', parentRunId: last.id, rootTaskId: 'root', conversationId: last.interactive!.conversationId, state });
      assert.throws(() => core.interactiveArchive(OPERATOR, expanded, () => assert.fail('queued SQL')), /submitting\/unknown/);
    }
    writeJson(queued, { requestId: 'far-end-queue', taskId: 'far-end-queued-task', parentRunId: last.id, rootTaskId: 'root', conversationId: last.interactive!.conversationId, state: 'settled', result: { outcome: { kind: 'refused' } } });
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...expanded, receivers: expanded.receivers.slice(0, -1) }, commit), /every linked conversation/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId), undefined);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 0);
    const blockedRun = runs.map(run => run.id).sort().at(-1)!;
    withLock(`run-${blockedRun}`, () => {
      assert.throws(() => core.interactiveArchive(OPERATOR, expanded, () => assert.fail('partial lock SQL')), /busy/);
      assert.deepEqual(archiveDescriptors(), [join(box.root, 'locks', `run-${blockedRun}.lock`)]);
      assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId), undefined);
    });
    assert.deepEqual(archiveDescriptors(), []);
    const archival = child(`import {createCoordinatorCommands} from ${JSON.stringify(new URL('../commands.js', import.meta.url).href)};import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(join(box.root, 'product.sqlite'))});
      createCoordinatorCommands(()=>{throw Error('no runtime');}).interactiveArchive(${JSON.stringify(OPERATOR)},${JSON.stringify(expanded)},r=>{
        db.prepare('INSERT INTO archives VALUES (?,?,?,?)').run(r.archiveId,r.fingerprint,r.input.product.kind,r.input.product.id);
        process.send({runCount:r.fence.runIds.length,conversationCount:r.fence.conversationIds.length});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      });`);
    try {
      assert.deepEqual(await result(archival), { runCount: runs.length, conversationCount: runs.length });
      const paths = ['dispatch', ...runs.map(run => `run-${run.id}`)].map(name => join(box.root, 'locks', `${name}.lock`));
      const inodes = paths.map(path => statSync(path).ino);
      for (const path of [paths[0]!, paths.at(-1)!]) {
        const fd = openSync(path, 'a+'); try { assert.equal(tryLock(fd), false); } finally { closeSync(fd); }
      }
      const exited = once(archival, 'exit'); archival.kill('SIGKILL'); await exited;
      const prepared = core.interactiveArchiveLookup(OPERATOR, request.archiveId)!;
      assert.equal(prepared.state, 'prepared');
      assert.equal(prepared.fence.runIds.length, runs.length);
      assert.equal(reserveCall({ taskId: last.taskId, runId: last.id, operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }).allowed, false);
      const receipt = core.interactiveArchiveReconcile(OPERATOR, request.archiveId, pinned => {
        assert.equal(archiveDescriptors().length, runs.length + 1);
        assert.deepEqual(pinned.fence, prepared.fence); assert.deepEqual(pinned.runPins, prepared.runPins);
        return inspect(pinned);
      }, () => assert.fail('lost ack must not commit twice'));
      assert.equal(receipt.state, 'archived'); assert.deepEqual(receipt.fence, prepared.fence);
      assert.deepEqual(receipt.runPins, prepared.runPins); assert.equal(receipt.inventoryDigest, prepared.inventoryDigest);
      assert.ok(receipt.fence.taskIds.includes('far-end-queued-task'));
      assert.deepEqual(archiveDescriptors(), []);
      assert.deepEqual(paths.map(path => statSync(path).ino), inodes);
      assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 1);
    } finally { archival.kill('SIGKILL'); }
  });
  it('retains terminal runs/evidence, freezes exact history and blocks legacy/new tools/admission without changing grants', async () => {
    const { core, adapter, input } = fixture(); const initial = await core.interactiveSubmit(input); const run = initial!.run!;
    const pin = core.interactiveEvidencePin(run.id); const oldRun = JSON.stringify(getRun(run.id)); const grants = JSON.stringify(core.grantList());
    const receipt = core.interactiveArchive(OPERATOR, archive(run.id), prepared => {
      assert.equal(core.interactiveArchiveLookup(OPERATOR, prepared.archiveId)?.state, 'prepared');
      assert.equal(core.currentAuthoritySettings(run.id, 'conversation', false).allowed, false);
      assert.equal(reserveCall({ taskId: 'root', runId: 'new-call', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }).allowed, false);
      return commit(prepared);
    });
    assert.equal(receipt.state, 'archived'); assert.equal(JSON.stringify(getRun(run.id)), oldRun); assert.equal(JSON.stringify(core.grantList()), grants);
    assert.equal(core.interactiveEvidencePin(run.id).evidenceDigest, pin.evidenceDigest); assert.deepEqual(receipt.fence.runIds, [run.id]);
    assert.equal(core.currentAuthoritySettings(run.id, 'task-tools', false).allowed, false);
    assert.throws(() => core.interactiveReviewRecord(OPERATOR, { decisionId: 'after-archive', requestId: 'review', submissionId: 'turn-1', pin, text: 'must not resume' }), /changed/);
    const { interactive: _identity, entry: _entry, ...legacy } = input;
    assert.equal((await core.dispatch({ ...legacy, actions: ['author-changes'] })).outcome.kind, 'refused');
    await assert.rejects(() => core.interactiveSubmit({ ...input, interactive: { ...input.interactive!, requestId: 'new-turn' } }), /archive cutoff/);
    assert.equal((await core.interactiveSubmit(input))?.run?.id, run.id, 'historical exact replay is lookup only');
    assert.equal(adapter.calls, 1);
    assert.throws(() => submitJob({ taskId: 'root', idempotencyKey: 'after-cutoff', repo: 'project', workClass: 'fixture', runtime: 'pi-local', obligations: [] }), /archive cutoff/);
    assert.equal(admitWithReading({ taskId: 'root', runId: 'new-reservation', subscriptionId: 'archive-fixture', estimate }, reading()).admitted, false);
    assert.equal(reserveCall({ taskId: 'product-root', runId: 'new-voice', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }).allowed, false);
    assert.equal(reserveCall({ taskId: 'unrelated', runId: 'other', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }).allowed, true);
  });
  it('prepared and committed cutoff denies legacy authorization and every public audit overwrite, preserving bytes', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!;
    const cardId = `card_${run.taskId}`, head = 'f'.repeat(40);
    const mutations = [
      () => core.feedbackRecord(OPERATOR, cardId, { verdict: 'accepted', reason: 'fixture owner assessment' }),
      () => core.checkResultRecord(OPERATOR, cardId, { name: 'fixture check', outcome: 'passed', source: 'fixture', head }),
      () => core.reviewRecord(OPERATOR, cardId, { author: 'fixture-author', reviewer: { id: 'fixture-reviewer', relationship: 'independent' }, source: 'fixture', head, findings: [] }),
      () => core.repairRecord(OPERATOR, cardId, { trigger: 'failed-check', detail: 'fixture history', head }),
    ];
    for (const mutate of mutations) mutate(); // Unarchived public behavior stays unchanged.
    const paths = [join(stateRoot(), 'runs', `${run.id}.json`), join(stateRoot(), 'scorecards', `${cardId}.json`), join(run.evidenceDir!, 'dispatch-request.json')];
    const before = paths.map(path => readFileSync(path));
    const legacyRequest = { taskId: run.taskId, repo: input.repo, workClass: input.workClass, runtime: input.runtime, profile: input.profile, triggerSource: 'owner', actions: ['author-changes' as ActionId] };
    const assertFrozen = () => {
      const decision = authorizeDispatch(legacyRequest, { checkCapacity: false });
      assert.equal(decision.allowed, false); if (!decision.allowed) assert.match(decision.outcome.summary, /archive cutoff/);
      assert.equal(authorizeDispatch({ ...legacyRequest, taskId: 'unrelated' }, { checkCapacity: false }).allowed, true);
      const floor = authorizeDispatch({ ...legacyRequest, actions: ['merge' as ActionId] });
      assert.equal(floor.allowed, false); if (!floor.allowed) assert.match(floor.outcome.summary, /no authority can permit/);
      for (const mutate of mutations) assert.throws(mutate, /archive cutoff/);
      paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
      assert.equal(core.status({ taskId: run.taskId }).runs[0]!.run.id, run.id);
    };
    core.interactiveArchive(OPERATOR, archive(run.id), receipt => { assertFrozen(); return commit(receipt); });
    assertFrozen();
  });
  it('queued child ancestry is durable before preflight; root expansion requires its exact receiver and settlement', async () => {
    const adapter = new Adapter(); let settleParent!: () => void;
    adapter.gate = new Promise(resolve => { settleParent = resolve; });
    const { core, input } = fixture(adapter); const parentOperation = core.interactiveSubmit(input);
    while (!adapter.calls) await new Promise(resolve => setImmediate(resolve));
    const parent = core.interactiveLookup('turn-1')!.run!;
    let finishPreflight!: () => void; adapter.usageGate = new Promise(resolve => { finishPreflight = resolve; });
    const childInput = { ...input, taskId: 'queued-child', interactive: { requestId: 'queued-child-turn', conversationId: 'queued-child-conversation', parentRunId: parent.id } };
    const childOperation = core.interactiveSubmit(childInput);
    const received = core.interactiveLookup('queued-child-turn')!;
    assert.equal(received.state, 'submitting'); assert.equal(received.run, undefined);
    assert.equal(received.parentRunId, parent.id); assert.equal(received.rootTaskId, 'root');
    settleParent(); await parentOperation;
    const request = archive(parent.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /every linked conversation/);
    request.receivers.push({ spaceId: 'space-1', conversationId: 'queued-child-conversation', taskId: 'product-child' });
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /submitting\/unknown/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 0);
    finishPreflight(); const child = await childOperation;
    assert.equal(child?.state, 'settled'); assert.equal(child?.parentRunId, parent.id); assert.equal(child?.rootTaskId, 'root');
    const done = core.interactiveArchive(OPERATOR, request, commit);
    assert.ok(done.fence.taskIds.includes('queued-child')); assert.ok(done.fence.runIds.includes(child!.run!.id));
  });
  it('old unresolved ancestry blocks its exact known scope, including parent-linked queues, not unrelated roots', async () => {
    const { core, input } = fixture(); const parent = (await core.interactiveSubmit(input))!.run!;
    const path = join(stateRoot(), 'interactive-submissions', 'old-queue.json');
    const request = archive(parent.id);
    for (const state of ['submitting', 'uncertain']) {
      writeJson(path, { requestId: 'old-child', taskId: 'old-child', parentRunId: parent.id, conversationId: 'old-child-conversation', state });
      assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /every linked conversation/);
      const expanded = { ...request, receivers: [...request.receivers, { spaceId: 'space-1', conversationId: 'old-child-conversation', taskId: 'product-child' }] };
      assert.throws(() => core.interactiveArchive(OPERATOR, expanded, commit), /submitting\/unknown/);
      writeJson(path, { requestId: 'old-unknown', taskId: 'root', state });
      assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /submitting\/unknown/);
    }
    writeJson(path, { requestId: 'old-unrelated', taskId: 'unrelated-old-root', state: 'submitting' });
    assert.equal(core.interactiveArchive(OPERATOR, request, commit).state, 'archived');
  });
  it('public runtime-result publication cannot change prepared/archived evidence; replay rechecks the inventory', async () => {
    const { core, input } = fixture(); const received = (await core.interactiveSubmit(input))!; const run = received.run!;
    const file = join(run.evidenceDir!, 'interactive-runtime-result.json');
    const original: DispatchResult = { outcome: received.result!.outcome, settings: run.settings };
    core.interactiveRuntimeResultRecord(run.id, 'turn-1', original); // Normal publication still works.
    const bytes = readFileSync(file); const request = archive(run.id);
    const assertFrozen = () => {
      assert.throws(() => core.interactiveRuntimeResultRecord(run.id, 'turn-1', original), /archive cutoff/);
      assert.throws(() => core.interactiveRuntimeResultRecord(run.id, 'turn-1', { ...original, outcome: { ...original.outcome, summary: 'late result' } }), /archive cutoff/);
      assert.deepEqual(readFileSync(file), bytes);
    };
    const receipt = core.interactiveArchive(OPERATOR, request, prepared => { assertFrozen(); return commit(prepared); });
    assertFrozen(); assert.deepEqual(core.interactiveArchive(OPERATOR, request, commit), receipt);
    // Trusted host/admin raw writes are not public task APIs. Even so, they must
    // not turn a changed frozen inventory into an old successful archive replay.
    writeFileSync(file, 'changed-by-trusted-host');
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /inventory changed/);
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect), /inventory changed/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'archived');
  });
  it('paid-call and job public writers freeze persisted and proposed links, without changing unrelated billing or jobs', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!;
    const settled = reserveCall({ taskId: 'unrelated-paid-task', runId: run.id, operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' });
    const released = reserveCall({ taskId: 'product-root', runId: 'no-voice-call', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' });
    assert.ok(settled.allowed); assert.ok(released.allowed);
    settleCall(settled.reservation.id, 0.04); releaseCall(released.reservation.id);
    const jobInput = { taskId: 'root', idempotencyKey: 'terminal-job', repo: 'project', workClass: 'fixture', runtime: 'pi-local' as const, obligations: ['review'] };
    const job = submitJob(jobInput).job; attachRun(job.id, run); dischargeObligations(job.id, ['review']);
    const unrelated = submitJob({ ...jobInput, taskId: 'unrelated-job', idempotencyKey: 'unrelated-job' }).job;
    const files = [join(stateRoot(), 'jobs', `${job.id}.json`), ...[settled, released].map(call => join(stateRoot(), 'paid-calls', `${call.reservation.id}.json`))];
    const bytes = files.map(file => readFileSync(file)); const spend = committedUsd();
    const assertFrozen = () => {
      for (const call of [settled, released]) {
        assert.throws(() => settleCall(call.reservation.id, 0.08), /archive cutoff/);
        assert.throws(() => settleCall(call.reservation.id), /archive cutoff/);
        assert.throws(() => releaseCall(call.reservation.id), /archive cutoff/);
      }
      assert.throws(() => bindJobCandidate(job.id, { headSha: 'late-head', prBase: 'late-base' }), /archive cutoff/);
      assert.throws(() => attachRun(job.id, { ...run, id: 'late-run' }), /archive cutoff/);
      assert.throws(() => dischargeObligations(job.id, ['review']), /archive cutoff/);
      assert.throws(() => saveJob({ ...getJob(job.id)!, taskId: 'changed-task', runIds: [], note: 'late rewrite' }), /archive cutoff/);
      assert.throws(() => submitJob({ ...jobInput, taskId: 'changed-task' }), /archive cutoff/);
      assert.throws(() => attachRun(unrelated.id, { ...run, taskId: 'forged-unrelated' }), /archive cutoff/);
      assert.throws(() => saveJob({ ...unrelated, runIds: [run.id] }), /archive cutoff/);
      files.forEach((file, index) => assert.deepEqual(readFileSync(file), bytes[index]));
      assert.equal(committedUsd(), spend); assert.equal(listCalls().find(call => call.id === released.reservation.id)!.state, 'released');
      assert.equal(getJob(job.id)?.state, 'settled');
    };
    const receipt = core.interactiveArchive(OPERATOR, archive(run.id), prepared => { assertFrozen(); return commit(prepared); });
    assertFrozen(); assert.deepEqual(core.interactiveArchive(OPERATOR, archive(run.id), commit), receipt);
    bindJobCandidate(unrelated.id, { headSha: 'unrelated-head' }); dischargeObligations(unrelated.id, ['review']);
    saveJob({ ...getJob(unrelated.id)!, note: 'unrelated mutation works' });
    const other = reserveCall({ taskId: 'unrelated', runId: 'unrelated', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }); assert.ok(other.allowed);
    releaseCall(other.reservation.id); settleCall(other.reservation.id, 0.01); settleCall(other.reservation.id);
    assert.equal(listCalls().find(call => call.id === other.reservation.id)!.actualUnknown, true);
  });
  for (const archiveBeforeAck of [false, true]) it(`delayed real stop acknowledgement after settlement${archiveBeforeAck ? ' and archive' : ''} never publishes a stale audit`, async () => {
    const adapter = new Adapter(); let settle!: () => void, acknowledge!: (value: boolean) => void;
    adapter.gate = new Promise(resolve => { settle = resolve; }); adapter.stopGate = new Promise(resolve => { acknowledge = resolve; });
    const { core, input } = fixture(adapter); const operation = core.interactiveSubmit(input);
    while (!adapter.calls) await new Promise(resolve => setImmediate(resolve));
    const run = core.interactiveLookup('turn-1')!.run!;
    const stop = core.runStop(OPERATOR, run.id); assert.equal(adapter.stopCalls, 1);
    settle(); await operation;
    const request = archive(run.id);
    const receipt = archiveBeforeAck ? core.interactiveArchive(OPERATOR, request, commit) : undefined;
    const paths = [join(stateRoot(), 'scorecards', `card_${run.taskId}.json`), join(stateRoot(), 'runs', `${run.id}.json`), join(run.evidenceDir!, 'dispatch-request.json')];
    const bytes = paths.map(path => readFileSync(path)); acknowledge(true);
    await assert.rejects(stop, archiveBeforeAck ? /acknowledged.*archived\/prepared.*stale.*no stop audit/ : /acknowledged.*completed.*stale.*no stop audit/);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]));
    if (receipt) assert.deepEqual(core.interactiveArchive(OPERATOR, request, commit), receipt);
  });
  it('ordinary acknowledged stop still records its audit, retained by later dispatch finalization', async () => {
    const adapter = new Adapter(); let settle!: () => void; adapter.gate = new Promise(resolve => { settle = resolve; });
    const { core, input } = fixture(adapter); const operation = core.interactiveSubmit(input);
    while (!adapter.calls) await new Promise(resolve => setImmediate(resolve));
    const run = core.interactiveLookup('turn-1')!.run!; const result = await core.runStop(OPERATOR, run.id);
    assert.equal(result.stoppedBy, OPERATOR.id); settle(); await operation;
    const card = getScorecard('card_root')!;
    assert.deepEqual(card.stops, [{ runId: run.id, by: OPERATOR.id, at: result.at }]);
  });
  it('explicit retained notes with no execution need no grant or invented run, and durably fence future submissions', async () => {
    const core = createCoordinatorCommands(() => { throw new Error('offline history must not touch runtime'); });
    const request: InteractiveArchiveInput = { archiveId: 'notes-archive', product: { kind: 'space', id: 'registered-space' }, receivers: [{ spaceId: 'registered-space', conversationId: 'retained-notes', taskId: 'stopped-product-task' }], taskIds: [], runIds: [] };
    const first = core.interactiveArchive(OPERATOR, request, commit);
    assert.deepEqual(first.fence, { taskIds: ['stopped-product-task'], conversationIds: ['retained-notes'], runIds: [] });
    assert.deepEqual(first.runPins, {}); assert.equal(core.grantList().length, 0); assert.equal(core.status().runs.length, 0);
    assert.deepEqual(core.interactiveArchive(OPERATOR, request, () => assert.fail('same notes key must not commit twice')), first);
    assert.deepEqual(core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect), first);
    const input: DispatchTaskInput = { taskId: 'future-task', repo: 'project', workClass: 'fixture', runtime: 'pi-local', profile: 'archive-fixture', actions: ['conversation'], settings: { model: 'provider/exact', effort: 'high' }, prompt: 'offline', estimate, entry: 'interactive', interactive: { requestId: 'future-notes-turn', conversationId: 'retained-notes' } };
    await assert.rejects(() => core.interactiveSubmit(input), /archive cutoff/);
    await assert.rejects(() => core.interactiveSubmit({ ...input, taskId: 'stopped-product-task', interactive: { requestId: 'future-task-turn', conversationId: 'other' } }), /archive cutoff/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 1);
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...request, archiveId: 'unknown-history', product: { kind: 'space', id: 'other-space' }, runIds: ['unknown-run'] }, commit), /missing/);
  });
  it('zero-run inventory still refuses exact queued work, jobs, calls and reservations before SQL', () => {
    const core = createCoordinatorCommands(() => { throw new Error('offline'); });
    const request: InteractiveArchiveInput = { archiveId: 'offline-cutoff', product: { kind: 'task', id: 'offline-task' }, receivers: [{ spaceId: 'space', conversationId: 'offline-conversation', taskId: 'offline-task' }], taskIds: [], runIds: [] };
    const queued = join(stateRoot(), 'interactive-submissions', 'offline-queue.json');
    writeJson(queued, { requestId: 'queued', taskId: 'offline-task', conversationId: 'offline-conversation', state: 'uncertain' });
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /submitting\/unknown/);
    writeJson(queued, { requestId: 'queued', taskId: 'offline-task', conversationId: 'offline-conversation', state: 'settled', result: { outcome: { kind: 'refused' } } });
    const job = submitJob({ taskId: 'offline-task', idempotencyKey: 'offline-job', repo: 'project', workClass: 'fixture', runtime: 'pi-local', obligations: ['review'] }).job;
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /open jobs/); dischargeObligations(job.id, ['review']);
    const paid = reserveCall({ taskId: 'offline-task', runId: 'unknown-root', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }); assert.ok(paid.allowed);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /paid calls/); releaseCall(paid.reservation.id);
    const held = admitWithReading({ taskId: 'offline-task', runId: 'unknown-root', subscriptionId: 'archive-fixture', estimate }, reading()); assert.equal(held.admitted, true);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /subscription reservations/); releaseReservation(held.reservationId!);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 0);
    assert.equal(core.interactiveArchive(OPERATOR, request, commit).state, 'archived');
  });
  it('archive fingerprints and cutoff reads use codepoint order in real en-US and da-DK processes', { timeout: 10000 }, async () => {
    const request: InteractiveArchiveInput = { archiveId: 'case-archive', product: { kind: 'space', id: 'case-space' }, receivers: [{ spaceId: 'space', conversationId: 'a', taskId: null }, { spaceId: 'space', conversationId: 'A', taskId: null }], taskIds: [], runIds: [] };
    const values: Array<{ receipt: InteractiveArchiveReceipt; locale: string; localeOrder: string[]; blocked: boolean }> = [];
    for (const locale of ['en_US.UTF-8', 'da_DK.UTF-8']) {
      const contender = child(`import {createCoordinatorCommands} from ${JSON.stringify(new URL('../commands.js', import.meta.url).href)};import {DatabaseSync} from 'node:sqlite';
        const db=new DatabaseSync(${JSON.stringify(join(box.root, 'product.sqlite'))});const core=createCoordinatorCommands(()=>{throw Error('no runtime');});
        const receipt=core.interactiveArchive(${JSON.stringify(OPERATOR)},${JSON.stringify(request)},r=>{db.prepare('INSERT INTO archives VALUES (?,?,?,?)').run(r.archiveId,r.fingerprint,r.input.product.kind,r.input.product.id);return {archiveId:r.archiveId,fingerprint:r.fingerprint,product:r.input.product,state:'archived'};});
        let blocked=false;try{await core.interactiveSubmit({taskId:'future',repo:'project',workClass:'fixture',runtime:'pi-local',profile:'archive-fixture',actions:['conversation'],settings:{model:'exact',effort:'high'},prompt:'fixture',entry:'interactive',interactive:{requestId:'locale-new-turn',conversationId:'a'}});}catch(e){blocked=/archive cutoff/.test(e.message);}
        db.close();process.send({receipt,locale:new Intl.Collator().resolvedOptions().locale,localeOrder:['a','A'].sort((a,b)=>a.localeCompare(b)),blocked});process.disconnect();`, { LC_ALL: locale, LANG: locale });
      try { values.push(await result(contender) as typeof values[number]); } finally { contender.kill('SIGKILL'); }
    }
    assert.match(values[0]!.locale, /^en/); assert.match(values[1]!.locale, /^da/);
    assert.notDeepEqual(values[0]!.localeOrder, values[1]!.localeOrder, 'actual ICU locales exercise differing case collation');
    assert.deepEqual(values[0]!.receipt.input.receivers.map(receiver => receiver.conversationId), ['A', 'a']);
    assert.deepEqual(values[0]!.receipt, values[1]!.receipt); assert.ok(values.every(value => value.blocked));
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 1);
  });
  it('same archived key is a stable receipt, changed keys/destinations never make a second tombstone', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    const first = core.interactiveArchive(OPERATOR, request, commit);
    assert.deepEqual(core.interactiveArchive(OPERATOR, request, () => assert.fail('must not re-commit')), first);
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...request, taskIds: ['different'] }, commit), /reused/);
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...request, archiveId: 'second-id' }, commit), /archive cutoff/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 1);
  });
  it('callback failure quarantines prepared cutoff; exact owner retry first reads SQL and uses the same key', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, () => { throw new Error('SQL fixture failed'); }), /SQL fixture/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'prepared');
    assert.equal(core.currentAuthoritySettings(run.id, 'conversation', false).allowed, false);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /reconciliation/);
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect), /explicit same-key/);
    const receipt = core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, commit);
    assert.equal(receipt.state, 'archived'); assert.deepEqual(receipt.choices.map(choice => choice.action), ['archive', 'retry']);
  });
  it('lost acknowledgement finalizes observable same SQL receipt without calling commit again', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, receipt => { commit(receipt); throw new Error('lost SQL acknowledgement'); }), /lost SQL/);
    const receipt = core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, () => assert.fail('duplicate SQL commit'));
    assert.equal(receipt.state, 'archived'); assert.deepEqual(receipt.choices.map(choice => choice.action), ['archive', 'reconcile']);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 1);
  });
  it('owner-only exact identities and synchronous callbacks cannot be replaced by API booleans/promises', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    for (const actor of [{ kind: 'agent' as const, id: OPERATOR.id }, { kind: 'operator' as const, id: 'browser-owner-id' }]) {
      assert.throws(() => core.interactiveArchive(actor, request, commit), /operator/);
      assert.throws(() => core.interactiveArchiveLookup(actor, request.archiveId), /operator/);
      assert.throws(() => core.interactiveArchiveReconcile(actor, request.archiveId, inspect), /operator/);
    }
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...request, runIds: ['../../host-file'] }, commit), /identities/);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, (async () => assert.fail('async callback must not run')) as unknown as typeof commit), /synchronous/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId), undefined);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, (() => Promise.resolve(false)) as unknown as typeof commit), /promise/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.failure, 'asynchronous-callback');
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, commit), /unsupported/);
  });
  it('client booleans and mismatched product SQL references cannot acknowledge a prepared archive', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, (() => true) as unknown as typeof commit), /observable product SQL receipt/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'prepared');
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, receipt => ({ ...inspect(receipt), fingerprint: 'different', state: 'archived' })), /matching/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 0);
    assert.equal(core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, commit).state, 'archived');
  });
  it('refuses active/uncertain runs without invoking SQL or silently cancelling them', async () => {
    const adapter = new Adapter(); let release!: () => void; adapter.gate = new Promise(resolve => { release = resolve; });
    const { core, input } = fixture(adapter); const operation = core.interactiveSubmit(input);
    while (!adapter.calls) await new Promise(resolve => setImmediate(resolve));
    const run = core.interactiveLookup('turn-1')!.run!;
    assert.throws(() => core.interactiveArchive(OPERATOR, archive(run.id), () => assert.fail('no cancellation')), /active/);
    assert.equal(core.interactiveLookup('turn-1')!.run!.status, 'running'); release(); await operation;
    const stopped = getRun(run.id)!; saveRun({ ...stopped, status: 'remote-uncertain' });
    assert.throws(() => core.interactiveArchive(OPERATOR, archive(run.id), commit), /uncertain/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, 'archive-root'), undefined);
  });
  it('refuses outstanding reservations, open jobs, submitting/uncertain segments, linked approvals and missing history', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    const held = admitWithReading({ taskId: 'root', runId: 'orphan', subscriptionId: 'archive-fixture', estimate }, reading()); assert.equal(held.admitted, true);
    markOutstanding(held.reservationId!, 'unknown fixture');
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /outstanding/); releaseReservation(held.reservationId!);
    const call = reserveCall({ taskId: 'product-root', runId: 'voice', operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }); assert.equal(call.allowed, true);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /paid calls/); if (call.allowed) releaseCall(call.reservation.id);
    const job = submitJob({ taskId: 'root', idempotencyKey: 'open-job', repo: 'project', workClass: 'fixture', runtime: 'pi-local', obligations: ['unfinished'] }).job;
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /open jobs/); saveJob({ ...job, state: 'abandoned' });
    const receiptPath = join(stateRoot(), 'interactive-submissions', 'unreceived.json');
    writeJson(receiptPath, { requestId: 'unknown', taskId: 'different-task', conversationId: 'conversation-root', state: 'submitting' });
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /submitting/);
    writeJson(receiptPath, { requestId: 'unknown', taskId: 'different-task', conversationId: 'conversation-other', state: 'settled', result: { outcome: { kind: 'refused' } } });
    assert.throws(() => core.interactiveArchive(OPERATOR, { ...request, runIds: ['missing-run'] }, commit), /missing/);
    const approval = core.approve(OPERATOR, { repo: 'project', taskScope: 'fixture', workClass: 'fixture', runtime: 'pi-local', profile: 'archive-fixture', actions: ['conversation'], limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 } });
    saveRun({ ...run, authority: { type: 'approval', id: approval.id, version: approval.version } });
    assert.throws(() => core.interactiveArchive(OPERATOR, request, commit), /approval/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 0);
  });
  it('child-only cutoff does not block its parent or sibling; root cutoff expands and forbids future descendants', async () => {
    const { core, input } = fixture(); const parent = (await core.interactiveSubmit(input))!.run!;
    const childInput = { ...input, taskId: 'child', interactive: { requestId: 'child-turn', conversationId: 'conversation-child', parentRunId: parent.id } };
    const childRun = (await core.interactiveSubmit(childInput))!.run!;
    core.interactiveArchive(OPERATOR, archive(childRun.id, 'child', 'conversation-child'), commit);
    assert.equal(core.currentAuthoritySettings(parent.id, 'delegate-task', false).allowed, true);
    const sibling = await core.interactiveSubmit({ ...childInput, taskId: 'sibling', interactive: { ...childInput.interactive, requestId: 'sibling-turn', conversationId: 'conversation-sibling' } });
    assert.equal(sibling!.run!.status, 'completed');
    await assert.rejects(() => core.interactiveSubmit({ ...childInput, taskId: 'grandchild', interactive: { requestId: 'grandchild-turn', conversationId: 'new-conversation', parentRunId: childRun.id } }), /archive cutoff/);
    const rootArchive = archive(parent.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, rootArchive, commit), /every linked conversation/);
    rootArchive.receivers.push({ spaceId: 'space-1', conversationId: 'conversation-child', taskId: 'product-child' }, { spaceId: 'space-1', conversationId: 'conversation-sibling', taskId: 'product-sibling' });
    const rootReceipt = core.interactiveArchive(OPERATOR, rootArchive, commit);
    assert.deepEqual(rootReceipt.fence.taskIds, ['child', 'product-child', 'product-root', 'product-sibling', 'root', 'sibling']);
    assert.equal(rootReceipt.fence.runIds.length, 3);
    await assert.rejects(() => core.interactiveSubmit({ ...childInput, taskId: 'future-sibling', interactive: { requestId: 'future-sibling', conversationId: 'future-conversation', parentRunId: parent.id } }), /archive cutoff/);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archives').get()!.n, 2, 'distinct parent/child product destinations retain their own tombstones');
  });
  it('frozen evidence/work changes never clear an unknown prepared quarantine', async () => {
    const { core, input } = fixture(); const run = (await core.interactiveSubmit(input))!.run!; const request = archive(run.id);
    assert.throws(() => core.interactiveArchive(OPERATOR, request, () => { throw new Error('fixture'); }));
    writeFileSync(join(run.evidenceDir!, 'later.txt'), 'changed evidence');
    assert.throws(() => core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, commit), /changed/);
    assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'prepared');
    assert.equal(core.currentAuthoritySettings(run.id, 'conversation', false).allowed, false);
  });
  it('real legacy preflight started before archive cannot cross the final shared claim afterward', { timeout: 10000 }, async () => {
    const { core, input, adapter } = fixture(); const run = (await core.interactiveSubmit(input))!.run!;
    const { interactive: _identity, entry: _entry, ...ordinary } = input;
    const contender = child(`import {createCoordinatorCommands} from ${JSON.stringify(new URL('../commands.js', import.meta.url).href)};
      const adapter={capabilities:${JSON.stringify(adapter.capabilities)},async checkReadiness(){},async reconcile(){throw Error('terminal history should not invoke runtime');},
      readUsage(){process.send('preflight');return new Promise(resolve=>process.once('message',()=>resolve(${JSON.stringify(reading())})));},
      async dispatch(){process.send('BAD');throw Error('must not execute');}};
      const value=await createCoordinatorCommands(()=>adapter).dispatch(${JSON.stringify({ ...ordinary, actions: ['author-changes'] })});process.send(value.outcome.kind);process.disconnect();`);
    try {
      assert.equal(await result(contender), 'preflight');
      core.interactiveArchive(OPERATOR, archive(run.id), commit);
      const outcome = result(contender); contender.send('continue'); assert.equal(await outcome, 'refused');
      assert.equal(core.status().runs.length, 1);
    } finally { contender.kill('SIGKILL'); }
  });
  for (const sqlCommitted of [false, true]) it(`real killed callback ${sqlCommitted ? 'after' : 'before'} SQL commit retains cutoff against independent legacy/new/paid/intake contenders`, { timeout: 20000 }, async () => {
    const { core, input } = fixture(); const initial = (await core.interactiveSubmit(input))!; const run = initial.run!; const request = archive(run.id);
    const runtimeResult: DispatchResult = { outcome: initial.result!.outcome, settings: run.settings };
    core.interactiveRuntimeResultRecord(run.id, 'turn-1', runtimeResult);
    const paid = reserveCall({ taskId: 'root', runId: run.id, operation: 'fixture', boundUsd: 0.1, boundBasis: 'fixture' }); assert.ok(paid.allowed); releaseCall(paid.reservation.id);
    const job = submitJob({ taskId: 'root', idempotencyKey: 'killed-archive-job', repo: 'project', workClass: 'fixture', runtime: 'pi-local', obligations: [] }).job;
    dischargeObligations(job.id, []);
    const frozenFiles = [join(stateRoot(), 'paid-calls', `${paid.reservation.id}.json`), join(stateRoot(), 'jobs', `${job.id}.json`), join(run.evidenceDir!, 'interactive-runtime-result.json')];
    const frozenBytes = frozenFiles.map(file => readFileSync(file));
    const commandsUrl = new URL('../commands.js', import.meta.url).href;
    const archival = child(`import {createCoordinatorCommands} from ${JSON.stringify(commandsUrl)};import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(join(box.root, 'product.sqlite'))});const core=createCoordinatorCommands(()=>{throw Error('No runtime calls');});
      core.interactiveArchive(${JSON.stringify(OPERATOR)},${JSON.stringify(request)},receipt=>{
        if(${String(sqlCommitted)})db.prepare('INSERT INTO archives VALUES (?,?,?,?)').run(receipt.archiveId,receipt.fingerprint,receipt.input.product.kind,receipt.input.product.id);
        process.send('prepared-under-fence');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      });`);
    const contenders: ChildProcess[] = [];
    try {
      await result(archival); const inode = statSync(join(box.root, 'locks', 'dispatch.lock')).ino;
      const modules = { commands: commandsUrl, ledger: new URL('./ledger.js', import.meta.url).href, admission: new URL('./admission.js', import.meta.url).href, intake: new URL('./intake.js', import.meta.url).href };
      const { interactive: _identity, entry: _entry, ...ordinary } = input;
      const scripts = [
        `const core=m.createCoordinatorCommands(()=>{throw Error('must not touch runtime');});const value=await core.dispatch(${JSON.stringify({ ...ordinary, actions: ['author-changes'] })});process.send(value.outcome.kind);`,
        `const core=m.createCoordinatorCommands(()=>{throw Error('must not touch runtime');});try{await core.interactiveSubmit(${JSON.stringify({ ...input, interactive: { requestId: 'new-process-turn', conversationId: 'conversation-root' } })});process.send('BAD');}catch{process.send('refused');}`,
        `process.send(m.reserveCall({taskId:'root',runId:'future',operation:'fixture',boundUsd:0.1,boundBasis:'fixture'}).allowed?'BAD':'refused');`,
        `process.send(m.admitWithReading({taskId:'root',runId:'future',subscriptionId:'archive-fixture',estimate:${JSON.stringify(estimate)}},${JSON.stringify(reading())}).admitted?'BAD':'refused');`,
        `try{m.submitJob({taskId:'root',idempotencyKey:'future',repo:'project',workClass:'fixture',runtime:'pi-local',obligations:[]});process.send('BAD');}catch{process.send('refused');}`,
      ];
      const urls = [modules.commands, modules.commands, modules.ledger, modules.admission, modules.intake];
      for (const [url, mutation] of [
        [modules.ledger, `m.settleCall(${JSON.stringify(paid.reservation.id)},0.08)`],
        [modules.ledger, `m.releaseCall(${JSON.stringify(paid.reservation.id)})`],
        [modules.intake, `m.bindJobCandidate(${JSON.stringify(job.id)},{headSha:'late-head'})`],
        [modules.intake, `m.attachRun(${JSON.stringify(job.id)},${JSON.stringify({ ...run, id: 'late-run' })})`],
        [modules.intake, `m.dischargeObligations(${JSON.stringify(job.id)},[])`],
        [modules.intake, `m.saveJob(${JSON.stringify({ ...job, taskId: 'forged-unrelated', runIds: [] })})`],
        [modules.commands, `m.createCoordinatorCommands(()=>{throw Error('no runtime');}).interactiveRuntimeResultRecord(${JSON.stringify(run.id)},'turn-1',${JSON.stringify(runtimeResult)})`],
      ] as const) {
        urls.push(url); scripts.push(`try{${mutation};process.send('BAD');}catch(e){process.send(/archive cutoff/.test(e.message)?'refused':e.message);}`);
      }
      const answers = scripts.map((script, index) => { const contender = child(`import * as m from ${JSON.stringify(urls[index])};${script}`); contenders.push(contender); return result(contender); });
      const exited = once(archival, 'exit'); archival.kill('SIGKILL'); await exited;
      assert.deepEqual(await Promise.all(answers), scripts.map(() => 'refused'));
      frozenFiles.forEach((file, index) => assert.deepEqual(readFileSync(file), frozenBytes[index]));
      assert.equal(statSync(join(box.root, 'locks', 'dispatch.lock')).ino, inode);
      assert.equal(core.interactiveArchiveLookup(OPERATOR, request.archiveId)?.state, 'prepared');
      const receipt = core.interactiveArchiveReconcile(OPERATOR, request.archiveId, inspect, sqlCommitted ? () => assert.fail('lost ack must not make another tombstone') : commit);
      assert.equal(receipt.state, 'archived'); assert.equal(core.status().runs.length, 1);
      assert.equal(listReservations().filter(item => item.state !== 'released').length, 0);
    } finally { archival.kill('SIGKILL'); for (const contender of contenders) contender.kill('SIGKILL'); }
  });
});
