import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  attachRun, dischargeObligations, getJob, listJobs, mayDispatchAgain,
  reconcileUnsettled, submitJob,
} from './intake.js';
import type { Reconciler, SubmitInput } from './intake.js';
import type { Outcome } from './outcome.js';
import { getRun, saveRun } from './run.js';
import type { RunRecord } from './run.js';
import { sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const submission = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  idempotencyKey: 'github-actions:run/12345',
  taskId: 'task_ci_1',
  repo: 'mocraimer/agent-system',
  workClass: 'ci-repair',
  runtime: 'pi-local',
  obligations: ['unit', 'review'],
  ...over,
});

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_1',
    taskId: 'task_ci_1',
    attempt: 1,
    authority: { type: 'approval', id: 'apv_1', version: 1 },
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
    runtime: 'pi-local',
    profile: 'default',
    actions: ['author-changes'],
    settings: {
      requested: { model: 'm', effort: 'high' },
      resolved: { model: 'm', effort: 'high' },
      observed: { model: 'unknown', effort: 'unknown' },
    },
    startedAt: new Date().toISOString(),
    status: 'running',
    evidenceDir: '/state/evidence/run_1',
    ...over,
  };
}

describe('duplicate delivery', () => {
  it('does not create a second job for the same event', () => {
    box = sandbox();
    const first = submitJob(submission());
    const second = submitJob(submission());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(listJobs().length, 1, 'one CI failure must not become two repair jobs');
  });

  it('counts the duplicates rather than discarding them silently', () => {
    box = sandbox();
    submitJob(submission());
    submitJob(submission());
    submitJob(submission());
    assert.equal(listJobs()[0]?.duplicateSubmissions, 2);
  });

  it('treats a different event as different work', () => {
    box = sandbox();
    submitJob(submission());
    submitJob(submission({ idempotencyKey: 'github-actions:run/99999', taskId: 'task_ci_2' }));
    assert.equal(listJobs().length, 2);
  });
});

describe('a job keeps its obligations and artifacts across attempts', () => {
  it('accumulates artifacts instead of replacing them', () => {
    box = sandbox();
    const { job } = submitJob(submission());
    attachRun(job.id, run({ id: 'run_1', evidenceDir: '/state/evidence/run_1' }));
    const after = attachRun(job.id, run({ id: 'run_2', evidenceDir: '/state/evidence/run_2' }));
    assert.deepEqual(after.runIds, ['run_1', 'run_2']);
    assert.deepEqual(after.artifacts, ['/state/evidence/run_1', '/state/evidence/run_2']);
  });

  it('settles only when nothing is outstanding', () => {
    box = sandbox();
    const { job } = submitJob(submission());
    const partial = dischargeObligations(job.id, ['unit']);
    assert.deepEqual(partial.outstandingObligations, ['review']);
    assert.equal(partial.state, 'open');
    const full = dischargeObligations(job.id, ['review']);
    assert.equal(full.state, 'settled');
  });

  it('a later attempt cannot shorten the approved obligations', () => {
    box = sandbox();
    const { job } = submitJob(submission());
    // Discharging something never owed changes nothing.
    const after = dischargeObligations(job.id, ['some-check-nobody-required']);
    assert.deepEqual(after.outstandingObligations, ['unit', 'review']);
    assert.equal(after.state, 'open');
  });
});

describe('restart reconciliation', () => {
  const reconciler = (outcome: Outcome): Reconciler => ({
    runtime: 'pi-local',
    reconcile: () => Promise.resolve(outcome),
  });

  it('leaves a run on another runtime alone when the caller scoped the reconcile', async () => {
    // Reporting "no reconciler for runtime claude-web" answered a question nobody
    // put: the run was scoped out, not asked about and found unknowable.
    box = sandbox();
    saveRun(run({ id: 'run_pi', status: 'running', sessionId: 'sess_pi' }));
    saveRun(run({ id: 'run_web', runtime: 'claude-web', status: 'remote-uncertain', sessionId: 'sess_web' }));

    const reports = await reconcileUnsettled(
      [reconciler({ kind: 'completed', summary: 'done', nextAction: 'review it' })],
      'pi-local',
    );

    assert.deepEqual(reports.map((r) => r.runId), ['run_pi']);
  });

  it('reconciles every unsettled run when no runtime is named', async () => {
    box = sandbox();
    saveRun(run({ id: 'run_pi', status: 'running', sessionId: 'sess_pi' }));
    saveRun(run({ id: 'run_web', runtime: 'claude-web', status: 'remote-uncertain', sessionId: 'sess_web' }));

    const reports = await reconcileUnsettled([
      reconciler({ kind: 'completed', summary: 'done', nextAction: 'review it' }),
      { runtime: 'claude-web', reconcile: () => Promise.resolve({ kind: 'completed' as const, summary: 'done', nextAction: 'review it' }) },
    ]);

    assert.deepEqual(reports.map((r) => r.runId).sort(), ['run_pi', 'run_web']);
  });

  it('turns a throwing reconciler into an outstanding report, not an exception', async () => {
    // Dispatch reconciles every runtime, so an unreachable vendor on one runtime
    // must not abort a dispatch aimed at another with a raw error naming the wrong one.
    box = sandbox();
    saveRun(run({ status: 'running', sessionId: 'sess_1' }));

    const reports = await reconcileUnsettled([
      { runtime: 'pi-local', reconcile: () => Promise.reject(new Error('app-server unreachable')) },
    ]);

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.outcome.kind, 'remote-uncertain');
    assert.match(reports[0]?.outcome.summary ?? '', /app-server unreachable/);
    assert.equal(reports[0]?.blocksNewAttempt, true, 'no answer is not a report that the work stopped');
  });

  it('settles a run the vendor reports finished', async () => {
    box = sandbox();
    saveRun(run({ status: 'running', sessionId: 'sess_1' }));
    const reports = await reconcileUnsettled([
      reconciler({ kind: 'completed', summary: 'done', nextAction: 'review it' }),
    ]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.blocksNewAttempt, false);
  });

  it('passes the run evidence directory to reconciliation', async () => {
    box = sandbox();
    const stored = run({ status: 'running', sessionId: 'sess_evidence', evidenceDir: '/evidence/run_1' });
    saveRun(stored);
    let received: { sessionId: string | undefined; evidenceDir: string | undefined } = {
      sessionId: undefined,
      evidenceDir: undefined,
    };
    const reports = await reconcileUnsettled([{
      runtime: 'pi-local',
      reconcile: (sessionId, evidenceDir) => {
        received = { sessionId, evidenceDir };
        return Promise.resolve({ kind: 'completed' as const, summary: 'done', nextAction: 'review it' });
      },
    }]);
    assert.equal(reports[0]?.blocksNewAttempt, false);
    assert.deepEqual(received, { sessionId: 'sess_evidence', evidenceDir: '/evidence/run_1' });
  });

  it('keeps blocking while the vendor is unsure', async () => {
    box = sandbox();
    saveRun(run({ status: 'running', sessionId: 'sess_1' }));
    const reports = await reconcileUnsettled([
      reconciler({ kind: 'remote-uncertain', summary: 'still listed', nextAction: 'check it' }),
    ]);
    assert.equal(reports[0]?.blocksNewAttempt, true);
  });

  for (const kind of ['completed', 'checks-failed'] as const) {
    it(`reports a concurrent ${kind} recovery instead of a late uncertain answer`, async () => {
      box = sandbox();
      const { job } = submitJob(submission());
      const initial = run({ status: 'remote-uncertain', sessionId: 'sess_1' });
      saveRun(initial);
      attachRun(job.id, initial);
      let calls = 0;
      let answerFirst!: (outcome: Outcome) => void;
      let answerSecond!: (outcome: Outcome) => void;
      const delayed: Reconciler = {
        runtime: 'pi-local',
        reconcile: () => new Promise<Outcome>((resolve) => {
          if (++calls === 1) answerFirst = resolve;
          else answerSecond = resolve;
        }),
      };

      const first = reconcileUnsettled([delayed]);
      const second = reconcileUnsettled([delayed]);
      assert.equal(calls, 2, 'both recoveries read the unsettled run before either answers');
      answerFirst({ kind, summary: 'first recovery settled the run', nextAction: 'review evidence',
        ...(kind === 'checks-failed' ? { promptNotSent: true as const } : {}) });
      const firstReports = await first;
      assert.equal(firstReports[0]?.outcome.kind, kind);
      const settledRun = getRun(initial.id);
      assert.equal(settledRun?.status, kind);

      answerSecond({ kind: 'remote-uncertain', summary: 'stale uncertain answer', nextAction: 'check again' });
      const lateReports = await second;
      assert.deepEqual(getRun(initial.id), settledRun, 'the late answer must not change the stored terminal run');
      assert.equal(lateReports[0]?.outcome.kind, kind);
      assert.equal(lateReports[0]?.outcome.summary, settledRun?.summary);
      assert.equal(lateReports[0]?.outcome.promptNotSent, kind === 'checks-failed' ? true : undefined);
      assert.equal(lateReports[0]?.blocksNewAttempt, false);
      assert.equal(mayDispatchAgain(job.id, lateReports), undefined);
    });
  }

  it('does not claim a missing run settled when a late vendor answer arrives', async () => {
    box = sandbox();
    saveRun(run({ sessionId: 'sess_1' }));
    let answer!: (outcome: Outcome) => void;
    const recovery = reconcileUnsettled([{
      runtime: 'pi-local',
      reconcile: () => new Promise<Outcome>((resolve) => { answer = resolve; }),
    }]);
    unlinkSync(join(box.root, 'runs', 'run_1.json'));
    answer({ kind: 'completed', summary: 'vendor says done', nextAction: 'review evidence' });
    const reports = await recovery;
    assert.equal(getRun('run_1'), undefined);
    assert.equal(reports[0]?.outcome.kind, 'remote-uncertain');
    assert.equal(reports[0]?.blocksNewAttempt, true);
  });

  it('blocks hardest when contact was lost before a session id came back', async () => {
    box = sandbox();
    // The worst case: work may exist remotely under an id we never learned.
    saveRun(run({ status: 'running' }));
    const reports = await reconcileUnsettled([
      reconciler({ kind: 'completed', summary: 'unused', nextAction: 'unused' }),
    ]);
    assert.equal(reports[0]?.blocksNewAttempt, true);
    assert.match(reports[0]?.outcome.summary ?? '', /no session id/);
  });

  it('does not assume a run died just because this process did', async () => {
    box = sandbox();
    saveRun(run({ status: 'running', sessionId: 'sess_1' }));
    const reports = await reconcileUnsettled([]); // no reconciler for that runtime
    assert.equal(reports[0]?.blocksNewAttempt, true);
    assert.equal(reports[0]?.outcome.kind, 'remote-uncertain');
  });

  it('refuses a second attempt while an earlier run is unaccounted for', async () => {
    box = sandbox();
    const { job } = submitJob(submission());
    saveRun(run({ id: 'run_1', status: 'running', sessionId: 'sess_1' }));
    attachRun(job.id, run({ id: 'run_1' }));
    const reports = await reconcileUnsettled([
      reconciler({ kind: 'remote-uncertain', summary: 'vendor cannot confirm', nextAction: 'check' }),
    ]);
    const verdict = mayDispatchAgain(job.id, reports);
    assert.ok(verdict, 'a second worker must not launch');
    assert.match(verdict.nextAction, /how one task becomes two/);
  });

  it('allows a second attempt once the earlier run is settled', async () => {
    box = sandbox();
    const { job } = submitJob(submission());
    saveRun(run({ id: 'run_1', status: 'running', sessionId: 'sess_1' }));
    attachRun(job.id, run({ id: 'run_1' }));
    const reports = await reconcileUnsettled([
      reconciler({ kind: 'checks-failed', summary: 'tests failed', nextAction: 'repair' }),
    ]);
    assert.equal(mayDispatchAgain(job.id, reports), undefined);
  });

  it('survives a restart, because jobs and runs are on disk', () => {
    box = sandbox();
    const { job } = submitJob(submission());
    // A restart is new process state over the same directory.
    assert.equal(getJob(job.id)?.idempotencyKey, 'github-actions:run/12345');
    assert.equal(submitJob(submission()).created, false, 'the key index survives too');
  });
});
