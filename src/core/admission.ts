import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Outcome } from './outcome.js';
import { listRecords, newId, readJson, readRecord, stateRoot, withLock, withLockAsync, writeJson } from './store.js';
import type { UsageReading, UsageResult, UsageWindow, WindowKind } from './usage.js';
import { ageSeconds, resetInstant, windowOf } from './usage.js';

/** Operator-set thresholds, per subscription. Defaults are the Manifest's 60/40. */
export interface SubscriptionPolicy {
  subscriptionId: string;
  /** Stop admitting once this percent of the five-hour allowance is used. */
  fiveHourThresholdPercent: number;
  /** Stop admitting once this percent of the weekly allowance is used. */
  weeklyThresholdPercent: number;
  /** Headroom held back from every admission decision. */
  safetyMarginPercent: number;
  /** A reading older than this cannot admit work. */
  maxReadingAgeSeconds: number;
  /**
   * The windows this subscription actually meters, every one of which must be
   * read and must fit before work is admitted.
   *
   * Declared per subscription, never inferred from what a reading happens to
   * contain. A plan that meters one window and a plan whose second window failed
   * to arrive produce the same missing field, and the difference between them is
   * the difference between admitting work correctly and admitting it blind. So an
   * absent window is only ever allowed for because a person said this plan does
   * not have one, and a window named here that the reading does not carry blocks.
   */
  applicableWindows: MeteredWindow[];
  /**
   * Hours before a weekly reset over which the weekly ceiling rises, in a straight
   * line, from `weeklyThresholdPercent` to 100% at the reset. Absent means no ramp:
   * a window's room that nobody spent before it reset is lost, and this is the
   * operator's way of spending it. Five-hour windows and the margin are unchanged.
   */
  weeklyRampHours?: number;
}

/** The window kinds a subscription can be metered on. `other` is never a limit. */
export type MeteredWindow = Extract<WindowKind, 'five-hour' | 'weekly'>;

export const DEFAULT_POLICY: Omit<SubscriptionPolicy, 'subscriptionId'> = {
  fiveHourThresholdPercent: 60,
  weeklyThresholdPercent: 40,
  safetyMarginPercent: 5,
  maxReadingAgeSeconds: 300,
  applicableWindows: ['five-hour', 'weekly'],
};

/**
 * Windows a subscription is known to meter, where that is not the usual pair.
 *
 * `openai-codex` is here on the operator's ruling of 2026-09-09: "its true codex
 * does not have hourly and has only weekly usage". That is the basis — not a
 * vendor document, and not the observed `secondary: null`, which on its own is
 * equally consistent with telemetry that failed to arrive.
 */
const DECLARED_WINDOWS: Readonly<Record<string, MeteredWindow[]>> = {
  'openai-codex': ['weekly'],
};

/** What the ceiling of one window is at one instant, and why. */
export interface WindowCeiling {
  /** The ceiling admission applies to this window now. */
  ceilingPercent: number;
  /** The operator's ceiling for the window, before any ramp. */
  baseCeilingPercent: number;
  /** Hours until the window resets; absent when its reset time cannot be read. */
  hoursToReset?: number;
  /** Set when a ramp is configured: whether it applies now, or why not. */
  rampNote?: string;
}

/**
 * The ceiling a window admits up to at `now`.
 *
 * The weekly ceiling climbs linearly from its base to 100% across the final
 * `weeklyRampHours` before the window's reset. A reset time that cannot be read
 * applies no ramp, and says so, rather than assuming when the window ends.
 */
export function windowCeiling(policy: SubscriptionPolicy, kind: MeteredWindow, window: UsageWindow, observedAt: string, now: Date): WindowCeiling {
  const base = kind === 'five-hour' ? policy.fiveHourThresholdPercent : policy.weeklyThresholdPercent;
  const reset = window.resetsAt ? resetInstant(window.resetsAt, observedAt) : undefined;
  const hoursToReset = reset ? Math.max(0, (reset.getTime() - now.getTime()) / 3_600_000) : undefined;
  const result: WindowCeiling = { ceilingPercent: base, baseCeilingPercent: base, ...(hoursToReset !== undefined ? { hoursToReset } : {}) };
  const ramp = kind === 'weekly' ? policy.weeklyRampHours : undefined;
  if (ramp === undefined || !(ramp > 0)) return result;
  if (hoursToReset === undefined) return { ...result, rampNote: `${ramp}h ramp not applied: the reset time is unreadable${window.resetsAt ? ` ("${window.resetsAt}")` : ''}` };
  if (hoursToReset >= ramp) return { ...result, rampNote: `${ramp}h ramp has not started: ${hoursToReset.toFixed(1)}h to reset` };
  const ceiling = base + (100 - base) * ((ramp - hoursToReset) / ramp);
  return { ...result, ceilingPercent: ceiling, rampNote: `${ramp}h ramp lifts the ceiling from ${base}% to ${ceiling.toFixed(1)}%: ${hoursToReset.toFixed(1)}h to reset` };
}

/** A window's room now: its ceiling in force, less what is used, reserved and held back as margin. */
export interface WindowRoom extends WindowCeiling {
  usedPercent: number;
  reservedPercent: number;
  marginPercent: number;
  /** Can be negative. */
  availablePercent: number;
}

export function windowRoom(
  policy: SubscriptionPolicy, kind: MeteredWindow, window: UsageWindow, observedAt: string, reservedPercent: number, now: Date,
): WindowRoom {
  const ceiling = windowCeiling(policy, kind, window, observedAt, now);
  return {
    ...ceiling,
    usedPercent: window.usedPercent,
    reservedPercent,
    marginPercent: policy.safetyMarginPercent,
    availablePercent: ceiling.ceilingPercent - window.usedPercent - reservedPercent - policy.safetyMarginPercent,
  };
}

/** A job's predicted cost, in percent of each window's whole allowance. */
export interface UsageEstimate {
  fiveHourPercent: number;
  weeklyPercent: number;
  /** Where the number came from. `none` means there is no basis yet. */
  basis: 'comparable-history' | 'operator-bound' | 'calibration-approval' | 'none';
  /** How much to distrust it, in percent points. Widens the required headroom. */
  uncertaintyPercent: number;
  /** Human-readable provenance, e.g. "7 prior pi-local runs, p90". */
  detail: string;
}

export interface Reservation {
  id: string;
  subscriptionId: string;
  taskId: string;
  runId: string;
  estimate: UsageEstimate;
  createdAt: string;
  /**
   * `held` counts against headroom and can be released. `outstanding` is a job
   * whose remote state could not be confirmed stopped — it keeps its reservation
   * precisely because assuming it stopped is what would overspend the account.
   */
  state: 'held' | 'released' | 'outstanding';
  releasedAt?: string;
  note?: string;
}

const policiesDir = (): string => join(stateRoot(), 'policies');
const reservationsDir = (): string => join(stateRoot(), 'reservations');
const readingsDir = (): string => join(stateRoot(), 'usage-readings');

export function getPolicy(subscriptionId: string): SubscriptionPolicy {
  const stored = readJson<SubscriptionPolicy>(join(policiesDir(), `${subscriptionId}.json`));
  const applicableWindows =
    DECLARED_WINDOWS[subscriptionId] ?? DEFAULT_POLICY.applicableWindows;
  // A policy stored before this field existed must not read as "no window applies",
  // which would admit work against nothing at all.
  if (stored) {
    return {
      ...stored,
      applicableWindows:
        stored.applicableWindows && stored.applicableWindows.length > 0
          ? stored.applicableWindows
          : applicableWindows,
    };
  }
  return { subscriptionId, ...DEFAULT_POLICY, applicableWindows };
}

/** Only an operator path should reach this; authority.assertOperator gates the CLI. */
export function savePolicy(policy: SubscriptionPolicy): void {
  writeJson(join(policiesDir(), `${policy.subscriptionId}.json`), policy);
}

export function listReservations(subscriptionId?: string): Reservation[] {
  const all = listRecords<Reservation>('reservation', reservationsDir());
  return subscriptionId ? all.filter((r) => r.subscriptionId === subscriptionId) : all;
}

/** Reservations still consuming headroom. */
export function activeReservations(subscriptionId: string): Reservation[] {
  return listReservations(subscriptionId).filter(
    (r) => r.state === 'held' || r.state === 'outstanding',
  );
}

export function saveReading(reading: UsageReading): void {
  writeJson(
    join(readingsDir(), `${reading.subscriptionId}-${reading.observedAt.replace(/[:.]/g, '-')}.json`),
    reading,
  );
}

/**
 * The most recent reading for a subscription.
 *
 * Reads one file, not the whole directory. The filenames carry an ISO timestamp
 * and so sort chronologically, and this runs on the admission path where a scan
 * that grows with every past dispatch would widen the window the lock is held for.
 */
export function latestReading(subscriptionId: string): UsageReading | undefined {
  const prefix = `${subscriptionId}-`;
  const names = readingFilenames().filter((n) => n.startsWith(prefix)).sort();
  const newest = names[names.length - 1];
  if (newest === undefined) return undefined;
  return readJson<UsageReading>(join(readingsDir(), newest));
}

function readingFilenames(): string[] {
  try {
    return readdirSync(readingsDir()).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface WindowVerdict {
  kind: WindowKind;
  /**
   * True when this window is not in the subscription's declared set but the account
   * reported it anyway. It is checked like any other; the flag exists so the
   * operator is told the declaration is narrower than the account.
   */
  undeclared?: boolean;
  /** The ceiling in force now: the policy's threshold, raised by a ramp when one applies. */
  thresholdPercent: number;
  usedPercent: number;
  reservedPercent: number;
  marginPercent: number;
  estimatePercent: number;
  /** Ceiling minus used, reserved and margin. Can be negative. */
  availablePercent: number;
  fits: boolean;
  resetsAt?: string;
  /** Hours until the window resets, when its reset time is readable. */
  hoursToReset?: number;
  /** The policy's threshold before any ramp; set only where a ramp is configured. */
  baseThresholdPercent?: number;
  /** Whether the weekly ramp applies now, or why not; set only where a ramp is configured. */
  rampNote?: string;
}

export interface AdmissionDecision {
  admitted: boolean;
  subscriptionId: string;
  windows: WindowVerdict[];
  estimate: UsageEstimate;
  reservationId?: string;
  outcome?: Outcome;
  /** The reading the decision was made against, for the run record. */
  reading?: UsageReading;
}

export interface AdmissionRequest {
  subscriptionId: string;
  taskId: string;
  runId: string;
  estimate: UsageEstimate;
  /** Supplies a fresh reading. Called inside the lock so two dispatchers cannot race. */
  readUsage: () => Promise<UsageResult> | UsageResult;
  /**
   * Decide without reserving. A dry run asks whether work *would* be admitted;
   * holding headroom for work it will not start would refuse the real dispatches
   * behind it.
   */
  preview?: boolean;
  /** The instant the decision is made at, for the weekly ramp. Defaults to the clock. */
  now?: Date;
}

/**
 * Decide whether a job may launch, and reserve its headroom if so.
 *
 * The whole body runs under one lock and takes its reading *inside* that lock:
 * reading first and locking second would let two dispatchers observe the same
 * headroom and each conclude it was free.
 */
export async function admit(req: AdmissionRequest): Promise<AdmissionDecision> {
  const policy = getPolicy(req.subscriptionId);

  return await withLockAsync(`admission-${req.subscriptionId}`, async () => {
    // The estimate is part of the request, and no usage reading can make a
    // basis-less one usable. Settling it before calling the vendor keeps a
    // request the caller can fix from depending on an external call that cannot
    // change the answer, and reports the blocker they own rather than one they
    // do not.
    if (req.estimate.basis === 'none') {
      return blocked(req, policy, {
        kind: 'quota-waiting',
        taskId: req.taskId,
        runId: req.runId,
        summary: 'No usable usage estimate for this job.',
        nextAction:
          'Supply the bound on the dispatch: --estimate-weekly N and --estimate-five-hour N, with '
          + '--estimate-basis naming where the number came from '
          + '(comparable-history, operator-bound or calibration-approval).',
        details: { estimateDetail: req.estimate.detail },
      });
    }

    const result = await req.readUsage();

    if (!result.ok) {
      return blocked(req, policy, {
        kind: 'quota-waiting',
        taskId: req.taskId,
        runId: req.runId,
        summary: `Cannot read ${req.subscriptionId} usage: ${result.unavailable.reason}`,
        nextAction: result.unavailable.operatorAction,
        details: { source: result.unavailable.source, attemptedAt: result.unavailable.attemptedAt },
      });
    }

    const reading = result.reading;
    const age = ageSeconds(reading);
    if (age > policy.maxReadingAgeSeconds) {
      return blocked(req, policy, {
        kind: 'quota-waiting',
        taskId: req.taskId,
        runId: req.runId,
        summary: `Usage reading for ${req.subscriptionId} is ${Math.round(age)}s old; the policy allows ${policy.maxReadingAgeSeconds}s.`,
        nextAction: 'Refresh the usage reading and retry the dispatch.',
      });
    }

    saveReading(reading);
    const held = activeReservations(req.subscriptionId);

    const now = req.now ?? new Date();
    // Every declared window, plus any metered window the account turned out to
    // report anyway. Checking only the declared set would mean a wrong declaration
    // — a typo, a plan that changed tier — silently admits work past a limit the
    // vendor is really enforcing. An undeclared window is still gated; it is
    // flagged so the operator widens the declaration rather than discovers it later.
    const undeclared = (['five-hour', 'weekly'] as const).filter(
      (k) => !policy.applicableWindows.includes(k) && windowOf(reading, k) !== undefined,
    );
    const verdicts: WindowVerdict[] = [];
    for (const kind of [...policy.applicableWindows, ...undeclared]) {
      const window = windowOf(reading, kind);
      if (!window) {
        return blocked(req, policy, {
          kind: 'quota-waiting',
          taskId: req.taskId,
          runId: req.runId,
          summary:
            `The ${req.subscriptionId} reading has no ${kind} window. This subscription is `
            + `declared to meter ${policy.applicableWindows.join(' and ')}, and every declared window `
            + 'must be known to admit work.',
          nextAction:
            `Check the usage source reports the ${kind} window, then retry. If this plan genuinely `
            + 'does not meter it, an operator changes the declared windows — a missing reading is not '
            + 'evidence of an absent limit.',
          details: { windowsSeen: reading.windows.map((w) => `${w.vendorLabel}:${w.kind}`) },
        });
      }
      const reserved = reservedPercent(held, kind);
      const estimatePercent = estimateFor(req.estimate, kind) + req.estimate.uncertaintyPercent;
      const ceiling = windowRoom(policy, kind, window, reading.observedAt, reserved, now);
      const available = ceiling.availablePercent;
      verdicts.push({
        kind,
        ...(undeclared.includes(kind) ? { undeclared: true } : {}),
        thresholdPercent: ceiling.ceilingPercent,
        usedPercent: window.usedPercent,
        reservedPercent: reserved,
        marginPercent: policy.safetyMarginPercent,
        estimatePercent,
        availablePercent: available,
        fits: estimatePercent <= available,
        ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        ...(ceiling.hoursToReset !== undefined ? { hoursToReset: ceiling.hoursToReset } : {}),
        ...(ceiling.rampNote !== undefined ? { baseThresholdPercent: ceiling.baseCeilingPercent, rampNote: ceiling.rampNote } : {}),
      });
    }

    const failing = verdicts.filter((v) => !v.fits);
    if (failing.length > 0) {
      const worst = failing[0]!;
      return {
        admitted: false,
        subscriptionId: req.subscriptionId,
        windows: verdicts,
        estimate: req.estimate,
        reading,
        outcome: {
          kind: 'quota-waiting',
          taskId: req.taskId,
          runId: req.runId,
          summary: `Job does not fit the ${worst.kind} window: needs ${worst.estimatePercent.toFixed(1)}%, ${worst.availablePercent.toFixed(1)}% available (threshold ${Number(worst.thresholdPercent.toFixed(1))}%, used ${worst.usedPercent}%, reserved ${worst.reservedPercent.toFixed(1)}%, margin ${worst.marginPercent}%).${worst.rampNote ? ` ${worst.rampNote[0]!.toUpperCase()}${worst.rampNote.slice(1)}.` : ''}`,
          nextAction: worst.resetsAt
            ? `Wait for the ${worst.kind} window to reset at ${worst.resetsAt}, then retry.`
            : `Wait for ${worst.kind} usage to fall, or lower the job's scope.`,
          details: { estimateBasis: req.estimate.basis, estimateDetail: req.estimate.detail },
        },
      };
    }

    if (req.preview) {
      return { admitted: true, subscriptionId: req.subscriptionId, windows: verdicts, estimate: req.estimate, reading };
    }

    const reservation: Reservation = {
      id: newId('res'),
      subscriptionId: req.subscriptionId,
      taskId: req.taskId,
      runId: req.runId,
      estimate: req.estimate,
      createdAt: new Date().toISOString(),
      state: 'held',
    };
    writeJson(join(reservationsDir(), `${reservation.id}.json`), reservation);

    return {
      admitted: true,
      subscriptionId: req.subscriptionId,
      windows: verdicts,
      estimate: req.estimate,
      reservationId: reservation.id,
      reading,
    };
  });
}

function estimateFor(e: UsageEstimate, kind: WindowKind): number {
  return kind === 'five-hour' ? e.fiveHourPercent : e.weeklyPercent;
}

/** What reservations already hold against one window. */
export function reservedPercent(held: readonly Reservation[], kind: WindowKind): number {
  return held.reduce((sum, r) => sum + estimateFor(r.estimate, kind), 0);
}

function blocked(
  req: AdmissionRequest,
  _policy: SubscriptionPolicy,
  outcome: Outcome,
): AdmissionDecision {
  return {
    admitted: false,
    subscriptionId: req.subscriptionId,
    windows: [],
    estimate: req.estimate,
    outcome,
  };
}

/** Release future headroom once work is known to have settled; this does not measure its consumption. */
export function releaseReservation(id: string, note?: string): Reservation | undefined {
  return withLock(`reservation-${id}`, () => {
    const path = join(reservationsDir(), `${id}.json`);
    const r = readRecord<Reservation>('reservation', path);
    if (!r || r.state === 'released') return r;
    const next: Reservation = {
      ...r,
      state: 'released',
      releasedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    writeJson(path, next);
    return next;
  });
}

/**
 * Settle reservations whose run is no longer in flight.
 *
 * A reservation is a claim on *future* headroom. Once a run stops, what it
 * actually consumed appears in the vendor's own usage reading, so a reservation
 * still claiming headroom past that point is counted twice and never comes back.
 *
 * The dispatch path settles its own, but a process that dies between writing the
 * run record and settling leaves one stranded, and nothing else was ever going
 * to look at it: reconciliation only asks vendors about work that may still be
 * running, so a stopped run's reservation had no recovery path at all. Without
 * this the only remedy is editing state by hand, which the coordinator forbids
 * for good reason.
 *
 * Both active states are swept, and for different reasons:
 *
 *   - `held` is a live claim on a run that may or may not have stopped.
 *   - `outstanding` is a job whose remote state could not be confirmed stopped.
 *     It keeps its headroom on purpose, and it must keep it until something
 *     actually confirms the outcome. When reconciliation later does confirm
 *     one, nothing else releases it, so it would hold headroom forever.
 *
 * This never invents an outcome. It reads the run's own recorded status and
 * applies the rule the dispatch path would have applied. An outstanding
 * reservation is released only for a genuinely settled status, never for a run
 * that is merely no longer being watched.
 *
 * @param runs the run records to check, as `{id, status, reservationId}`
 */
export function sweepStrandedReservations(
  runs: { id: string; status: string; reservationId: string | undefined }[],
): { reservationId: string; runId: string; action: 'released' | 'outstanding' }[] {
  const byReservation = new Map(
    runs.filter((r) => r.reservationId !== undefined).map((r) => [r.reservationId as string, r]),
  );
  const swept: { reservationId: string; runId: string; action: 'released' | 'outstanding' }[] = [];

  for (const reservation of listReservations()) {
    if (reservation.state === 'released') continue;

    const run = byReservation.get(reservation.id);
    // A reservation with no run behind it is not this function's to judge: it
    // may belong to a dispatch still deciding. Only a run that reported a status
    // settles anything.
    if (!run) continue;

    // The reservation records the run it was taken for. A mismatch means these
    // two records disagree about who owns this headroom, and guessing which is
    // right is how the wrong reservation gets released.
    if (reservation.runId !== run.id) continue;

    // Still in flight, or still genuinely uncertain: its headroom is its own.
    if (run.status === 'running') continue;
    if (!SETTLED_STATUSES.includes(run.status)) {
      // Only a held reservation needs moving here. One already outstanding is
      // in the right state for a run whose outcome is still not established.
      if (reservation.state === 'held') {
        markOutstanding(reservation.id, `Run ${run.id} ended ${run.status} without settling its reservation; its consumption is not established.`);
        swept.push({ reservationId: reservation.id, runId: run.id, action: 'outstanding' });
      }
      continue;
    }

    releaseReservation(
      reservation.id,
      reservation.state === 'outstanding'
        ? `Run ${run.id} was confirmed ${run.status} after being uncertain; its reservation no longer holds future headroom.`
        : `Run ${run.id} settled (${run.status}) without releasing its reservation; no future headroom needed.`,
    );
    swept.push({ reservationId: reservation.id, runId: run.id, action: 'released' });
  }
  return swept;
}

/**
 * Statuses that mean the work is over and consumed what it consumed.
 *
 * Exactly the set the dispatch path releases on, and no wider. Everything else
 * ends a local observation without establishing that remote work stopped:
 * `setup-blocked`, `native-unavailable` and `awaiting-approval` all leave a job
 * that may still be running somewhere, and assuming otherwise is what overspends
 * the account.
 *
 * Kept as a list rather than derived, so adding an outcome kind forces a
 * decision about which side of this line it falls on instead of silently
 * defaulting to one.
 */
const SETTLED_STATUSES = [
  'completed', 'checks-failed', 'refused', 'unsupported-settings', 'attempts-exhausted',
];

/**
 * Mark a reservation outstanding because the remote job could not be confirmed
 * stopped. It keeps consuming headroom on purpose.
 */
export function markOutstanding(id: string, note: string): Reservation | undefined {
  return withLock(`reservation-${id}`, () => {
    const path = join(reservationsDir(), `${id}.json`);
    const r = readRecord<Reservation>('reservation', path);
    if (!r || r.state === 'released') return r;
    const next: Reservation = { ...r, state: 'outstanding', note };
    writeJson(path, next);
    return next;
  });
}
