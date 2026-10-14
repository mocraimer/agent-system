import { join } from 'node:path';
import type { RuntimeId } from './authority.js';
import type { Outcome } from './outcome.js';
import type { RunRecord } from './run.js';
import { getRun, listRuns, saveRun } from './run.js';
import { listRecords, newId, readJson, readRecord, stateRoot, withLock, writeJson } from './store.js';

/**
 * A unit of work as the operator or an event source sees it.
 *
 * Separate from a run: one job may take several runs (an initial attempt plus
 * repairs), and the job is what must survive a duplicate delivery or a restart
 * without turning into two.
 */
export interface Job {
  id: string;
  taskId: string;
  /**
   * Whatever makes two submissions "the same work" — a CI event id, an issue
   * number, an operator-supplied key. Two submissions sharing one never produce
   * two jobs.
   */
  idempotencyKey: string;
  repo: string;
  workClass: string;
  runtime: RuntimeId;
  /** Checks this job still owes, carried across attempts. */
  outstandingObligations: string[];
  /** Evidence directories produced so far. Never dropped on a retry. */
  artifacts: string[];
  runIds: string[];
  state: 'open' | 'settled' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  /** Set when a submission was recognised as a duplicate of this job. */
  duplicateSubmissions?: number;
  /**
   * The exact head the signal was raised against, and the base a repair must
   * target.
   *
   * Carried on the job because the event itself is not kept: without them a
   * restart knows a job exists but not what it was about, and a later dispatch
   * could bind to whatever the branch has become rather than the commit that
   * actually failed.
   */
  headSha?: string;
  prBase?: string;
  /** Why the job is not settled, when it is not. */
  note?: string;
}

const jobsDir = (): string => join(stateRoot(), 'jobs');
const keyIndex = (key: string): string => join(stateRoot(), 'job-keys', `${encodeURIComponent(key)}.json`);

export function listJobs(): Job[] {
  return listRecords<Job>('job', jobsDir());
}
export function getJob(id: string): Job | undefined {
  return readRecord<Job>('job', join(jobsDir(), `${id}.json`));
}
export function saveJob(job: Job): void {
  writeJson(join(jobsDir(), `${job.id}.json`), job);
}

export interface SubmitInput {
  idempotencyKey: string;
  taskId: string;
  repo: string;
  workClass: string;
  runtime: RuntimeId;
  obligations: string[];
  /** The exact head the signal was raised against, when the caller knows it. */
  headSha?: string;
  /** The base a repair's pull request must target, when the repo constrains one. */
  prBase?: string;
}

export interface SubmitResult {
  job: Job;
  /** True when this submission created the job rather than matching an existing one. */
  created: boolean;
}

/**
 * Accept a submission, or recognise it as one already accepted.
 *
 * Read-check-write under one lock, with the key index written inside it: a
 * duplicate delivery arriving while the first is still being recorded is exactly
 * the case that produces two jobs — and, downstream, two PRs for one CI failure.
 */
export function submitJob(input: SubmitInput): SubmitResult {
  return withLock(`intake-${input.idempotencyKey}`, () => {
    const indexPath = keyIndex(input.idempotencyKey);
    const existingId = readJson<{ jobId: string }>(indexPath)?.jobId;
    if (existingId) {
      // Serialize with attachRun, which locks on the job rather than the
      // idempotency key. Without this the duplicate's read-modify-write can land
      // on top of a run another process just attached, erasing its run id and
      // artifact links — and a redelivery would then see no attempt to refuse.
      // The lock order is always intake then job, so nothing here can deadlock
      // against attachRun, which takes only the job lock.
      const existing = withLock(`job-${existingId}`, () => getJob(existingId));
      if (existing) {
        const updated: Job = {
          ...existing,
          duplicateSubmissions: (existing.duplicateSubmissions ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        withLock(`job-${existingId}`, () => {
          // Re-read inside the lock: the job may have gained runs or artifacts
          // between the read above and here, and those belong to whoever wrote
          // them, not to this delivery's snapshot.
          const current = getJob(existingId) ?? existing;
          saveJob({
            ...current,
            duplicateSubmissions: (current.duplicateSubmissions ?? 0) + 1,
            updatedAt: updated.updatedAt,
          });
        });
        return { job: getJob(existingId) ?? updated, created: false };
      }
      // Index points at a job that is not on disk. Treat the index as stale rather
      // than silently creating a second job under the same key.
    }
    const now = new Date().toISOString();
    const job: Job = {
      id: newId('job'),
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      repo: input.repo,
      workClass: input.workClass,
      runtime: input.runtime,
      outstandingObligations: [...input.obligations],
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      ...(input.prBase !== undefined ? { prBase: input.prBase } : {}),
      artifacts: [],
      runIds: [],
      state: 'open',
      createdAt: now,
      updatedAt: now,
    };
    saveJob(job);
    writeJson(indexPath, { jobId: job.id, key: input.idempotencyKey });
    return { job, created: true };
  });
}

/**
 * Fill in a candidate the job does not yet record.
 *
 * Separate from `submitJob` on purpose. Backfilling during submission wrote the
 * values before anything had checked them, so a delivery that was about to be
 * rejected could still leave its base on the job — and a later, correct delivery
 * would then be refused against the rejected one's value. Only a delivery that
 * has passed the identity checks gets to bind what was missing.
 *
 * Gaps only. A recorded identity is never overwritten, because a delivery
 * disagreeing about the candidate is what those checks exist to catch.
 */
export function bindJobCandidate(
  jobId: string,
  candidate: { headSha?: string; prBase?: string },
): Job {
  return withLock(`job-${jobId}`, () => {
    const job = getJob(jobId);
    if (!job) throw new Error(`No job "${jobId}".`);
    if ((job.headSha !== undefined || candidate.headSha === undefined)
      && (job.prBase !== undefined || candidate.prBase === undefined)) return job;
    const next: Job = {
      ...job,
      ...(job.headSha === undefined && candidate.headSha !== undefined ? { headSha: candidate.headSha } : {}),
      ...(job.prBase === undefined && candidate.prBase !== undefined ? { prBase: candidate.prBase } : {}),
      updatedAt: new Date().toISOString(),
    };
    saveJob(next);
    return next;
  });
}

/** Attach a run to its job, keeping artifacts and obligations across attempts. */
export function attachRun(jobId: string, run: RunRecord): Job {
  return withLock(`job-${jobId}`, () => {
    const job = getJob(jobId);
    if (!job) throw new Error(`No job "${jobId}".`);
    const next: Job = {
      ...job,
      runIds: [...new Set([...job.runIds, run.id])],
      artifacts: [...new Set([...job.artifacts, ...(run.evidenceDir ? [run.evidenceDir] : [])])],
      updatedAt: new Date().toISOString(),
    };
    saveJob(next);
    return next;
  });
}

/**
 * Discharge obligations a run satisfied.
 *
 * A job settles only when nothing is outstanding. A resumed attempt may bring its
 * own manifest, but it cannot shorten this list — the obligations belong to the
 * approved task, not to whichever attempt happens to finish.
 */
export function dischargeObligations(jobId: string, satisfied: string[]): Job {
  return withLock(`job-${jobId}`, () => {
    const job = getJob(jobId);
    if (!job) throw new Error(`No job "${jobId}".`);
    const remaining = job.outstandingObligations.filter((o) => !satisfied.includes(o));
    const next: Job = {
      ...job,
      outstandingObligations: remaining,
      state: remaining.length === 0 ? 'settled' : job.state,
      updatedAt: new Date().toISOString(),
    };
    saveJob(next);
    return next;
  });
}

export interface Reconciler {
  runtime: RuntimeId;
  reconcile(sessionId: string, evidenceDir?: string): Promise<Outcome>;
}

export interface ReconcileReport {
  runId: string;
  jobId?: string;
  before: RunRecord['status'];
  outcome: Outcome;
  /** True when a fresh dispatch for this job would be unsafe right now. */
  blocksNewAttempt: boolean;
}

/**
 * Reconcile every run whose fate this coordinator does not know.
 *
 * Called on startup. A run left `running` when the process died is not evidence
 * that the remote work stopped, so each is asked about rather than assumed dead —
 * and while its state is unresolved, a second worker for the same job is refused.
 */
export async function reconcileUnsettled(
  reconcilers: Reconciler[],
  /** Reconcile only this runtime's runs. Absent means every unsettled run. */
  onlyRuntime?: RuntimeId,
): Promise<ReconcileReport[]> {
  const byRuntime = new Map(reconcilers.map((r) => [r.runtime, r]));
  const reports: ReconcileReport[] = [];

  for (const run of listRuns()) {
    if (run.status !== 'running' && run.status !== 'remote-uncertain') continue;
    // A run the caller deliberately scoped out was never asked about, so it gets no
    // report at all. Saying its remote state is unknown would read as the answer to
    // a question nobody put.
    if (onlyRuntime !== undefined && run.runtime !== onlyRuntime) continue;

    const reconciler = byRuntime.get(run.runtime);
    if (!reconciler) {
      reports.push({
        runId: run.id,
        before: run.status,
        outcome: {
          kind: 'remote-uncertain',
          runId: run.id,
          summary: `No reconciler for runtime ${run.runtime}; the run's remote state is unknown.`,
          nextAction: `Check the ${run.runtime} session by hand before dispatching another attempt for task ${run.taskId}.`,
        },
        blocksNewAttempt: true,
      });
      continue;
    }

    if (!run.sessionId) {
      // Contact was lost before a session id came back. The remote work may still
      // exist under an id this coordinator never learned, which is the worst case
      // for launching a second one.
      reports.push({
        runId: run.id,
        before: run.status,
        outcome: {
          kind: 'remote-uncertain',
          runId: run.id,
          taskId: run.taskId,
          summary: 'The run has no session id: contact was lost before the vendor acknowledged it.',
          nextAction: `List recent ${run.runtime} sessions for work matching task ${run.taskId} before dispatching again.`,
        },
        blocksNewAttempt: true,
      });
      continue;
    }

    // A reconciler that throws must not abort the caller. Dispatch reconciles every
    // runtime's unsettled runs, so an unreachable vendor on runtime A would otherwise
    // surface as a raw exception while the operator was dispatching to runtime B —
    // an error naming the wrong runtime, and no dispatch. The run still blocks a new
    // attempt, because a reconciler that could not answer has not said the work stopped.
    let outcome: Outcome;
    try {
      outcome = await reconciler.reconcile(run.sessionId, run.evidenceDir);
    } catch (err) {
      outcome = {
        kind: 'remote-uncertain',
        runId: run.id,
        summary:
          `Could not ask ${run.runtime} about session ${run.sessionId}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        nextAction:
          `Check that runtime by hand before starting another attempt at ${run.taskId}. `
          + 'A reconciler that could not answer has not reported the work stopped.',
      };
    }
    const settled = outcome.kind === 'completed' || outcome.kind === 'checks-failed';
    // The vendor answer arrived after an await. A manual stop attestation (or
    // another recovery) may have settled the run meanwhile; never write this
    // stale snapshot over it or report a stale answer as still blocking dispatch.
    const { current, settledHere } = withLock(`run-${run.id}`, () => {
      const latest = getRun(run.id);
      if (!latest || (latest.status !== 'running' && latest.status !== 'remote-uncertain')) {
        return { current: latest, settledHere: false };
      }
      if (settled) {
        const updated = {
          ...latest, status: outcome.kind, endedAt: new Date().toISOString(), summary: outcome.summary,
          ...(outcome.promptNotSent === true ? { promptNotSent: true as const } : {}),
        };
        saveRun(updated);
        return { current: updated, settledHere: true };
      }
      return { current: latest, settledHere: false };
    });
    const terminal = current && current.status !== 'running' && current.status !== 'remote-uncertain';
    const reportOutcome: Outcome = !current ? {
      kind: 'remote-uncertain', runId: run.id, taskId: run.taskId,
      summary: 'The run record is missing; its remote state cannot be confirmed.',
      nextAction: `Check the ${run.runtime} session before dispatching another attempt for task ${run.taskId}.`,
    } : current.status !== 'running' && current.status !== 'remote-uncertain' && !settledHere ? {
      kind: current.status, runId: current.id, taskId: current.taskId,
      summary: current.summary ?? (current.stopAttestation ? 'Pi stopped by operator; result unverified.' : 'Run settled during another recovery.'),
      ...(current.promptNotSent === true ? { promptNotSent: true } : {}),
      nextAction: current.stopAttestation
        ? 'Inspect the retained evidence before retrying.'
        : 'Inspect the retained result before continuing.',
    } : outcome;
    reports.push({
      runId: run.id,
      before: run.status,
      outcome: reportOutcome,
      blocksNewAttempt: !terminal,
    });
  }

  return reports;
}

/** Whether a job may take another attempt, given what reconciliation found. */
export function mayDispatchAgain(jobId: string, reports: ReconcileReport[]): Outcome | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  const blocking = reports.filter((r) => job.runIds.includes(r.runId) && r.blocksNewAttempt);
  if (blocking.length === 0) return undefined;
  return {
    kind: 'remote-uncertain',
    taskId: job.taskId,
    summary: `${blocking.length} earlier run(s) for this job have unresolved remote state.`,
    nextAction:
      'Resolve or explicitly abandon those sessions first. Launching a second worker while the first is unaccounted for is how one task becomes two.',
    details: { runs: blocking.map((b) => `${b.runId}: ${b.outcome.summary}`) },
  };
}
