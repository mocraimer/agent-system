import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOperator, type Actor, type Approval } from './authority.js';
import type { Reservation } from './admission.js';
import type { Job } from './intake.js';
import type { CallReservation } from './ledger.js';
import type { InteractiveSubmission } from './interactive.js';
import type { Scorecard } from '../eval/scorecard.js';
import { getRun, holdsRunCapacity, type RunRecord } from './run.js';
import { readJson, readRecord, stateRoot, withLock, writeJson } from './store.js';

export interface InteractiveArchiveInput {
  archiveId: string;
  product: { kind: 'project' | 'space' | 'task'; id: string };
  receivers: Array<{ spaceId: string; conversationId: string; taskId: string | null }>;
  /** Existing coordinator tasks and known linked runs, not host paths or model selectors. */
  taskIds: string[];
  runIds: string[];
}
export interface InteractiveArchiveReceipt {
  version: 1;
  archiveId: string;
  fingerprint: string;
  input: InteractiveArchiveInput;
  state: 'prepared' | 'archived';
  preparedAt: string;
  preparedBy: string;
  archivedAt?: string;
  /** Expanded once under admission: descendants, conversations and retained run identities. */
  fence: { taskIds: string[]; conversationIds: string[]; runIds: string[] };
  runPins: Record<string, { record: string; evidence: string }>;
  inventoryDigest: string;
  choices: Array<{ by: string; at: string; action: 'archive' | 'reconcile' | 'retry' }>;
  failure?: 'commit-not-acknowledged' | 'asynchronous-callback';
}
/** Trusted library reads actual product SQL state; no public client/model boolean can attest it. */
export interface InteractiveArchiveObservation {
  archiveId: string;
  fingerprint: string;
  product: InteractiveArchiveInput['product'];
  state: 'archived' | 'uncommitted';
}
export type InteractiveArchiveCommit = (receipt: Readonly<InteractiveArchiveReceipt>) => InteractiveArchiveObservation;
export type InteractiveArchiveObserve = InteractiveArchiveCommit;
const directory = (): string => join(stateRoot(), 'interactive-archives');
const file = (id: string): string => join(directory(), `${hash(id)}.json`);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value)) throw new Error('Archive requires bounded exact receiver/task/run identities, not paths.');
}
function ids(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 256) throw new Error('Archive identity set exceeds its bound.');
  values.forEach(id); return [...new Set(values as string[])].sort();
}
function keys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !expected.includes(key))) throw new Error('Archive accepts only exact bounded identities; no content, selectors or host paths.');
}
function normalize(input: InteractiveArchiveInput): InteractiveArchiveInput {
  keys(input, ['archiveId', 'product', 'receivers', 'taskIds', 'runIds']); keys(input.product, ['kind', 'id']);
  id(input.archiveId); id(input.product?.id);
  if (!['project', 'space', 'task'].includes(input.product.kind) || !Array.isArray(input.receivers) || !input.receivers.length || input.receivers.length > 256) throw new Error('Archive requires its exact product destination/receivers.');
  const receivers = input.receivers.map(receiver => {
    keys(receiver, ['spaceId', 'conversationId', 'taskId']);
    id(receiver.spaceId); id(receiver.conversationId); if (receiver.taskId !== null) id(receiver.taskId);
    return { spaceId: receiver.spaceId, conversationId: receiver.conversationId, taskId: receiver.taskId };
  }).sort((a, b) => a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0);
  if (new Set(receivers.map(receiver => receiver.conversationId)).size !== receivers.length) throw new Error('Archive receiver identities must be unique.');
  const taskIds = ids(input.taskIds), runIds = ids(input.runIds);
  return { archiveId: input.archiveId, product: { kind: input.product.kind, id: input.product.id }, receivers, taskIds, runIds };
}
function names(path: string): string[] {
  try { return readdirSync(path).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Archive cannot infer safety from a listing that skipped corrupt/unusable records. */
function records<T>(collection: string, kind: Parameters<typeof readRecord>[0]): T[] {
  return names(join(stateRoot(), collection)).map(name => readRecord<T>(kind, join(stateRoot(), collection, name))!);
}
function receipts(): InteractiveArchiveReceipt[] {
  return names(directory()).map(name => {
    const receipt = readJson<InteractiveArchiveReceipt>(join(directory(), name))!;
    if (receipt.version !== 1 || !['prepared', 'archived'].includes(receipt.state) || receipt.fingerprint !== hash(normalize(receipt.input)) || receipt.archiveId !== receipt.input.archiveId || !receipt.fence || !receipt.runPins || !receipt.inventoryDigest) throw new Error('Archive fence is unreadable; admission cannot be proved safe.');
    ids(receipt.fence.taskIds); ids(receipt.fence.conversationIds); ids(receipt.fence.runIds);
    return receipt;
  });
}
export interface ArchiveTarget { taskId: string; conversationId?: string; rootTaskId?: string; parentRunId?: string; runId?: string }
/** Irreversible lifecycle cutoff, not another permission store. Every fresh writer checks it. */
export function archivedTarget(target: ArchiveTarget): InteractiveArchiveReceipt | undefined {
  const parents: RunRecord[] = []; let parentId = target.parentRunId;
  const visited = new Set<string>();
  while (parentId) {
    if (visited.has(parentId)) throw new Error('Archive ancestry cannot be proved: parent cycle.');
    id(parentId); visited.add(parentId); const parent = getRun(parentId);
    if (!parent) throw new Error('Archive ancestry cannot be proved: linked parent is missing.');
    parents.push(parent); parentId = parent.interactive?.parentRunId;
  }
  const targets = [target, ...parents.map(run => ({ taskId: run.taskId, runId: run.id, conversationId: run.interactive?.conversationId, rootTaskId: run.interactive?.rootTaskId }))];
  return receipts().find(receipt => targets.some(item => receipt.fence.taskIds.includes(item.taskId) || (item.rootTaskId && receipt.fence.taskIds.includes(item.rootTaskId)) || (item.runId && receipt.fence.runIds.includes(item.runId)) || (item.conversationId && receipt.fence.conversationIds.includes(item.conversationId))));
}
export function assertNotArchived(target: ArchiveTarget): void {
  if (archivedTarget(target)) throw new Error('Task/conversation family has a prepared or committed archive cutoff; history remains read-only.');
}
function evidenceDigest(run: RunRecord): string {
  if (!run.evidenceDir) throw new Error('Linked execution lacks retained evidence; archive requires proved terminal history.');
  const entries: Record<string, string> = {};
  const visit = (path: string, prefix: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), stat = lstatSync(child), relative = `${prefix}${name}`;
      if (stat.isSymbolicLink()) throw new Error('Archive evidence cannot follow external mutable symlinks.');
      if (stat.isDirectory()) visit(child, `${relative}/`);
      else if (stat.isFile()) entries[relative] = createHash('sha256').update(readFileSync(child)).digest('hex');
      else throw new Error('Archive evidence is not a retained regular file.');
    }
  };
  visit(run.evidenceDir, ''); return hash(entries);
}
function snapshot(input: InteractiveArchiveInput) {
  const allRuns = records<RunRecord>('runs', 'run');
  const submissions = names(join(stateRoot(), 'interactive-submissions')).map(name => readJson<InteractiveSubmission>(join(stateRoot(), 'interactive-submissions', name))!);
  for (const submission of submissions) {
    if (!submission || !['submitting', 'settled', 'uncertain'].includes(submission.state) || typeof submission.taskId !== 'string') throw new Error('Submission history is unusable; archive cannot prove queued work.');
    for (const identity of [submission.conversationId, submission.parentRunId, submission.rootTaskId]) if (identity !== undefined) id(identity);
  }
  // Old receipts can lack ancestry. Only exact task/conversation or known parent/root
  // links establish their scope; an unrelated old receipt cannot quarantine all roots.
  const submissionIdentity = (submission: InteractiveSubmission) => {
    const run = allRuns.find(item => item.interactive?.requestId === submission.requestId);
    const parentRunId = submission.parentRunId ?? run?.interactive?.parentRunId;
    return { conversationId: submission.conversationId ?? run?.interactive?.conversationId,
      rootTaskId: submission.rootTaskId ?? run?.interactive?.rootTaskId,
      parent: parentRunId ? allRuns.find(item => item.id === parentRunId) : undefined };
  };
  for (const runId of input.runIds) if (!allRuns.some(run => run.id === runId)) throw new Error('Known linked execution is missing; recover before archiving.');
  const tasks = new Set(input.taskIds), conversations = new Set(input.receivers.map(receiver => receiver.conversationId));
  input.receivers.forEach(receiver => { if (receiver.taskId) tasks.add(receiver.taskId); });
  input.runIds.forEach(runId => tasks.add(allRuns.find(run => run.id === runId)!.taskId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of allRuns) {
      const parent = run.interactive?.parentRunId ? allRuns.find(item => item.id === run.interactive!.parentRunId) : undefined;
      if (tasks.has(run.taskId) || input.runIds.includes(run.id) || (run.interactive && (conversations.has(run.interactive.conversationId) || tasks.has(run.interactive.rootTaskId) || (parent && tasks.has(parent.taskId))))) {
        if (!tasks.has(run.taskId)) { tasks.add(run.taskId); changed = true; }
        if (run.interactive && !conversations.has(run.interactive.conversationId)) { conversations.add(run.interactive.conversationId); changed = true; }
      }
    }
    for (const submission of submissions) {
      const { conversationId, rootTaskId, parent } = submissionIdentity(submission);
      if (tasks.has(submission.taskId) || (conversationId && conversations.has(conversationId)) || (rootTaskId && tasks.has(rootTaskId)) || (parent && tasks.has(parent.taskId))) {
        if (!tasks.has(submission.taskId)) { tasks.add(submission.taskId); changed = true; }
        if (conversationId && !conversations.has(conversationId)) { conversations.add(conversationId); changed = true; }
      }
    }
  }
  const runs = allRuns.filter(run => tasks.has(run.taskId));
  if ([...conversations].some(conversationId => !input.receivers.some(receiver => receiver.conversationId === conversationId))) throw new Error('Expanded family needs exact product receiver identities for every linked conversation.');
  if (runs.length > 256 || tasks.size > 256 || conversations.size > 256) throw new Error('Expanded archive family exceeds its bounded inventory.');
  for (const run of runs) {
    if (run.interactive?.parentRunId && !allRuns.some(parent => parent.id === run.interactive!.parentRunId)) throw new Error('Linked parent history is missing; archive cannot prove the family.');
    const noPrompt = run.promptNotSent === true && run.runtimeDispatched === false;
    if (run.dispatchOwner || holdsRunCapacity(run) || !run.endedAt || (!noPrompt && !['completed', 'checks-failed', 'refused', 'unsupported-settings', 'attempts-exhausted'].includes(run.status))) throw new Error('Archive refuses active, queued, unknown or uncertain execution; it never cancels work.');
  }
  const runIds = runs.map(run => run.id).sort(), targeted = (item: { taskId: string; runId?: string }) => tasks.has(item.taskId) || (!!item.runId && runIds.includes(item.runId));
  const reservations = records<Reservation>('reservations', 'reservation').filter(targeted);
  if (reservations.some(item => item.state !== 'released')) throw new Error('Archive refuses held/outstanding subscription reservations.');
  const calls = records<CallReservation>('paid-calls', 'paid-call').filter(targeted);
  if (calls.some(item => item.state === 'reserved')) throw new Error('Archive refuses outstanding paid calls.');
  const jobs = records<Job>('jobs', 'job').filter(job => tasks.has(job.taskId) || job.runIds.some(runId => runIds.includes(runId)));
  if (jobs.some(job => job.state === 'open' || (job.state === 'settled' && job.outstandingObligations.length > 0) || job.runIds.some(runId => !allRuns.some(run => run.id === runId)))) throw new Error('Archive refuses open jobs/obligations or missing linked execution.');
  const cards = records<Scorecard>('scorecards', 'scorecard').filter(card => tasks.has(card.taskId) || card.runIds.some(runId => runIds.includes(runId)));
  if (cards.some(card => !['completed', 'checks-failed', 'refused', 'unsupported-settings', 'attempts-exhausted'].includes(card.finalStatus) || card.runIds.some(runId => !allRuns.some(run => run.id === runId)))) throw new Error('Archive refuses open/unknown execution segments.');
  const approvals = records<Approval>('approvals', 'approval').filter(approval => runs.some(run => run.authority.type === 'approval' && run.authority.id === approval.id) || cards.some(card => card.authority.type === 'approval' && card.authority.id === approval.id));
  if (approvals.some(approval => !approval.revokedAt)) throw new Error('Archive refuses a linked approval still capable of dispatch; revoke it explicitly first.');
  for (const submission of submissions) {
    const run = allRuns.find(item => item.interactive?.requestId === submission.requestId);
    const { conversationId } = submissionIdentity(submission);
    const matched = tasks.has(submission.taskId) || (conversationId && conversations.has(conversationId));
    if (submission.state !== 'settled' && matched) throw new Error('Archive refuses submitting/unknown interactive work; reconcile its durable identity first.');
    if (matched && (!submission.result || !['completed', 'checks-failed', 'refused', 'unsupported-settings', 'attempts-exhausted'].includes(submission.result.outcome.kind) || (submission.result.run && !allRuns.some(item => item.id === submission.result!.run!.id)) || (submission.result.outcome.kind === 'completed' && !run))) throw new Error('Archive refuses unresolved/missing linked conversation segments.');
  }
  const linkedSubmissions = submissions.filter(item => tasks.has(item.taskId) || (item.conversationId && conversations.has(item.conversationId)));
  const runPins = Object.fromEntries(runs.map(run => [run.id, { record: hash(run), evidence: evidenceDigest(run) }]));
  return { fence: { taskIds: [...tasks].sort(), conversationIds: [...conversations].sort(), runIds }, runPins,
    inventoryDigest: hash({ runPins, reservations, calls, jobs, cards, approvals, submissions: linkedSubmissions }) };
}
function runLocks<T>(runIds: readonly string[], operation: () => T, index = 0): T {
  return index === runIds.length ? operation() : withLock(`run-${runIds[index]}`, () => runLocks(runIds, operation, index + 1));
}
function persist(receipt: InteractiveArchiveReceipt): void {
  const path = file(receipt.archiveId); writeJson(path, receipt);
  // Prepared cutoff reaches durable storage before any external SQL callback can commit.
  for (const target of [path, dirname(path), stateRoot()]) {
    const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
function read(idValue: string): InteractiveArchiveReceipt | undefined { id(idValue); return receipts().find(receipt => receipt.archiveId === idValue); }
function unchanged(receipt: InteractiveArchiveReceipt): void {
  const current = snapshot(receipt.input);
  if (hash(current) !== hash({ fence: receipt.fence, runPins: receipt.runPins, inventoryDigest: receipt.inventoryDigest })) throw new Error('Archive work/evidence inventory changed; unknown prepared cutoff stays quarantined.');
}
function observe(callback: InteractiveArchiveObserve, receipt: InteractiveArchiveReceipt): InteractiveArchiveObservation {
  if (callback.constructor.name === 'AsyncFunction') throw new Error('Archive callback must be synchronous; no promise can escape the admission fence.');
  const result: unknown = callback(structuredClone(receipt));
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
    void Promise.resolve(result).catch(() => undefined);
    receipt.failure = 'asynchronous-callback'; persist(receipt);
    throw new Error('Archive callback returned a promise; prepared cutoff remains quarantined.');
  }
  const observation = result as InteractiveArchiveObservation;
  if (!observation || observation.archiveId !== receipt.archiveId || observation.fingerprint !== receipt.fingerprint || hash(observation.product) !== hash(receipt.input.product) || !['archived', 'uncommitted'].includes(observation.state)) throw new Error('Archive requires a matching observable product SQL receipt, not a client boolean.');
  return observation;
}
function complete(receipt: InteractiveArchiveReceipt, commit: InteractiveArchiveCommit): InteractiveArchiveReceipt {
  try {
    if (observe(commit, receipt).state !== 'archived') throw new Error('Product archive commit is not observable.');
    unchanged(receipt);
    const done: InteractiveArchiveReceipt = { ...receipt, state: 'archived', archivedAt: new Date().toISOString() }; delete done.failure;
    persist(done); return structuredClone(done);
  } catch (error) {
    receipt.failure ??= 'commit-not-acknowledged'; persist(receipt); throw error;
  }
}
/** Owner-only irreversible archive; no inference, stop, authority grant or evidence rewrite. */
export function interactiveArchive(actor: Actor, raw: InteractiveArchiveInput, commit: InteractiveArchiveCommit): InteractiveArchiveReceipt {
  assertOperator(actor); const input = normalize(raw);
  if (commit.constructor.name === 'AsyncFunction') throw new Error('Archive callback must be synchronous.');
  return withLock('dispatch', () => {
    const prior = read(input.archiveId);
    if (prior) {
      if (prior.fingerprint !== hash(input)) throw new Error('Archive identity reused with changed destinations/history.');
      if (prior.state === 'prepared') throw new Error('Prepared archive has unknown commit state; use owner reconciliation with observable SQL state.');
      return runLocks(prior.fence.runIds, () => { unchanged(prior); return structuredClone(prior); });
    }
    const inventory = snapshot(input);
    return runLocks(inventory.fence.runIds, () => {
      const pinned = snapshot(input);
      if (hash(inventory) !== hash(pinned)) throw new Error('Archive inventory changed while acquiring execution locks.');
      for (const prior of receipts()) {
        const overlaps = prior.fence.taskIds.some(taskId => pinned.fence.taskIds.includes(taskId)) || prior.fence.conversationIds.some(conversationId => pinned.fence.conversationIds.includes(conversationId));
        if (hash(prior.input.product) === hash(input.product) || (overlaps && prior.state === 'prepared')) throw new Error('Destination already has an archive cutoff or overlapping prepared quarantine; use its stable receipt.');
      }
      const at = new Date().toISOString();
      const receipt: InteractiveArchiveReceipt = { version: 1, archiveId: input.archiveId, fingerprint: hash(input), input, state: 'prepared', preparedAt: at, preparedBy: actor.id, ...pinned, choices: [{ by: actor.id, at, action: 'archive' }] };
      persist(receipt); return complete(receipt, commit);
    });
  });
}
export function interactiveArchiveLookup(actor: Actor, archiveId: string): InteractiveArchiveReceipt | undefined {
  assertOperator(actor); const receipt = read(archiveId); return receipt ? structuredClone(receipt) : undefined;
}
/** Lost acknowledgement uses a fresh trusted SQL read, never another tombstone or implicit resume. */
export function interactiveArchiveReconcile(actor: Actor, archiveId: string, inspect: InteractiveArchiveObserve, retryCommit?: InteractiveArchiveCommit): InteractiveArchiveReceipt {
  assertOperator(actor);
  return withLock('dispatch', () => {
    const receipt = read(archiveId); if (!receipt) throw new Error('Unknown archive identity.');
    return runLocks(receipt.fence.runIds, () => {
      unchanged(receipt);
      if (receipt.state === 'archived') return structuredClone(receipt);
      const observation = observe(inspect, receipt);
      const action = observation.state === 'archived' ? 'reconcile' : 'retry';
      if (action === 'retry' && (!retryCommit || receipt.failure === 'asynchronous-callback')) throw new Error('Uncommitted/unsupported archive needs an explicit same-key synchronous retry; cutoff stays quarantined.');
      receipt.choices.push({ by: actor.id, at: new Date().toISOString(), action }); persist(receipt);
      return complete(receipt, action === 'reconcile' ? () => observation : retryCommit!);
    });
  });
}
