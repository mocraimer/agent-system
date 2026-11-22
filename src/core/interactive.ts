import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DispatchTaskInput, DispatchCommandResult } from '../commands.js';
import type { DispatchResult } from '../adapters/types.js';
import { assertOperator, type Actor, type ActionId, type AuthorityDecision, type AuthorityRef, type DispatchRequest } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { getRun, holdsRunCapacity, listRuns, saveRun, type RunRecord } from './run.js';
import { readJson, stateRoot, withDispatchFence, withLock, writeJson } from './store.js';
import { archivedTarget, assertNotArchived } from './interactive-archive.js';

export interface InteractiveSubmission {
  requestId: string;
  fingerprint: string;
  taskId: string;
  /** Absent only on pre-archive receipts; unknown unlinked work cannot prove archive safety. */
  conversationId?: string;
  /** Exact ancestry received under dispatch, before preflight can await or publish a run. */
  parentRunId?: string;
  rootTaskId?: string;
  state: 'submitting' | 'settled' | 'uncertain';
  result?: DispatchCommandResult;
}
export type InteractiveSubmissionWithRun = InteractiveSubmission & { run?: RunRecord };
class InteractiveClaimError extends Error {}
const path = (id: string): string => join(stateRoot(), 'interactive-submissions', `${createHash('sha256').update(id).digest('hex')}.json`);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const fingerprint = (input: DispatchTaskInput): string => createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');

/** Lookup never executes a runtime or releases an uncertain reservation. */
export function interactiveLookup(requestId: string): InteractiveSubmissionWithRun | undefined {
  const record = readJson<InteractiveSubmission>(path(requestId));
  if (!record) return undefined;
  const run = listRuns().find(run => run.interactive?.requestId === requestId);
  return { ...record, ...(run ? { run } : {}) };
}

/** Durable receive-before-dispatch. A crashed submitter is reconciled, never blindly replayed. */
export async function interactiveSubmit(input: DispatchTaskInput, dispatch: (input: DispatchTaskInput) => Promise<DispatchCommandResult>): Promise<ReturnType<typeof interactiveLookup>> {
  if (input.entry !== 'interactive' || !input.interactive || !input.interactive.requestId.trim() || !input.interactive.conversationId.trim() || input.interactive.requestId.length > 256 || input.interactive.conversationId.length > 256) throw new Error('Explicit bounded interactive identity required.');
  if (!input.settings.model || !input.settings.effort || input.settings.acceptVendorDefault || input.settings.model === 'vendor-default' || input.settings.effort === 'vendor-default') throw new Error('Interactive settings must be chosen explicitly.');
  const id = input.interactive.requestId;
  const digest = fingerprint(input);
  const received = withDispatchFence(() => {
    const existing = interactiveLookup(id);
    if (existing) {
      if (existing.fingerprint !== digest) throw new Error('Interactive request id reused with a different request.');
      return undefined;
    }
    const identity = input.interactive!;
    assertNotArchived({ taskId: input.taskId, conversationId: identity.conversationId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) });
    const parent = identity.parentRunId ? getRun(identity.parentRunId)! : undefined;
    const rootTaskId = parent ? parent.interactive?.rootTaskId ?? parent.taskId : input.taskId;
    if (!rootTaskId.trim() || rootTaskId.length > 256 || (identity.parentRunId && identity.parentRunId.length > 256)) throw new Error('Explicit bounded interactive ancestry required.');
    const record: InteractiveSubmission = { requestId: id, fingerprint: digest, taskId: input.taskId, conversationId: identity.conversationId, rootTaskId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}), state: 'submitting' };
    writeJson(path(id), record);
    return record;
  });
  if (!received) return interactiveLookup(id);
  try {
    const result = await dispatch(input);
    withDispatchFence(() => writeJson(path(id), { ...received, state: result.outcome.kind === 'remote-uncertain' ? 'uncertain' : 'settled', result } satisfies InteractiveSubmission));
  } catch (error) {
    const result: DispatchCommandResult | undefined = error instanceof InteractiveClaimError ? { outcome: { kind: 'refused', taskId: input.taskId, summary: error.message, nextAction: 'Wait for parent work to settle or ask the authenticated owner to review its current scope/resources.' }, recovered: [], runtimeDispatched: false } : undefined;
    withDispatchFence(() => writeJson(path(id), { ...received, state: result ? 'settled' : 'uncertain', ...(result ? { result } : {}) } satisfies InteractiveSubmission));
  }
  return interactiveLookup(id);
}

export function isReceivedInteractiveSubmission(input: DispatchTaskInput): boolean {
  return input.entry === 'interactive' && !!input.interactive && interactiveLookup(input.interactive.requestId)?.fingerprint === fingerprint(input);
}

/** Called within the existing atomic dispatch claim; no second admission system. */
export function interactiveClaim(input: DispatchTaskInput): { rootTaskId: string } | undefined {
  if (input.entry !== 'interactive') return undefined;
  const identity = input.interactive;
  assertNotArchived({ taskId: input.taskId, ...(identity ? { conversationId: identity.conversationId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) } : {}) });
  if (!identity || interactiveLookup(identity.requestId)?.fingerprint !== fingerprint(input)) throw new Error('Interactive dispatch must enter through interactiveSubmit.');
  if (listRuns().some(run => run.interactive?.requestId === identity.requestId)) throw new Error('Interactive request already owns a run.');
  if (!identity.parentRunId) {
    const current = authorizeDispatch(toRequest(input), { checkCapacity: false });
    if (current.allowed) checkFamily(input.taskId, current.limits.maxAttempts, current.limits.maxConcurrentRuns);
    return { rootTaskId: input.taskId };
  }
  const parent = currentAuthoritySettings(identity.parentRunId, undefined, false);
  if (!parent.allowed) throw new InteractiveClaimError('Delegation parent authority is unavailable.');
  const run = parent.run;
  if (!run.interactive || !run.actions.includes('delegate-task') || run.repo !== input.repo || run.workClass !== input.workClass || run.profile !== input.profile || input.actions.some(action => !run.actions.includes(action))) throw new InteractiveClaimError('Child task widens parent scope.');
  const childAuthority = authorizeDispatch(toRequest(input), { checkCapacity: false });
  if (!childAuthority.allowed || JSON.stringify(childAuthority.authority) !== JSON.stringify(run.authority)) throw new InteractiveClaimError('Child task must use its parent current authority.');
  const rootTaskId = run.interactive.rootTaskId;
  checkFamily(rootTaskId, run.limits.maxAttempts, run.limits.maxConcurrentRuns);
  return { rootTaskId };
}
function checkFamily(rootTaskId: string, maxAttempts: number, maxConcurrent: number): void {
  const family = listRuns().filter(item => (item.taskId === rootTaskId || item.interactive?.rootTaskId === rootTaskId) && !(item.interactive && item.promptNotSent === true && item.runtimeDispatched === false) && (item.status !== 'quota-waiting' || item.runtimeDispatched === true));
  const attempts = Math.min(maxAttempts, ...family.map(item => item.limits.maxAttempts));
  const concurrent = Math.min(maxConcurrent, ...family.map(item => item.limits.maxConcurrentRuns));
  if (family.length >= attempts || family.filter(holdsRunCapacity).length >= concurrent) throw new InteractiveClaimError('Parent task resource envelope exhausted; wait or ask the owner.');
}

function toRequest(input: DispatchTaskInput): DispatchRequest {
  return { repo: input.repo, workClass: input.workClass, runtime: input.runtime, profile: input.profile, actions: input.actions, taskId: input.taskId, settings: input.settings, ...(input.approvalId ? { approvalId: input.approvalId } : {}), ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}), ...(input.prBase ? { prBase: input.prBase } : {}), ...(input.targetProject ? { targetProject: input.targetProject } : {}) };
}

/** Trusted adapter handshake publication; no model tool or client accepts these parameters. */
export function interactiveSessionRecord(runId: string, requestId: string, session: { id: string; file?: string }): RunRecord {
  return withLock('dispatch', () => {
    const current = currentAuthoritySettings(runId, 'conversation');
    if (!current.allowed || current.run.interactive?.requestId !== requestId || !/^[a-zA-Z0-9._-]{1,256}$/.test(session.id) || (session.file !== undefined && (typeof session.file !== 'string' || session.file.length > 4096))) throw new Error('Invalid current interactive runtime handshake.');
    const prior = current.run.interactive.runtimeSession;
    if (prior && (prior.id !== session.id || prior.file !== session.file)) throw new Error('Runtime handshake identity cannot be replaced.');
    const record: RunRecord = { ...current.run, sessionId: session.id, interactive: { ...current.run.interactive, runtimeSession: { ...session } } };
    saveRun(record); return record;
  });
}

export interface InteractiveEvidencePin {
  runId: string;
  authority: AuthorityRef;
  runDigest: string;
  evidenceDigest: string;
  candidateHead: string | null;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function evidenceFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string, prefix: string): void => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), relative = `${prefix}${name}`, stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Interactive evidence cannot be a mutable external symlink.');
      if (stat.isDirectory()) visit(file, `${relative}/`);
      else if (stat.isFile()) files[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  visit(directory, ''); return files;
}
/** Read-only owner/model request pin. Includes recorded scope, candidate head and current evidence bytes. */
function evidencePin(runId: string): InteractiveEvidencePin {
  const run = getRun(runId);
  if (!run?.interactive || !run.evidenceDir) throw new Error('Legacy/imported execution cannot be labelled guarded interactive evidence.');
  return { runId, authority: { ...run.authority }, runDigest: digest(run), evidenceDigest: digest(evidenceFiles(run.evidenceDir)), candidateHead: run.candidate?.head ?? null };
}
export function interactiveEvidencePin(runId: string): InteractiveEvidencePin {
  return withLock(`run-${runId}`, () => evidencePin(runId));
}
/** Trusted post-teardown evidence publication uses the same lock as review and final run recording. */
export function interactiveRuntimeResultRecord(runId: string, requestId: string, result: DispatchResult): void {
  withDispatchFence(() => {
    const target = getRun(runId);
    if (target) assertNotArchived({ taskId: target.taskId, runId: target.id, ...target.interactive });
    withLock(`run-${runId}`, () => {
      const run = getRun(runId);
      if (!run?.interactive || run.interactive.requestId !== requestId || !run.evidenceDir || result.outcome.runId !== run.id) throw new Error('Runtime result does not belong to this interactive run.');
      assertNotArchived({ taskId: run.taskId, runId: run.id, ...run.interactive });
      writeJson(join(run.evidenceDir, 'interactive-runtime-result.json'), result);
    });
  });
}
export interface InteractiveReviewInput { decisionId: string; requestId: string; submissionId: string; pin: InteractiveEvidencePin; text: string }
export interface InteractiveReviewRecord extends InteractiveReviewInput { by: string; at: string }
/** Linearizes owner review against revocation/current evidence before product acknowledgement. Never grants or marks delivery. */
export function interactiveReviewRecord(actor: Actor, input: InteractiveReviewInput): InteractiveReviewRecord {
  assertOperator(actor);
  return withLock('dispatch', () => withLock(`run-${input.pin.runId}`, () => {
    const current = currentAuthoritySettings(input.pin.runId, 'conversation', false);
    if (!current.allowed || current.run.interactive?.requestId !== input.submissionId || digest(evidencePin(input.pin.runId)) !== digest(input.pin)) throw new Error('Review authority/evidence/head changed; refresh the current request before deciding.');
    if (!input.decisionId.trim() || input.decisionId.length > 256 || !input.requestId.trim() || input.requestId.length > 256 || input.text.length > 65536) throw new Error('Invalid bounded owner review.');
    const file = join(stateRoot(), 'interactive-reviews', `${digest(input.decisionId)}.json`);
    const prior = readJson<InteractiveReviewRecord>(file);
    if (prior) {
      const { by: _by, at: _at, ...received } = prior;
      if (digest(received) !== digest(input)) throw new Error('Owner review decision identity reused with changed content.');
      return prior;
    }
    const record: InteractiveReviewRecord = { ...input, by: actor.id, at: new Date().toISOString() };
    writeJson(file, record); return record;
  }));
}

export type CurrentAuthoritySettings = (Extract<AuthorityDecision, { allowed: true }> & { run: RunRecord; request: DispatchRequest }) | Extract<AuthorityDecision, { allowed: false }>;
/** Tool boundary reads current authority, including revocation/version changes, not cached grants. */
export function currentAuthoritySettings(runId: string, action?: ActionId, requireRunning = true): CurrentAuthoritySettings {
  const deny = (summary: string): CurrentAuthoritySettings => ({ allowed: false, outcome: { kind: 'refused', runId, summary, nextAction: 'Refresh current authority; ask the authenticated owner if scope must change.' } });
  const run = getRun(runId);
  if (!run?.interactive || (requireRunning && run.status !== 'running') || !run.evidenceDir) return deny('No active guarded interactive run. Legacy runs are read-only/imported.');
  if (archivedTarget({ taskId: run.taskId, runId: run.id, rootTaskId: run.interactive.rootTaskId, conversationId: run.interactive.conversationId, ...(run.interactive.parentRunId ? { parentRunId: run.interactive.parentRunId } : {}) })) return deny('Archived/prepared task family is read-only; tools, delegation and reviews cannot resume it.');
  const input = readJson<DispatchTaskInput>(join(run.evidenceDir, 'dispatch-request.json'));
  if (!input || input.interactive?.requestId !== run.interactive.requestId || (action && !run.actions.includes(action))) return deny('Operation is outside the recorded scope.');
  const request = toRequest(input);
  const current = authorizeDispatch(request, { checkCapacity: false });
  if (!current.allowed) return current;
  if (current.authority.id !== run.authority.id || current.authority.type !== run.authority.type || current.authority.version !== run.authority.version) return deny('Authority changed or was revoked since admission.');
  if (run.interactive.parentRunId) {
    const parent = currentAuthoritySettings(run.interactive.parentRunId, undefined, false);
    if (!parent.allowed) return parent;
  }
  return { ...current, run, request };
}
