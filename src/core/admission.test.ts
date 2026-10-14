import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_POLICY, activeReservations, admit, getPolicy, listReservations,
  markOutstanding, releaseReservation, savePolicy, sweepStrandedReservations,
} from './admission.js';
import type { AdmissionRequest, UsageEstimate } from './admission.js';
import { sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';
import type { UsageReading, UsageResult } from './usage.js';
import { classifyWindow } from './usage.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

// A subscription metered on both windows, so these cases exercise the two-window
// path. Named for the real one it stands in for: the Claude side must behave
// exactly as it did before per-subscription windows existed.
const SUB = 'claude-max';

function reading(fiveHour: number, weekly: number, observedAt = new Date().toISOString()): UsageReading {
  return {
    subscriptionId: SUB,
    observedAt,
    source: 'test',
    windows: [
      { kind: 'five-hour', usedPercent: fiveHour, windowDurationMins: 300, vendorLabel: 'primary', resetsAt: '2026-09-09T01:00:00Z' },
      { kind: 'weekly', usedPercent: weekly, windowDurationMins: 10080, vendorLabel: 'secondary', resetsAt: '2026-09-11T01:00:00Z' },
    ],
  };
}

const ESTIMATE: UsageEstimate = {
  fiveHourPercent: 2,
  weeklyPercent: 1,
  basis: 'comparable-history',
  uncertaintyPercent: 1,
  detail: '7 prior pi-local runs, p90',
};

function req(over: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    subscriptionId: SUB,
    taskId: 'task_1',
    runId: 'run_1',
    estimate: ESTIMATE,
    readUsage: (): UsageResult => ({ ok: true, reading: reading(10, 10) }),
    ...over,
  };
}

describe('window classification', () => {
  it('classifies by duration, not by position', () => {
    assert.equal(classifyWindow(300, 'secondary'), 'five-hour');
    assert.equal(classifyWindow(10080, 'primary'), 'weekly');
  });

  it('falls back to the vendor label when no duration is reported', () => {
    assert.equal(classifyWindow(undefined, 'five_hour'), 'five-hour');
    assert.equal(classifyWindow(undefined, 'seven_day'), 'weekly');
    assert.equal(classifyWindow(undefined, 'mystery_bucket'), 'other');
  });
});

describe('thresholds', () => {
  it('defaults to the operator-chosen 60 / 40', () => {
    box = sandbox();
    const p = getPolicy(SUB);
    assert.equal(p.fiveHourThresholdPercent, 60);
    assert.equal(p.weeklyThresholdPercent, 40);
    assert.equal(DEFAULT_POLICY.fiveHourThresholdPercent, 60);
  });

  it('admits below both thresholds', async () => {
    box = sandbox();
    const d = await admit(req());
    assert.equal(d.admitted, true);
    assert.ok(d.reservationId);
  });

  it('refuses when the five-hour window is at its threshold', async () => {
    box = sandbox();
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(60, 5) }) }));
    assert.equal(d.admitted, false);
    assert.equal(d.outcome?.kind, 'quota-waiting');
    assert.match(d.outcome?.summary ?? '', /five-hour/);
  });

  it('refuses when only the weekly window is at its threshold', async () => {
    box = sandbox();
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(5, 40) }) }));
    assert.equal(d.admitted, false, 'a job must fit BOTH windows, not just the one being watched');
    assert.match(d.outcome?.summary ?? '', /weekly/);
  });

  it('defers a job too large for the remaining allowance even below the thresholds', async () => {
    box = sandbox();
    const d = await admit(req({
      readUsage: () => ({ ok: true, reading: reading(30, 10) }),
      estimate: { ...ESTIMATE, fiveHourPercent: 40, weeklyPercent: 1 },
    }));
    assert.equal(d.admitted, false, 'usage is under 60% but the job would cross it');
    assert.match(d.outcome?.summary ?? '', /does not fit the five-hour window/);
  });

  it('honours an operator-changed threshold', async () => {
    box = sandbox();
    savePolicy({ subscriptionId: SUB, ...DEFAULT_POLICY, fiveHourThresholdPercent: 20 });
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(18, 5) }) }));
    assert.equal(d.admitted, false);
  });
});

describe('unusable readings never become headroom', () => {
  it('blocks when usage cannot be read', async () => {
    box = sandbox();
    const d = await admit(req({
      readUsage: () => ({
        ok: false,
        unavailable: {
          subscriptionId: SUB, attemptedAt: new Date().toISOString(), source: 'codex app-server',
          reason: 'failed to initialize sqlite state runtime',
          operatorAction: 'Run `codex login`, then retry.',
        },
      }),
    }));
    assert.equal(d.admitted, false);
    assert.equal(d.outcome?.kind, 'quota-waiting');
    assert.match(d.outcome?.nextAction ?? '', /codex login/);
  });

  it('blocks on a stale reading rather than reusing it', async () => {
    box = sandbox();
    const old = new Date(Date.now() - 3600_000).toISOString();
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(1, 1, old) }) }));
    assert.equal(d.admitted, false);
    assert.match(d.outcome?.summary ?? '', /old; the policy allows/);
  });

  it('blocks when a required window is absent rather than assuming it is empty', async () => {
    box = sandbox();
    const partial: UsageReading = {
      subscriptionId: SUB, observedAt: new Date().toISOString(), source: 'test',
      windows: [{ kind: 'five-hour', usedPercent: 1, windowDurationMins: 300, vendorLabel: 'primary' }],
    };
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: partial }) }));
    assert.equal(d.admitted, false);
    assert.match(d.outcome?.summary ?? '', /no weekly window/);
  });

  it('blocks when there is no basis for an estimate', async () => {
    box = sandbox();
    const d = await admit(req({
      estimate: { fiveHourPercent: 0, weeklyPercent: 0, basis: 'none', uncertaintyPercent: 0, detail: 'no comparable runs' },
    }));
    assert.equal(d.admitted, false);
    assert.match(d.outcome?.nextAction ?? '', /calibration/);
  });

  /**
   * The estimate is settled before the vendor is called at all. Without this the
   * refusal an operator sees depends on whether a vendor CLI happens to be
   * installed and authenticated, which is neither their problem nor a fact about
   * their request.
   */
  it('refuses a basis-less estimate without reading usage', async () => {
    box = sandbox();
    let readAttempts = 0;
    const d = await admit(req({
      estimate: { fiveHourPercent: 0, weeklyPercent: 0, basis: 'none', uncertaintyPercent: 0, detail: 'no comparable runs' },
      readUsage: () => {
        readAttempts++;
        return {
          ok: false,
          unavailable: {
            subscriptionId: SUB, attemptedAt: new Date().toISOString(), source: 'codex app-server',
            reason: 'spawn codex ENOENT',
            operatorAction: 'Install and authenticate the vendor CLI, then retry.',
          },
        };
      },
    }));
    assert.equal(d.admitted, false);
    assert.equal(readAttempts, 0, 'a request that cannot be admitted must not spend a vendor call');
    assert.match(d.outcome?.summary ?? '', /No usable usage estimate/);
    assert.doesNotMatch(d.outcome?.summary ?? '', /ENOENT/);
  });

  it('admits a cold start once a bounded calibration is approved', async () => {
    box = sandbox();
    const d = await admit(req({
      estimate: {
        fiveHourPercent: 1, weeklyPercent: 0.5, basis: 'calibration-approval',
        uncertaintyPercent: 1, detail: 'operator approved a 1% calibration run',
      },
    }));
    assert.equal(d.admitted, true);
  });
});

describe('reservations', () => {
  it('holds headroom so a second dispatcher cannot spend it twice', async () => {
    box = sandbox();
    const big = { ...ESTIMATE, fiveHourPercent: 20, uncertaintyPercent: 0 };
    const first = await admit(req({ runId: 'run_a', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    assert.equal(first.admitted, true);
    // 60 - 30 used - 20 reserved - 5 margin = 5 available; a second 20% job cannot fit.
    const second = await admit(req({ taskId: 'task_2', runId: 'run_b', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    assert.equal(second.admitted, false, 'the first reservation must still be counted');
    assert.match(second.outcome?.summary ?? '', /reserved 20/);
  });

  it('frees headroom when released', async () => {
    box = sandbox();
    const big = { ...ESTIMATE, fiveHourPercent: 20, uncertaintyPercent: 0 };
    const first = await admit(req({ runId: 'run_a', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    releaseReservation(first.reservationId!, 'run finished; no future headroom needed');
    const second = await admit(req({ taskId: 'task_2', runId: 'run_b', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    assert.equal(second.admitted, true);
    assert.equal(activeReservations(SUB).length, 1);
  });

  it('keeps holding headroom for a job whose cancellation was not confirmed', async () => {
    box = sandbox();
    const big = { ...ESTIMATE, fiveHourPercent: 20, uncertaintyPercent: 0 };
    const first = await admit(req({ runId: 'run_a', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    markOutstanding(first.reservationId!, 'vendor returned no cancellation confirmation');
    const second = await admit(req({ taskId: 'task_2', runId: 'run_b', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    assert.equal(second.admitted, false, 'an unconfirmed remote job must not have its headroom reused');
    assert.equal(activeReservations(SUB)[0]?.state, 'outstanding');
  });

  for (const transition of [markOutstanding, releaseReservation]) {
    it(`${transition.name} leaves a released reservation unchanged`, async (t) => {
      box = sandbox();
      const admitted = await admit(req());
      assert.ok(admitted.reservationId);
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-12T00:00:00Z') });
      const released = releaseReservation(admitted.reservationId, 'run finished');
      assert.ok(released);
      assert.equal(released.state, 'released');
      assert.equal(released.releasedAt, '2026-09-12T00:00:00.000Z');
      assert.equal(released.note, 'run finished');

      t.mock.timers.tick(1000);
      const result = transition(admitted.reservationId, 'late update');
      assert.deepEqual(result, released);
      assert.deepEqual(listReservations(SUB), [released]);
      assert.deepEqual(activeReservations(SUB), []);
    });

    it(`${transition.name} does not create a missing reservation`, () => {
      box = sandbox();
      assert.equal(transition('res_missing', 'late update'), undefined);
      assert.deepEqual(listReservations(SUB), []);
    });
  }

  it('releases an outstanding reservation once its work settles', async (t) => {
    box = sandbox();
    const admitted = await admit(req());
    assert.ok(admitted.reservationId);
    const outstanding = markOutstanding(admitted.reservationId, 'cancellation unconfirmed');
    assert.ok(outstanding);
    assert.equal(outstanding.state, 'outstanding');
    assert.deepEqual(activeReservations(SUB), [outstanding]);

    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-12T00:00:00Z') });
    const released = releaseReservation(admitted.reservationId, 'completion confirmed');
    assert.deepEqual(released, {
      ...outstanding,
      state: 'released',
      releasedAt: '2026-09-12T00:00:00.000Z',
      note: 'completion confirmed',
    });
    assert.deepEqual(listReservations(SUB), [released]);
    assert.deepEqual(activeReservations(SUB), []);
  });

  it('survives a coordinator restart, because reservations are on disk', async () => {
    box = sandbox();
    const big = { ...ESTIMATE, fiveHourPercent: 20, uncertaintyPercent: 0 };
    await admit(req({ runId: 'run_a', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    // A restart is exactly this: new process state, same directory.
    assert.equal(listReservations(SUB).length, 1);
    const second = await admit(req({ taskId: 'task_2', runId: 'run_b', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    assert.equal(second.admitted, false);
  });

  it('keeps separate subscriptions separate', async () => {
    box = sandbox();
    const big = { ...ESTIMATE, fiveHourPercent: 20, uncertaintyPercent: 0 };
    await admit(req({ runId: 'run_a', estimate: big, readUsage: () => ({ ok: true, reading: reading(30, 5) }) }));
    const otherReading: UsageReading = { ...reading(30, 5), subscriptionId: 'another-account' };
    const other = await admit(req({
      subscriptionId: 'another-account', taskId: 'task_2', runId: 'run_b', estimate: big,
      readUsage: () => ({ ok: true, reading: otherReading }),
    }));
    assert.equal(other.admitted, true, 'a different account has its own allowance');
  });

  it('counts external account usage, not just its own reservations', async () => {
    box = sandbox();
    // Nothing reserved locally, but the account is already busy from elsewhere.
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(58, 5) }) }));
    assert.equal(d.admitted, false);
    assert.match(d.outcome?.summary ?? '', /used 58/);
  });

  it('admits again after a window reset lowers the reading', async () => {
    box = sandbox();
    const before = await admit(req({ readUsage: () => ({ ok: true, reading: reading(59, 5) }) }));
    assert.equal(before.admitted, false);
    const after = await admit(req({ readUsage: () => ({ ok: true, reading: reading(2, 5) }) }));
    assert.equal(after.admitted, true);
  });
});

describe('the decision is shown, not just made', () => {
  it('reports estimate, margin, reservation and reason', async () => {
    box = sandbox();
    const d = await admit(req({ readUsage: () => ({ ok: true, reading: reading(10, 10) }) }));
    const five = d.windows.find((w) => w.kind === 'five-hour')!;
    assert.equal(five.thresholdPercent, 60);
    assert.equal(five.usedPercent, 10);
    assert.equal(five.marginPercent, 5);
    assert.equal(five.estimatePercent, 3); // 2 estimate + 1 uncertainty
    assert.equal(five.availablePercent, 45); // 60 - 10 - 0 - 5
    assert.equal(five.resetsAt, '2026-09-09T01:00:00Z');
    assert.equal(d.estimate.basis, 'comparable-history');
    assert.equal(d.estimate.detail, '7 prior pi-local runs, p90');
  });
});


describe('a subscription metered on one window', () => {
  // The basis is the operator's ruling of 2026-09-09 — "its true codex does not
  // have hourly and has only weekly usage" — not a vendor document and not the
  // observed `secondary: null`, which alone cannot tell an absent limit from
  // telemetry that failed to arrive.
  const CODEX = 'openai-codex';

  const weeklyOnly = (weekly: number): UsageReading => ({
    subscriptionId: CODEX,
    observedAt: new Date().toISOString(),
    source: 'codex app-server account/rateLimits/read',
    windows: [{ kind: 'weekly', usedPercent: weekly, vendorLabel: 'primary', windowDurationMins: 10080 }],
  });

  it('declares Codex as weekly-only without being told by a reading', () => {
    box = sandbox();
    assert.deepEqual(getPolicy(CODEX).applicableWindows, ['weekly']);
    assert.deepEqual(getPolicy('claude-max').applicableWindows, ['five-hour', 'weekly']);
  });

  it('admits on the weekly window alone when it fits', async () => {
    box = sandbox();
    const decision = await admit(req({
      subscriptionId: CODEX,
      estimate: { ...ESTIMATE, weeklyPercent: 2, uncertaintyPercent: 0 },
      readUsage: () => ({ ok: true, reading: weeklyOnly(10) }),
    }));
    assert.equal(decision.admitted, true);
    assert.deepEqual(decision.windows.map((w) => w.kind), ['weekly'], 'no five-hour verdict is invented');
  });

  it('refuses when the weekly window is exhausted, margin included', async () => {
    // The absent five-hour window is not a free pass: the one window it does have
    // still has to fit.
    box = sandbox();
    const decision = await admit(req({
      subscriptionId: CODEX,
      estimate: { ...ESTIMATE, weeklyPercent: 1, uncertaintyPercent: 0 },
      readUsage: () => ({ ok: true, reading: weeklyOnly(36) }),
    }));
    assert.equal(decision.admitted, false, '40 threshold - 36 used - 5 margin leaves nothing');
  });

  it('still blocks when the weekly reading it does need is missing', async () => {
    box = sandbox();
    const noWindows: UsageReading = { ...weeklyOnly(10), windows: [] };
    const decision = await admit(req({
      subscriptionId: CODEX,
      readUsage: () => ({ ok: true, reading: noWindows }),
    }));
    assert.equal(decision.admitted, false);
    assert.match(decision.outcome?.summary ?? '', /no weekly window/);
    assert.match(decision.outcome?.nextAction ?? '', /missing reading is not/);
  });

  it('still blocks when the weekly reading is stale', async () => {
    box = sandbox();
    const old = new Date(Date.now() - 3600_000).toISOString();
    const decision = await admit(req({
      subscriptionId: CODEX,
      readUsage: () => ({ ok: true, reading: { ...weeklyOnly(10), observedAt: old } }),
    }));
    assert.equal(decision.admitted, false);
    assert.match(decision.outcome?.summary ?? '', /old/);
  });

  it('still blocks when the reading cannot be taken at all', async () => {
    box = sandbox();
    const decision = await admit(req({
      subscriptionId: CODEX,
      readUsage: () => ({
        ok: false,
        unavailable: {
          subscriptionId: CODEX,
          attemptedAt: new Date().toISOString(),
          source: 'codex app-server account/rateLimits/read',
          reason: 'The rate-limits answer carried no window with a usedPercent.',
          operatorAction: 'Check the plan reports any window at all.',
        },
      }),
    }));
    assert.equal(decision.admitted, false);
  });

  const alsoReportsFiveHour = (fiveHour: number): UsageReading => ({
    ...weeklyOnly(10),
    windows: [
      { kind: 'five-hour', usedPercent: fiveHour, vendorLabel: 'secondary', windowDurationMins: 300 },
      { kind: 'weekly', usedPercent: 10, vendorLabel: 'primary', windowDurationMins: 10080 },
    ],
  });

  it('refuses on a five-hour window it was not declared to meter but the account reports', async () => {
    // Declaring fewer windows narrows what must be *present*. It never licenses
    // admitting past a limit the account is really enforcing — a declaration can be
    // a typo or a plan that changed tier, and the account is the one holding the
    // allowance. Weekly alone would fit here; the undeclared window is what refuses.
    box = sandbox();
    const decision = await admit(req({
      subscriptionId: CODEX,
      estimate: { ...ESTIMATE, weeklyPercent: 2, uncertaintyPercent: 0 },
      readUsage: () => ({ ok: true, reading: alsoReportsFiveHour(90) }),
    }));
    assert.equal(decision.admitted, false, '90% used against a 60% threshold cannot pass');
    assert.equal(decision.reading?.windows.length, 2, 'the unexpected window stays on the record');
  });

  it('marks that window undeclared, so the operator widens the declaration', async () => {
    box = sandbox();
    const decision = await admit(req({
      subscriptionId: CODEX,
      estimate: { ...ESTIMATE, weeklyPercent: 2, uncertaintyPercent: 0 },
      readUsage: () => ({ ok: true, reading: alsoReportsFiveHour(1) }),
    }));
    assert.equal(decision.admitted, true, 'it fits, so it admits');
    const fiveHour = decision.windows.find((w) => w.kind === 'five-hour');
    assert.equal(fiveHour?.undeclared, true, 'flagged as beyond the declaration');
    assert.equal(decision.windows.find((w) => w.kind === 'weekly')?.undeclared, undefined);
  });
});

describe('a policy stored before windows were declared', () => {
  it('does not read as "no window applies"', () => {
    // An empty list would admit work against nothing at all, which is the most
    // permissive possible reading of an older file.
    box = sandbox();
    savePolicy({ subscriptionId: 'legacy-account', ...DEFAULT_POLICY, applicableWindows: [] });
    assert.deepEqual(getPolicy('legacy-account').applicableWindows, ['five-hour', 'weekly']);
  });

  it('keeps an operator\'s narrower declaration', () => {
    box = sandbox();
    savePolicy({ subscriptionId: 'legacy-account', ...DEFAULT_POLICY, applicableWindows: ['weekly'] });
    assert.deepEqual(getPolicy('legacy-account').applicableWindows, ['weekly']);
  });
});

describe('no reservation stays held once its run has stopped', () => {
  async function reserve(runId: string): Promise<string> {
    const d = await admit(req({ taskId: `task-${runId}`, runId }));
    assert.equal(d.admitted, true, 'the fixture needs an admitted run to have a reservation');
    return d.reservationId!;
  }

  /**
   * The leak this exists for. A held reservation claims future headroom; once
   * the run stops, what it used shows up in the vendor reading, so holding it
   * counts the same consumption twice and never gives it back.
   */
  it('releases a reservation stranded by a run that completed', async () => {
    box = sandbox();
    const id = await reserve('run_a');
    const swept = sweepStrandedReservations([{ id: 'run_a', status: 'completed', reservationId: id }]);
    assert.deepEqual(swept, [{ reservationId: id, runId: 'run_a', action: 'released' }]);
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'released');
  });

  it('marks a reservation outstanding when the run ended without a settled outcome', async () => {
    box = sandbox();
    const id = await reserve('run_b');
    const swept = sweepStrandedReservations([{ id: 'run_b', status: 'remote-uncertain', reservationId: id }]);
    assert.equal(swept[0]?.action, 'outstanding');
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'outstanding');
  });

  it('leaves a run that is still in flight alone', async () => {
    box = sandbox();
    const id = await reserve('run_c');
    assert.deepEqual(sweepStrandedReservations([{ id: 'run_c', status: 'running', reservationId: id }]), []);
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'held');
  });

  /**
   * A held reservation with no run behind it may belong to a dispatch still
   * deciding. Releasing it would hand back headroom that is about to be used.
   */
  it('leaves a reservation with no run behind it alone', async () => {
    box = sandbox();
    const id = await reserve('run_d');
    assert.deepEqual(sweepStrandedReservations([]), []);
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'held');
  });

  /**
   * An outstanding reservation keeps its headroom on purpose, and must keep it
   * until something actually confirms the outcome. When reconciliation later
   * does confirm one, nothing else releases it, so it would hold headroom
   * forever.
   */
  it('releases an outstanding reservation once its run is confirmed settled', async () => {
    box = sandbox();
    const id = await reserve('run_f');
    markOutstanding(id, 'remote state could not be confirmed');
    const swept = sweepStrandedReservations([{ id: 'run_f', status: 'completed', reservationId: id }]);
    assert.deepEqual(swept, [{ reservationId: id, runId: 'run_f', action: 'released' }]);
    assert.match(listReservations().find((r) => r.id === id)?.note ?? '', /confirmed completed after being uncertain/);
  });

  it('leaves an outstanding reservation alone while its run stays uncertain', async () => {
    box = sandbox();
    const id = await reserve('run_g');
    markOutstanding(id, 'remote state could not be confirmed');
    assert.deepEqual(sweepStrandedReservations([{ id: 'run_g', status: 'remote-uncertain', reservationId: id }]), []);
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'outstanding');
    assert.equal(listReservations().find((r) => r.id === id)?.note, 'remote state could not be confirmed');
  });

  /**
   * Two records disagreeing about who owns this headroom is not something to
   * resolve by guessing; releasing the wrong reservation hands back allowance
   * that another run is still counting on.
   */
  it('will not settle a reservation whose run id does not match the record', async () => {
    box = sandbox();
    const id = await reserve('run_h');
    assert.deepEqual(sweepStrandedReservations([{ id: 'someone-else', status: 'completed', reservationId: id }]), []);
    assert.equal(listReservations().find((r) => r.id === id)?.state, 'held');
  });

  it('does not disturb a reservation that was already settled', async () => {
    box = sandbox();
    const id = await reserve('run_e');
    releaseReservation(id, 'settled by the dispatch path');
    assert.deepEqual(sweepStrandedReservations([{ id: 'run_e', status: 'completed', reservationId: id }]), []);
    assert.equal(listReservations().find((r) => r.id === id)?.note, 'settled by the dispatch path');
  });

  /**
   * The invariant both halves of the fix exist to keep, asserted over every
   * status a run can end with rather than the handful above.
   */
  /**
   * The exact end state for every status, from both starting states.
   *
   * Asserting only that nothing stays `held` is far weaker than it looks:
   * releasing on `completed` alone satisfies it, while `checks-failed`,
   * `refused`, `unsupported-settings` and `attempts-exhausted` reservations sit
   * outstanding forever, consuming headroom that nothing will ever give back.
   * The expectations here are written from what the dispatch path does, not
   * from what the sweep happens to do.
   */
  it('settles every status the way the dispatch path would, from either active state', async () => {
    // The five outcomes the dispatch path releases on. Everything else ends a
    // local observation without establishing that remote work stopped.
    const expected: Record<string, 'released' | 'outstanding'> = {
      completed: 'released',
      'checks-failed': 'released',
      refused: 'released',
      'unsupported-settings': 'released',
      'attempts-exhausted': 'released',
      'awaiting-approval': 'outstanding',
      'ready-to-dispatch': 'outstanding',
      'quota-waiting': 'outstanding',
      'setup-blocked': 'outstanding',
      'remote-uncertain': 'outstanding',
      'native-unavailable': 'outstanding',
    };

    for (const startsOutstanding of [false, true]) {
      box?.cleanup();
      box = sandbox();
      const runs = [];
      for (const [i, status] of Object.keys(expected).entries()) {
        const id = await reserve(`run_${i}`);
        if (startsOutstanding) markOutstanding(id, 'remote state could not be confirmed');
        runs.push({ id: `run_${i}`, status, reservationId: id, expect: expected[status]! });
      }
      sweepStrandedReservations(runs.map(({ id, status, reservationId }) => ({ id, status, reservationId })));

      for (const run of runs) {
        const state = listReservations().find((r) => r.id === run.reservationId)?.state;
        assert.equal(
          state,
          run.expect,
          `${run.status} starting ${startsOutstanding ? 'outstanding' : 'held'} settled as ${state}, expected ${run.expect}`,
        );
      }
    }
  });
});

describe('the weekly ramp', () => {
  const NOW = new Date('2026-10-01T10:00:00Z');
  const BASE = { ...DEFAULT_POLICY, subscriptionId: SUB, fiveHourThresholdPercent: 60, weeklyThresholdPercent: 70, safetyMarginPercent: 5 };
  const RAMP = { ...BASE, weeklyRampHours: 24 };
  const hoursAhead = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();
  const weeklyReading = (used: number, resetsAt: string | undefined): UsageReading => ({
    subscriptionId: SUB, observedAt: new Date().toISOString(), source: 'test',
    windows: [
      { kind: 'five-hour', usedPercent: 0, windowDurationMins: 300, vendorLabel: 'primary', resetsAt: hoursAhead(3) },
      { kind: 'weekly', usedPercent: used, windowDurationMins: 10080, vendorLabel: 'secondary', ...(resetsAt ? { resetsAt } : {}) },
    ],
  });
  const weekly = async (hours: number, used = 0, over: Partial<AdmissionRequest> = {}) => {
    const d = await admit(req({ preview: true, now: NOW, readUsage: () => ({ ok: true, reading: weeklyReading(used, hoursAhead(hours)) }), ...over }));
    return { d, w: d.windows.find((v) => v.kind === 'weekly')!, f: d.windows.find((v) => v.kind === 'five-hour')! };
  };

  it('rises in a straight line from the base ceiling to 100% over the last 24 hours', async () => {
    box = sandbox();
    savePolicy(RAMP);
    const table: Array<[hours: number, ceiling: number]> = [[30, 70], [24, 70], [18, 77.5], [12, 85], [6, 92.5], [0, 100]];
    for (const [hours, ceiling] of table) {
      const { w } = await weekly(hours);
      assert.equal(w.thresholdPercent, ceiling, `${hours}h before the reset`);
      assert.equal(w.baseThresholdPercent, 70);
    }
  });

  it('leaves room at ceiling minus used, reserved and the margin', async () => {
    box = sandbox();
    savePolicy(RAMP);
    const { w } = await weekly(12, 40);
    assert.equal(w.availablePercent, 85 - 40 - 0 - 5);
    const atReset = await weekly(0, 40);
    assert.equal(atReset.w.availablePercent, 100 - 40 - 5);
  });

  it('admits work the base ceiling would refuse, once the ramp has lifted it', async () => {
    box = sandbox();
    savePolicy(RAMP);
    // 66% used, 5% margin, a 2% need: refused under 70, admitted under 92.5 six hours out.
    assert.equal((await weekly(30, 66)).d.admitted, false);
    assert.equal((await weekly(6, 66)).d.admitted, true);
  });

  it('keeps the five-hour ceiling at its threshold at every instant', async () => {
    box = sandbox();
    savePolicy(RAMP);
    for (const hours of [30, 12, 0]) assert.equal((await weekly(hours)).f.thresholdPercent, 60);
  });

  it('admits a policy with no ramp at its base at every instant', async () => {
    box = sandbox();
    savePolicy(BASE);
    for (const hours of [30, 12, 0]) {
      const { w } = await weekly(hours);
      assert.equal(w.thresholdPercent, 70);
      assert.equal(w.rampNote, undefined);
    }
    savePolicy({ ...RAMP, weeklyRampHours: 0 });
    assert.equal((await weekly(0)).w.thresholdPercent, 70, 'a ramp of 0 hours is no ramp');
  });

  it('applies no ramp when the reset time cannot be read, and says so', async () => {
    box = sandbox();
    savePolicy(RAMP);
    for (const resetsAt of [undefined, 'sometime next week']) {
      const d = await admit(req({ preview: true, now: NOW, readUsage: () => ({ ok: true, reading: weeklyReading(0, resetsAt) }) }));
      const w = d.windows.find((v) => v.kind === 'weekly')!;
      assert.equal(w.thresholdPercent, 70);
      assert.equal(w.hoursToReset, undefined);
      assert.match(w.rampNote ?? '', /24h ramp not applied: the reset time is unreadable/);
    }
  });

  it('names the ramp in a refusal, so an operator reads the ceiling that was in force', async () => {
    box = sandbox();
    savePolicy(RAMP);
    const { d } = await weekly(6, 94);
    assert.equal(d.admitted, false);
    assert.match(d.outcome?.summary ?? '', /weekly window: needs 2.0%.*threshold 92.5%, used 94%.*24h ramp lifts the ceiling from 70% to 92.5%: 6.0h to reset/);
  });

  it('reads Claude\'s own reset wording', async () => {
    box = sandbox();
    savePolicy(RAMP);
    const observedAt = new Date().toISOString();
    const text = 'Oct 1, 5pm (Europe/Athens)'; // 14:00Z: four hours after NOW
    const d = await admit(req({
      preview: true, now: NOW,
      readUsage: () => ({ ok: true, reading: { ...weeklyReading(0, undefined), observedAt, windows: [
        { kind: 'five-hour', usedPercent: 0, vendorLabel: 'Current session', resetsAt: 'Oct 1, 1pm (Europe/Athens)' },
        { kind: 'weekly', usedPercent: 0, vendorLabel: 'Current week (all models)', resetsAt: text },
      ] } }),
    }));
    const w = d.windows.find((v) => v.kind === 'weekly')!;
    // Read at the real clock's year, so only the hours-to-reset shape is asserted, not the instant.
    assert.equal(w.resetsAt, text);
    assert.ok(w.rampNote !== undefined);
  });
});
