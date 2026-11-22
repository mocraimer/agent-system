import { join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { BuildIdentity } from './build.js';
import type { LoopRecord } from '../eval/scorecard.js';
import type { ActionId, AuthorityRef, PerTaskLimits, RuntimeId } from './authority.js';
import type { OutcomeKind } from './outcome.js';
import { listRecords, newId, readRecord, stateRoot, writeJson } from './store.js';

/**
 * What the operator asked for versus what the runtime actually did.
 *
 * `observed` is deliberately allowed to be the literal string `unknown`: where a
 * vendor does not expose the effective model or effort, recording the requested
 * value in its place would manufacture evidence for a configuration nobody
 * confirmed (INV-G7).
 */
export interface SettingsSnapshot {
  requested: { model: string | 'vendor-default'; effort: string | 'vendor-default' };
  /** After repository/role defaults and run overrides are applied. */
  resolved: { model: string | 'vendor-default'; effort: string | 'vendor-default' };
  /** What the runtime reported back, or `unknown` when it exposes nothing. */
  observed: { model: string | 'unknown'; effort: string | 'unknown' };
  /** Set when the vendor substituted something other than what was resolved. */
  substitution?: string;
  /**
   * The prompt template the run was given and its digest, when the caller used
   * a versioned one. Recorded so verdicts group by the prompt that produced them.
   */
  prompt?: { template: string; digest: string };
}

/** Proof that the run entered the real manifest-dev skill, not a lookalike. */
export interface SkillEvidence {
  /** Resolved on-disk path of the distribution that actually loaded. */
  distributionPath: string;
  /** Version read from that distribution's plugin.json. */
  distributionVersion: string;
  /** The literal invocation sent to the runtime. */
  invocation: string;
  /** Manifest the run generated, once it reports one. */
  manifestPath?: string;
  /** Whether the run reported completion, or is still continuing. */
  continuation: 'running' | 'completed' | 'interrupted' | 'unknown';
}

/** Identity of the thing the evidence is about (INV-G9). */
export interface CandidateIdentity {
  repo: string;
  base: string;
  head: string;
  /** Built client/plugin artifact digests, when the run produced any. */
  artifacts?: Record<string, string>;
  /** Deployed backend revisions the run exercised, when it deployed. */
  backendRevisions?: Record<string, string>;
}

export interface RunRecord {
  id: string;
  taskId: string;
  attempt: number;
  authority: AuthorityRef;
  limits: PerTaskLimits;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  settings: SettingsSnapshot;
  /** Vendor-side identifier, kept so a lost connection can be reconciled. */
  sessionId?: string;
  skill?: SkillEvidence;
  candidate?: CandidateIdentity;
  admissionId?: string;
  startedAt: string;
  endedAt?: string;
  status: OutcomeKind | 'running';
  summary?: string;
  /** Where the run's artifacts were kept, outside any disposable vendor home. */
  evidenceDir?: string;
  /** Absent on legacy records means unknown, not the currently selected build. */
  build?: Readonly<BuildIdentity> | null;
  repo?: string;
  workClass?: string;
  runtimeDispatched?: boolean;
  /** Fences recovery while a dispatcher can still publish or start this attempt. */
  dispatchOwner?: { host: string; pid: number };
  /** Proven before the task prompt was sent. Absent means unknown, not false. */
  promptNotSent?: true;
  loop?: LoopRecord;
  outputPath?: string;
  promptDigest?: string;
  /** Absent on legacy jobs: those jobs are not guarded interactive executions. */
  interactive?: { requestId: string; conversationId: string; parentRunId?: string; rootTaskId: string; runtimeSession?: { id: string; file?: string } };
  /** Manual Pi-only stop attestation; never evidence that the task completed. */
  stopAttestation?: {
    kind: 'pi-process-stopped';
    by: string;
    at: string;
    reason: string;
    evidence: string;
    priorStatus: 'running' | 'remote-uncertain' | 'setup-blocked';
    processId?: number;
  };
  delivery?: {
    status: 'unverified' | 'delivered';
    reason: string;
    evidence: string[];
    verifiedAt?: string;
    /** Absent on automatic delivery records. */
    source?: 'operator-attested';
    by?: string;
  };
  timing?: { setupStartedAt?: string; dispatchStartedAt?: string; providerEndedAt?: string; adoptionEndedAt?: string };
}

/** Freeze the recorded facts, not whatever activation or retry exists on reopening. */
export function attemptEvidencePins(run: RunRecord): Record<string, string> {
  const pins: Record<string, string> = { recordedAttempt: JSON.stringify(run) };
  if (run.outputPath) {
    pins['attemptOutputPath'] = run.outputPath;
    if (existsSync(run.outputPath)) pins['attemptOutputDigest'] = createHash('sha256').update(readFileSync(run.outputPath)).digest('hex');
  }
  return pins;
}

const runsDir = (): string => join(stateRoot(), 'runs');

export function listRuns(): RunRecord[] {
  return listRecords<RunRecord>('run', runsDir());
}
export function getRun(id: string): RunRecord | undefined {
  return readRecord<RunRecord>('run', join(runsDir(), `${id}.json`));
}
export function saveRun(run: RunRecord): void {
  writeJson(join(runsDir(), `${run.id}.json`), run);
}
export function newRunId(): string {
  return newId('run');
}

/** A published claim cannot be reclaimed while its dispatcher may still use it. */
export function dispatchOwnerPresent(run: RunRecord): boolean {
  const owner = run.dispatchOwner;
  if (!owner) return false;
  // A shared store on another host cannot prove that process stopped.
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Includes uncertain effects, not just a worker still being watched. */
export function holdsRunCapacity(run: RunRecord): boolean {
  return run.status === 'running' || run.status === 'remote-uncertain'
    || (run.runtimeDispatched === true && ![
      'completed', 'checks-failed', 'refused', 'unsupported-settings', 'attempts-exhausted',
    ].includes(run.status));
}

/** Runs still in flight. Used for concurrency limits and for restart reconciliation. */
export function activeRuns(): RunRecord[] {
  return listRuns().filter(holdsRunCapacity);
}

export function runsForTask(taskId: string): RunRecord[] {
  return listRuns().filter((r) => r.taskId === taskId);
}

/**
 * Attempts a task has actually spent.
 *
 * A never-dispatched admission refusal is history but not an attempt. If an
 * adapter itself returned quota-waiting after dispatch, it did spend an attempt.
 * A pre-dispatch refusal neither consumes the retry budget nor advances the number a run
 * is labelled with. Both callers ask this one question, so the budget an operator
 * has left and the attempt they are shown cannot drift apart.
 */
export function spentAttempts(taskId: string): RunRecord[] {
  return runsForTask(taskId).filter((r) => !(r.interactive && r.promptNotSent === true && r.runtimeDispatched === false) && (r.status !== 'quota-waiting' || r.runtimeDispatched === true));
}

/**
 * Dispatches an authority has already spent inside its rolling window.
 *
 * Never-dispatched admission refusals are left out for the same reason as in
 * `spentAttempts`. Counting them let a grant spend its whole window on
 * work that was only ever waiting for allowance, and then refuse the work once
 * the allowance came back.
 */
export function dispatchesUnderAuthority(authorityId: string, windowHours: number): RunRecord[] {
  const cutoff = Date.now() - windowHours * 3_600_000;
  return listRuns().filter(
    (r) => r.authority.id === authorityId && Date.parse(r.startedAt) >= cutoff && !(r.interactive && r.promptNotSent === true && r.runtimeDispatched === false) && (r.status !== 'quota-waiting' || r.runtimeDispatched === true),
  );
}
