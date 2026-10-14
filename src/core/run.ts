import { join } from 'node:path';
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
  /** Proven before the task prompt was sent. Absent means unknown, not false. */
  promptNotSent?: true;
  loop?: LoopRecord;
  outputPath?: string;
  promptDigest?: string;
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

/** Runs still in flight. Used for concurrency limits and for restart reconciliation. */
export function activeRuns(): RunRecord[] {
  return listRuns().filter((r) => r.status === 'running' || r.status === 'remote-uncertain');
}

export function runsForTask(taskId: string): RunRecord[] {
  return listRuns().filter((r) => r.taskId === taskId);
}

/**
 * Attempts a task has actually spent.
 *
 * An admission refusal never reaches a runtime, so it is durable history but not
 * an attempt: it neither consumes the retry budget nor advances the number a run
 * is labelled with. Both callers ask this one question, so the budget an operator
 * has left and the attempt they are shown cannot drift apart.
 */
export function spentAttempts(taskId: string): RunRecord[] {
  return runsForTask(taskId).filter((r) => r.status !== 'quota-waiting');
}

/**
 * Dispatches an authority has already spent inside its rolling window.
 *
 * An admission refusal is left out for the reason `spentAttempts` leaves it out:
 * it never reached a runtime. Counting it let a grant spend its whole window on
 * work that was only ever waiting for allowance, and then refuse the work once
 * the allowance came back.
 */
export function dispatchesUnderAuthority(authorityId: string, windowHours: number): RunRecord[] {
  const cutoff = Date.now() - windowHours * 3_600_000;
  return listRuns().filter(
    (r) => r.authority.id === authorityId && Date.parse(r.startedAt) >= cutoff && r.status !== 'quota-waiting',
  );
}
