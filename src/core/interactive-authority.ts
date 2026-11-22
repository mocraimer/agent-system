import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertDispatchInput, toAuthorityRequest, type DispatchTaskInput } from '../commands.js';
import { assertOperator, type Actor, type AuthorityDecision, type AuthorityRef } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { currentAuthoritySettings, interactiveLookup, isReceivedInteractiveSubmission } from './interactive.js';
import { readJson, stateRoot, withDispatchFence, writeJson } from './store.js';
import { archivedTarget } from './interactive-archive.js';

class AuthorityConfirmationError extends Error { override readonly name = 'AuthorityConfirmationError'; }

export interface AuthorityConfirmationInput {
  original: DispatchTaskInput;
  decisionId: string;
  requestId: string;
  requestVersion: number;
  handoffDigest: string;
  expectedAuthority: AuthorityRef;
  /** Explicit owner selection, separate from the immutable received dispatch envelope. */
  binding?: { approvalId: string };
  parentAuthority?: AuthorityRef;
}
export interface AuthorityConfirmationReceipt extends AuthorityConfirmationInput {
  by: string;
  at: string;
  submissionFingerprint: string;
  coverage: 'scope-only';
  limits: Extract<AuthorityDecision, { allowed: true }>['limits'];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a: unknown, b: unknown): boolean => digest(a) === digest(b);

/** Current scope coverage only: no provider reads, claims, capacity proof or runtime calls. */
export function authorityPreviewForOperator(actor: Actor, input: DispatchTaskInput): AuthorityDecision {
  return withDispatchFence(() => {
    assertOperator(actor); assertDispatchInput(input);
    return authorizeDispatch(toAuthorityRequest(input), { checkCapacity: false });
  });
}

/** Host-only transaction callback keeps lock order dispatch fence -> product transaction -> receipt. */
export function authorityConfirmationRecord<T>(actor: Actor, input: AuthorityConfirmationInput, recordWith: (persist: () => AuthorityConfirmationReceipt) => T): T {
  return withDispatchFence(() => {
    assertOperator(actor); assertDispatchInput(input.original);
    for (const value of [input.decisionId, input.requestId, input.expectedAuthority.id]) if (!value?.trim() || value.length > 256) throw new AuthorityConfirmationError('Invalid bounded owner confirmation identity.');
    if (!Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1 || !Number.isSafeInteger(input.expectedAuthority.version) || input.expectedAuthority.version < 1 || !/^[a-f0-9]{64}$/.test(input.handoffDigest)) throw new AuthorityConfirmationError('Invalid pinned owner confirmation.');
    const received = input.original.interactive && interactiveLookup(input.original.interactive.requestId);
    if (!received || !isReceivedInteractiveSubmission(input.original) || received.run || received.state !== 'settled' || received.result?.outcome.kind !== 'awaiting-approval' || received.result.runtimeDispatched) throw new AuthorityConfirmationError('Original received request is not a pinned awaiting-approval refusal.');
    if (archivedTarget({ taskId: input.original.taskId, conversationId: input.original.interactive!.conversationId, ...(received.rootTaskId ? { rootTaskId: received.rootTaskId } : {}), ...(received.parentRunId ? { parentRunId: received.parentRunId } : {}) })) throw new AuthorityConfirmationError('Prepared or archived task family is read-only.');
    if (input.binding && (input.expectedAuthority.type !== 'approval' || input.binding.approvalId !== input.expectedAuthority.id || (input.original.approvalId !== undefined && input.original.approvalId !== input.binding.approvalId))) throw new AuthorityConfirmationError('Existing approval selection changed the original authority binding.');
    const selected = { ...toAuthorityRequest(input.original), ...(input.binding ? { approvalId: input.binding.approvalId } : {}) };
    const decision = authorizeDispatch(selected, { checkCapacity: false });
    if (!decision.allowed || !same(decision.authority, input.expectedAuthority)) throw new AuthorityConfirmationError('Selected existing authority was revoked, changed or does not cover this scope.');
    if (input.original.interactive?.parentRunId) {
      const parent = currentAuthoritySettings(input.original.interactive.parentRunId, 'delegate-task', false);
      if (!parent.allowed || !input.parentAuthority || !same(parent.authority, input.parentAuthority) || !same(parent.authority, decision.authority) || parent.run.repo !== selected.repo || parent.run.workClass !== selected.workClass || parent.run.profile !== selected.profile || selected.actions.some(action => !parent.run.actions.includes(action))) throw new AuthorityConfirmationError('Delegation parent current authority or inherited resource envelope changed.');
    } else if (input.parentAuthority) throw new AuthorityConfirmationError('Unexpected delegation parent authority.');
    const file = join(stateRoot(), 'interactive-authority-confirmations', `${digest(input.decisionId)}.json`);
    const prior = readJson<AuthorityConfirmationReceipt>(file);
    if (prior) {
      const { by, at: _at, submissionFingerprint: _fingerprint, coverage: _coverage, limits: _limits, ...original } = prior;
      if (by !== actor.id || !same(original, input)) throw new AuthorityConfirmationError('Owner confirmation identity reused with changed content.');
    }
    const receipt: AuthorityConfirmationReceipt = prior ?? { ...structuredClone(input), by: actor.id, at: new Date().toISOString(), submissionFingerprint: received.fingerprint, coverage: 'scope-only', limits: { ...decision.limits } };
    let persisted = false, accepting = true;
    try {
      const result = recordWith(() => { if (!accepting) throw new AuthorityConfirmationError('Owner receipt must persist synchronously inside the dispatch fence.'); if (!prior && !persisted) writeJson(file, receipt); persisted = true; return structuredClone(receipt); });
      if (result && typeof result === 'object' && 'then' in result) throw new AuthorityConfirmationError('Owner confirmation transaction must be synchronous.');
      if (!persisted) throw new AuthorityConfirmationError('Owner confirmation transaction did not retain its coordinator receipt.');
      return result;
    } finally { accepting = false; }
  });
}
