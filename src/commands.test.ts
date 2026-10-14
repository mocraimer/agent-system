import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { ApprovalInput, RuntimeId } from './core/authority.js';
import type { UsageResult } from './core/usage.js';
import type { DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities } from './adapters/types.js';
import type { DispatchTaskInput, EvaluationInput } from './commands.js';
import type { OutcomeKind } from './core/outcome.js';
import { resolveSettings, snapshot, UnsupportedSettingError } from './adapters/types.js';
import { PiAdapter, PiEvidenceError, PiTeardownError, PI_CAPABILITIES, processGroupAbsent } from './adapters/pi.js';
import { admit, listReservations } from './core/admission.js';
import { submitJob } from './core/intake.js';
import { AGENT_ACTOR, OPERATOR, sandbox } from './core/testkit.js';
import {
  createCoordinatorCommands, DISPATCH_REQUEST_FILE, policyView, recoverUnsettled, statusView,
} from './commands.js';
import { getScorecard, listScorecards, recordLoop, saveScorecard } from './eval/scorecard.js';
import type { Scorecard } from './eval/scorecard.js';
import { getRun, saveRun } from './core/run.js';
import { loadedBuild } from './core/build.js';
import { readOutput } from './loop/context.js';
import { attestDelivery } from './loop/attest.js';
import { FakeStore, SHA } from './loop/testkit.js';

const REPO = 'example/consumer';
const CAPS: RuntimeCapabilities = {
  runtime: 'pi-local',
  subscriptionId: 'test-subscription',
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['low', 'high'],
  reportsEffectiveSettings: true,
  acceptsCallerSessionId: true,
  skillInvocationForm: '/skill:auto <task>',
};

function reading(): UsageResult {
  return {
    ok: true,
    reading: {
      subscriptionId: CAPS.subscriptionId,
      observedAt: new Date().toISOString(),
      source: 'test adapter',
      windows: [
        { kind: 'five-hour', usedPercent: 1, vendorLabel: 'five-hour' },
        { kind: 'weekly', usedPercent: 1, vendorLabel: 'weekly' },
      ],
    },
  };
}

class FakeAdapter implements RuntimeAdapter {
  readonly capabilities = CAPS;
  usageCalls = 0;
  dispatchCalls = 0;
  reconcileCalls = 0;
  usageResult: UsageResult = reading();
  dispatchError?: Error;

  /**
   * A session id on the dispatch result, when the case needs one.
   *
   * Reconciliation skips a run without one, on the grounds that contact was lost
   * before the vendor acknowledged it. A test that omits it never reaches the
   * reconciler at all.
   */
  sessionId?: string;

  constructor(private readonly dispatchKind: DispatchResult['outcome']['kind'] = 'completed') {}

  readUsage(): Promise<UsageResult> {
    this.usageCalls++;
    return Promise.resolve(this.usageResult);
  }

  checkReadiness() {
    return Promise.resolve(undefined);
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.dispatchCalls++;
    if (this.dispatchError) return Promise.reject(this.dispatchError);
    return Promise.resolve({
      outcome: {
        kind: this.dispatchKind,
        taskId: input.taskId,
        runId: input.runId,
        summary: this.dispatchKind === 'remote-uncertain' ? 'fake session remains uncertain' : 'fake run settled',
        nextAction: 'Review the retained evidence.',
      },
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      settings: {
        requested: {
          model: input.settings.model ?? 'vendor-default',
          effort: input.settings.effort ?? 'vendor-default',
        },
        resolved: {
          model: input.settings.model ?? 'fake-model',
          effort: input.settings.effort ?? 'high',
        },
        observed: {
          model: input.settings.model ?? 'fake-model',
          effort: input.settings.effort ?? 'high',
        },
      },
    });
  }

  /** What reconciliation reports a previously uncertain session turned out to be. */
  reconcileKind: DispatchResult['outcome']['kind'] = 'remote-uncertain';
  reconcileEvidenceDir: string | undefined;

  reconcile(_sessionId?: string, evidenceDir?: string): Promise<DispatchResult['outcome']> {
    this.reconcileCalls++;
    this.reconcileEvidenceDir = evidenceDir;
    return Promise.resolve({
      kind: this.reconcileKind,
      summary: this.reconcileKind === 'remote-uncertain'
        ? 'fake session remains uncertain'
        : 'fake session turned out to have finished',
      nextAction: 'Inspect the fake session before retrying.',
    });
  }
}

function input(overrides: Partial<DispatchTaskInput> = {}): DispatchTaskInput {
  return {
    taskId: 'task_1',
    repo: REPO,
    workClass: 'ci-repair',
    runtime: 'pi-local' as const,
    profile: 'default',
    actions: ['author-changes'],
    prompt: 'run the bounded test task',
    settings: {},
    estimate: {
      fiveHourPercent: 1,
      weeklyPercent: 1,
      basis: 'operator-bound' as const,
      uncertaintyPercent: 1,
      detail: 'test bound',
    },
    ...overrides,
  };
}

function approveTestDispatch(layer: ReturnType<typeof createCoordinatorCommands>): string {
  return layer.approve(OPERATOR, {
    repo: REPO,
    taskScope: 'run the bounded test task',
    workClass: 'ci-repair',
    runtime: 'pi-local',
    profile: 'default',
    actions: ['author-changes'],
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
  }).id;
}

function approveReplayDispatch(layer: ReturnType<typeof createCoordinatorCommands>): string {
  return layer.approve(OPERATOR, {
    repo: REPO,
    taskScope: 'replay a review',
    workClass: 'replay-review',
    runtime: 'pi-local',
    profile: 'default',
    actions: ['review'],
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
  }).id;
}

describe('the shared command layer', () => {
  it('reports every recorded terminal state without requiring completion-time loop metadata', async () => {
    const states: OutcomeKind[] = ['completed', 'refused', 'awaiting-approval', 'ready-to-dispatch', 'quota-waiting', 'attempts-exhausted', 'unsupported-settings', 'setup-blocked', 'remote-uncertain', 'native-unavailable', 'checks-failed'];
    for (const status of states) {
      const s = sandbox();
      try {
        const layer = createCoordinatorCommands(() => new FakeAdapter(status));
        const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
        assert.equal(result.run?.status, status);
        const report = layer.evaluation({ view: 'scorecards', repo: REPO });
        if (report.view !== 'scorecards') assert.fail('wrong report');
        assert.equal(report.report.attemptCounts.recorded, 1, status);
        assert.equal(report.report.attemptCounts.byStatus[status], 1, status);
        assert.equal(report.report.attemptCounts.delivered, 0, 'no artifact was verified');
        assert.equal(report.report.recordedAttempts[0]?.loop, undefined, 'absence of loop metadata does not exclude an attempt');
        const legacy = { ...result.run! };
        delete legacy.build; delete legacy.runtimeDispatched; delete legacy.delivery; delete legacy.timing;
        saveRun(legacy);
        assert.equal(layer.status().runs[0]?.run.build, undefined, 'old identity is not backfilled');
        const old = layer.evaluation({ view: 'scorecards' });
        if (old.view !== 'scorecards') assert.fail('wrong report');
        assert.equal(old.report.attemptCounts.dispatchUnknown, 1);
        assert.equal(old.report.attemptCounts.delivered, 0);
      } finally { s.cleanup(); }
    }
  });

  it('retains interrupted output through recovery and redispatch without losing reservation ownership or provenance', async () => {
    const s = sandbox();
    try {
      class WritingAdapter extends FakeAdapter {
        override async dispatch(request: DispatchInput): Promise<DispatchResult> {
          const run = getRun(request.runId)!;
          assert.equal(run.runtimeDispatched, true);
          assert.deepEqual(run.build, loadedBuild);
          assert.equal(getScorecard('card_task_1')?.loop?.stage, 'review', 'failure cohort exists before the provider returns');
          assert.ok(run.timing?.dispatchStartedAt);
          assert.match(request.task, new RegExp(request.runId));
          writeFileSync(run.outputPath!, this.dispatchCalls === 0 ? 'partial draft' : 'verified review');
          const result = await super.dispatch(request);
          result.outcome.kind = this.dispatchCalls === 1 ? 'remote-uncertain' : 'completed';
          result.sessionId = `session-${request.runId}`;
          return result;
        }
      }
      const fake = new WritingAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveTestDispatch(layer);
      const placeholder = join(s.root, 'requested-output.md');
      const first = await layer.dispatch(input({ approvalId, prompt: `Write to ${placeholder}`, outputPath: placeholder, loop: { stage: 'review', item: 'PR #1', workType: 'bug', head: 'a'.repeat(40) } }));
      assert.equal(first.outcome.kind, 'remote-uncertain');
      assert.equal(first.run?.delivery?.status, 'unverified');
      assert.equal(readOutput(first.run?.outputPath, first), undefined);
      const oldReservation = listReservations().find((r) => r.runId === first.run!.id)!;
      assert.equal(oldReservation.state, 'outstanding');
      const blocked = await layer.runRedispatch(OPERATOR, first.run!.id);
      assert.equal(blocked.runtimeDispatched, false);
      assert.equal(fake.dispatchCalls, 1);
      assert.equal(listReservations().find((r) => r.id === oldReservation.id)?.state, 'outstanding');
      fake.reconcileKind = 'checks-failed';
      await layer.recover();
      const second = await layer.runRedispatch(OPERATOR, first.run!.id);
      assert.equal(second.outcome.kind, 'completed');
      assert.notEqual(second.run?.outputPath, first.run?.outputPath);
      assert.equal(readFileSync(first.run!.outputPath!, 'utf8'), 'partial draft');
      assert.equal(readFileSync(second.run!.outputPath!, 'utf8'), 'verified review');
      assert.equal(second.run?.delivery?.status, 'unverified', 'runtime completion alone never grants delivery');
      recordLoop('card_task_1', { stage: 'review', item: 'PR #1', workType: 'bug', wrote: 'comment 42' });
      assert.equal(getRun(second.run!.id)?.delivery?.status, 'delivered');
      assert.equal(getRun(first.run!.id)?.delivery?.status, 'unverified');
      const final = getRun(second.run!.id)!;
      assert.ok(final.timing?.providerEndedAt);
      assert.ok(final.timing?.adoptionEndedAt);
      assert.ok(Date.parse(final.timing!.adoptionEndedAt!) >= Date.parse(final.timing!.providerEndedAt!));
      const report = layer.evaluation({ view: 'scorecards', repo: REPO });
      assert.equal(report.view, 'scorecards');
      if (report.view === 'scorecards') {
        assert.deepEqual(report.report.recordedAttempts.map((r) => r.id).sort(), [first.run!.id, second.run!.id].sort());
        assert.equal(report.report.attemptCounts.recorded, 2);
        assert.equal(report.report.attemptCounts.delivered, 1);
        assert.equal(report.report.attemptCounts.byStatus['checks-failed'], 1);
      }
      assert.ok(listReservations().every((r) => r.state === 'released'));
    } finally { s.cleanup(); }
  });

  it('keeps an operator-attested first attempt through a real redispatch without lending its baseline to the retry', async () => {
    const s = sandbox();
    try {
      class OutputAdapter extends FakeAdapter {
        override async dispatch(request: DispatchInput): Promise<DispatchResult> {
          writeFileSync(getRun(request.runId)!.outputPath!, 'Completed fix reply.');
          return super.dispatch(request);
        }
      }
      const fake = new OutputAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveTestDispatch(layer);
      const store = new FakeStore();
      Object.defineProperty(store, 'repo', { value: REPO });
      const head = SHA('attested-retry-head');
      const pr = store.addPull({ number: 40, headRefName: 'ticket/12', headRefOid: head, baseRefName: 'dev', body: 'before' });
      const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex');
      const first = await layer.dispatch(input({ approvalId, outputPath: join(s.root, 'requested-output.md'),
        loop: { stage: 'fix', item: 'PR #40', workType: 'bug', head, round: 1,
          fixBranch: 'ticket/12', fixBase: 'dev', descriptionBeforeDigest: bodyHash('before'), reviewCommentAtDispatch: 91 } }));
      assert.equal(first.outcome.kind, 'completed');
      pr.body = 'after';
      const reason = 'I inspected this exact run and its PR description edit.';
      await attestDelivery(OPERATOR, store, { runId: first.run!.id, pr: 40, head, bodyDigest: bodyHash(pr.body), reason });
      const second = await layer.runRedispatch(OPERATOR, first.run!.id);
      assert.equal(second.outcome.kind, 'completed');
      assert.equal(second.run?.loop?.descriptionBeforeDigest, undefined, 'old baseline is not this attempt\'s observation');
      await assert.rejects(attestDelivery(OPERATOR, store, { runId: second.run!.id, pr: 40, head,
        bodyDigest: bodyHash(pr.body), reason }), /baseline digest/);
      assert.equal(getRun(first.run!.id)?.delivery?.status, 'delivered');
      assert.equal(getRun(second.run!.id)?.delivery?.status, 'unverified');
      assert.equal(getScorecard('card_task_1')?.attestedDeliveries?.[0]?.runId, first.run!.id);
      assert.equal(getScorecard('card_task_1')?.loop?.attestedDelivery, undefined,
        'the later loop record is not assigned the first run\'s attestation');
    } finally { s.cleanup(); }
  });

  it('does not carry a sweep no-PR-at-dispatch observation into a CLI retry', async () => {
    const s = sandbox();
    try {
      const layer = createCoordinatorCommands(() => new FakeAdapter());
      const first = await layer.dispatch(input({ approvalId: approveTestDispatch(layer),
        loop: { stage: 'sweep', item: '#12', workType: 'bug', sweepBase: 'dev', sweepNoPullAtDispatch: true } }));
      const retry = await layer.runRedispatch(OPERATOR, first.run!.id);
      assert.equal(retry.outcome.kind, 'completed');
      assert.equal(retry.run?.loop?.sweepNoPullAtDispatch, undefined);
    } finally { s.cleanup(); }
  });

  it('refuses a legacy loop redispatch rather than overwriting its first output', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer), loop: { stage: 'review', item: 'PR #1', workType: 'bug' } }));
      const oldOutput = join(s.root, 'out', 'loop-review-pr1.md');
      mkdirSync(dirname(oldOutput), { recursive: true });
      writeFileSync(oldOutput, 'first attempt survives');
      const requestPath = join(result.run!.evidenceDir!, DISPATCH_REQUEST_FILE);
      const request = JSON.parse(readFileSync(requestPath, 'utf8')) as DispatchTaskInput;
      // Literal pre-upgrade shape: it had a loop-* workClass, but neither
      // attempt metadata nor an outputPath in the persisted dispatch request.
      request.workClass = 'loop-review';
      delete request.loop;
      delete request.outputPath;
      request.prompt = `Write the review to ${oldOutput}`;
      writeFileSync(requestPath, JSON.stringify(request));
      const before = fake.dispatchCalls;
      await assert.rejects(layer.runRedispatch(OPERATOR, result.run!.id), /predates attempt-owned output paths/);
      assert.equal(fake.dispatchCalls, before);
      assert.equal(readFileSync(oldOutput, 'utf8'), 'first attempt survives');
    } finally { s.cleanup(); }
  });

  it('refuses a literal pre-upgrade replay-review request that names a shared output', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveReplayDispatch(layer);
      const sharedOutput = join(s.root, 'out', 'replay-review.md');
      const first = await layer.dispatch(input({ approvalId, workClass: 'replay-review', actions: ['review'],
        prompt: `Write the review to ${sharedOutput}`, outputPath: sharedOutput }));
      assert.equal(first.outcome.kind, 'completed');
      mkdirSync(dirname(sharedOutput), { recursive: true });
      writeFileSync(sharedOutput, 'original replay evidence');
      // Saved-request format from before replay dispatch supplied outputPath.
      const oldSavedRequest: DispatchTaskInput = {
        taskId: 'task_1', repo: REPO, workClass: 'replay-review', runtime: 'pi-local',
        profile: 'default', actions: ['review'], approvalId,
        prompt: `Write the review to ${sharedOutput}`, settings: {},
        estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound',
          uncertaintyPercent: 1, detail: 'test bound' },
      };
      writeFileSync(join(first.run!.evidenceDir!, DISPATCH_REQUEST_FILE), JSON.stringify(oldSavedRequest));
      const before = fake.dispatchCalls;
      await assert.rejects(layer.runRedispatch(OPERATOR, first.run!.id), /predates attempt-owned output paths/);
      assert.equal(fake.dispatchCalls, before);
      assert.equal(readFileSync(sharedOutput, 'utf8'), 'original replay evidence');
    } finally { s.cleanup(); }
  });

  it('keeps a current replay-review retry isolated and starts its setup clock anew', async () => {
    const s = sandbox();
    try {
      const receivedPrompts: string[] = [];
      class WritingAdapter extends FakeAdapter {
        override dispatch(input: DispatchInput): Promise<DispatchResult> {
          receivedPrompts.push(input.task);
          const output = join(input.evidenceDir, 'output.md');
          assert.ok(input.task.includes(output), 'the adapter receives its own attempt output path');
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, `evidence for ${input.runId}`);
          return super.dispatch(input);
        }
      }
      const fake = new WritingAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveReplayDispatch(layer);
      const requestedOutput = join(s.root, 'out', 'replay-review.md');
      const setupStartedAt = '2020-01-01T00:00:00.000Z';
      const first = await layer.dispatch(input({ approvalId, workClass: 'replay-review', actions: ['review'],
        prompt: `Write the review to ${requestedOutput}`, outputPath: requestedOutput, setupStartedAt }));
      assert.equal(first.run?.timing?.setupStartedAt, setupStartedAt);
      writeFileSync(first.run!.outputPath!, 'first replay evidence');
      const second = await layer.runRedispatch(OPERATOR, first.run!.id);
      assert.equal(second.outcome.kind, 'completed');
      assert.equal(fake.dispatchCalls, 2);
      assert.notEqual(second.run?.outputPath, first.run?.outputPath);
      assert.equal(receivedPrompts.length, 2);
      assert.ok(receivedPrompts[1]!.includes(second.run!.outputPath!));
      assert.ok(!receivedPrompts[1]!.includes(first.run!.outputPath!));
      assert.equal(readFileSync(second.run!.outputPath!, 'utf8'), `evidence for ${second.run!.id}`);
      assert.equal(readFileSync(first.run!.outputPath!, 'utf8'), 'first replay evidence');
      assert.ok(Date.parse(second.run!.timing!.setupStartedAt!) > Date.parse(setupStartedAt));
      assert.equal(getRun(first.run!.id)?.timing?.setupStartedAt, setupStartedAt);
      const saved = JSON.parse(readFileSync(join(second.run!.evidenceDir!, DISPATCH_REQUEST_FILE), 'utf8')) as DispatchTaskInput;
      assert.equal(saved.setupStartedAt, undefined, 'the next retry must not inherit this attempt\'s setup clock');
      assert.match(saved.prompt, new RegExp(second.run!.id));
    } finally { s.cleanup(); }
  });

  it('records the prompt template and its digest on the run and the scorecard, and keeps the request for a redispatch', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const promptVersion = { template: 'review', digest: 'a'.repeat(64) };
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer), entry: 'prompt', promptVersion }));
      assert.deepEqual(result.run?.settings.prompt, promptVersion);
      assert.deepEqual(getScorecard('card_task_1')?.settings.prompt, promptVersion);
      const saved = JSON.parse(readFileSync(join(result.run!.evidenceDir!, DISPATCH_REQUEST_FILE), 'utf8')) as DispatchTaskInput;
      assert.equal(saved.prompt, 'run the bounded test task');
      assert.deepEqual(saved.promptVersion, promptVersion);
    } finally {
      s.cleanup();
    }
  });

  it('records a session id the adapter names before the run starts, so a lost run can be reconciled', async () => {
    const s = sandbox();
    try {
      class NamingAdapter extends FakeAdapter {
        seenInFlight: string | undefined;
        seenInput: string | undefined;
        newSessionId(): string {
          return 'session-named-up-front';
        }
        override dispatch(dispatchInput: DispatchInput): Promise<DispatchResult> {
          this.seenInFlight = statusView().runs[0]?.run.sessionId;
          this.seenInput = dispatchInput.sessionId;
          return super.dispatch(dispatchInput);
        }
      }
      const fake = new NamingAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      await layer.dispatch(input({ approvalId: approveTestDispatch(layer), entry: 'prompt' }));
      assert.equal(fake.seenInFlight, 'session-named-up-front', 'the durable in-flight record carries it');
      assert.equal(fake.seenInput, 'session-named-up-front', 'the adapter is told to use it');
    } finally {
      s.cleanup();
    }
  });

  it('does not call an adapter or mutate state for a pending dispatch', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const result = await layer.dispatch(input());

      assert.equal(result.outcome.kind, 'awaiting-approval');
      assert.equal(fake.usageCalls, 0, 'authority must be checked before admission');
      assert.equal(fake.dispatchCalls, 0, 'pending work must not reach a runtime');
      assert.deepEqual(layer.status().runs, []);
      assert.deepEqual(layer.approvalList(), []);
    } finally {
      s.cleanup();
    }
  });

  it('uses one typed path for approval, recovery, admission and adapter dispatch', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approvalInput: ApprovalInput = {
        repo: REPO,
        taskScope: 'run the bounded test task',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      };
      const approval = layer.approve(OPERATOR, approvalInput);
      const result = await layer.dispatch(input({ approvalId: approval.id }));

      assert.equal(result.outcome.kind, 'completed');
      assert.equal(result.runtimeDispatched, true);
      assert.equal(result.authority?.id, approval.id);
      assert.equal(result.run?.status, 'completed');
      assert.equal(fake.usageCalls, 1);
      assert.equal(fake.dispatchCalls, 1);
      assert.ok(result.admission?.reservationId);
      const reservation = layer.status().reservations.find((r) => r.id === result.admission?.reservationId);
      assert.equal(reservation?.state, 'released', 'a completed run must hold no future headroom');
      assert.ok(reservation?.releasedAt);
      assert.match(reservation?.note ?? '', /completed/);
      assert.equal(layer.status({ taskId: 'task_1' }).runs.length, 1);
      const card = listScorecards()[0];
      assert.equal(card?.finalStatus, 'completed');
      assert.equal(card?.usage.deltaContaminated, true);
      assert.deepEqual(card?.blockers, []);
    } finally {
      s.cleanup();
    }
  });

  it('persists a quota refusal without dispatching or consuming an attempt', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      fake.usageResult = {
        ok: false,
        unavailable: {
          subscriptionId: CAPS.subscriptionId,
          attemptedAt: new Date().toISOString(),
          source: 'test adapter',
          reason: 'subscription usage is unavailable',
          operatorAction: 'Refresh usage, then retry.',
        },
      };
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'run the bounded test task',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });

      const refused = await layer.dispatch(input({ taskId: 'quota_task', approvalId: approval.id }));
      assert.equal(refused.outcome.kind, 'quota-waiting');
      assert.equal(refused.runtimeDispatched, false);
      assert.equal(refused.run?.status, 'quota-waiting');
      assert.equal(fake.usageCalls, 1);
      assert.equal(fake.dispatchCalls, 0, 'a pre-dispatch quota refusal must not reach the runtime');
      assert.equal(fake.reconcileCalls, 0);
      const refusedCard = listScorecards()[0];
      assert.equal(refusedCard?.finalStatus, 'quota-waiting');
      assert.deepEqual(refusedCard?.blockers, [refused.outcome.summary]);
      assert.equal(refusedCard?.usage.deltaContaminated, true);
      assert.deepEqual(refusedCard?.usage.admissionEstimatePercent, { fiveHour: 1, weekly: 1 });

      // The retained quota history must not exhaust this one-attempt approval.
      fake.usageResult = reading();
      const completed = await layer.dispatch(input({ taskId: 'quota_task', approvalId: approval.id }));
      assert.equal(completed.outcome.kind, 'completed');
      assert.equal(fake.dispatchCalls, 1, 'only the later admitted dispatch may reach the runtime');
      const statuses = layer.status({ taskId: 'quota_task' }).runs.map(({ run }) => run.status);
      assert.equal(statuses.filter((value) => value === 'quota-waiting').length, 1);
      assert.equal(statuses.filter((value) => value === 'completed').length, 1);
    } finally {
      s.cleanup();
    }
  });

  /**
   * The provisional record is what survives when the adapter never returns. It
   * used to hard-code `vendor-default` for `resolved`, while the approved tier
   * was first applied inside the adapter call — so a quota refusal, an adapter
   * throw, a status read taken mid-dispatch, or the process dying all recorded a
   * tiered run as having resolved to vendor defaults.
   */
  it('records the approved tier on a run refused before the adapter is reached', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      fake.usageResult = {
        ok: false,
        unavailable: {
          subscriptionId: CAPS.subscriptionId,
          attemptedAt: new Date().toISOString(),
          source: 'test adapter',
          reason: 'subscription usage is unavailable',
          operatorAction: 'Refresh usage, then retry.',
        },
      };
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'run the bounded test task',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'gpt-5.6-luna',
        effort: 'max',
      });

      const refused = await layer.dispatch(input({ taskId: 'tiered_quota_task', approvalId: approval.id }));
      assert.equal(refused.outcome.kind, 'quota-waiting');
      assert.equal(fake.dispatchCalls, 0, 'the adapter must never have been reached');
      assert.deepEqual(refused.run?.settings.resolved, { model: 'gpt-5.6-luna', effort: 'max' });
      assert.deepEqual(refused.run?.settings.observed, { model: 'unknown', effort: 'unknown' });

      // And the record on disk says the same, not just the returned object.
      const stored = layer.status({ taskId: 'tiered_quota_task' }).runs[0]?.run;
      assert.deepEqual(stored?.settings.resolved, { model: 'gpt-5.6-luna', effort: 'max' });
    } finally {
      s.cleanup();
    }
  });

  it('persists a remote-uncertain runtime outcome as unresolved history', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'run the bounded test task',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const result = await layer.dispatch(input({ taskId: 'uncertain_task', approvalId: approval.id }));

      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.runtimeDispatched, true);
      assert.equal(fake.dispatchCalls, 1);
      const card = listScorecards()[0];
      assert.equal(card?.finalStatus, 'remote-uncertain');
      assert.deepEqual(card?.blockers, [result.outcome.summary]);
      assert.equal(layer.status({ taskId: 'uncertain_task' }).runs[0]?.active, true);
      const reservation = layer.status().reservations.find((r) => r.id === result.admission?.reservationId);
      assert.equal(reservation?.state, 'outstanding', 'local observation ending does not settle remote work');
      assert.equal(reservation?.releasedAt, undefined);

      const retry = await layer.dispatch(input({ taskId: 'uncertain_task', approvalId: approval.id }));
      assert.equal(retry.outcome.kind, 'remote-uncertain');
      assert.equal(retry.runtimeDispatched, false);
      assert.equal(fake.dispatchCalls, 1, 'an unresolved remote run must not be dispatched a second time');
      assert.equal(layer.status({ taskId: 'uncertain_task' }).runs.length, 1);
    } finally {
      s.cleanup();
    }
  });

  const reservationStates = {
    completed: 'released',
    'checks-failed': 'released',
    refused: 'released',
    'unsupported-settings': 'released',
    'attempts-exhausted': 'released',
    'remote-uncertain': 'outstanding',
    'setup-blocked': 'outstanding',
    'native-unavailable': 'outstanding',
    'awaiting-approval': 'outstanding',
    'quota-waiting': 'outstanding',
    'ready-to-dispatch': 'outstanding',
  } as const satisfies Record<OutcomeKind, 'released' | 'outstanding'>;

  for (const kind of Object.keys(reservationStates) as OutcomeKind[]) {
    it(`${kind} leaves its dispatched reservation ${reservationStates[kind]}`, async () => {
      const s = sandbox();
      try {
        const fake = new FakeAdapter(kind);
        const layer = createCoordinatorCommands(() => fake);
        const approvalId = approveTestDispatch(layer);
        const request = input({
          approvalId,
          estimate: { ...input().estimate, fiveHourPercent: 20, weeklyPercent: 20 },
        });
        const first = await layer.dispatch(request);
        assert.equal(first.runtimeDispatched, true);
        assert.ok(first.run?.endedAt, 'the observation has ended even when work is uncertain');
        const reservation = layer.status().reservations.find((r) => r.id === first.admission?.reservationId);
        assert.ok(reservation);
        assert.equal(reservation.runId, first.run?.id);
        assert.equal(reservation.state, reservationStates[kind]);
        assert.equal(Boolean(reservation.releasedAt), reservationStates[kind] === 'released');
        assert.ok(reservation.note?.includes(kind), 'the transition records its reason');
        assert.deepEqual(reservation.estimate, request.estimate, 'settlement never rewrites the estimate as a charge');
        assert.equal(fake.usageCalls, 1, 'settlement needs no account-wide after-reading or invented zero');
        assert.deepEqual(listScorecards()[0]?.usage, {
          admissionEstimatePercent: { fiveHour: 20, weekly: 20 },
          deltaContaminated: true,
          reservationId: reservation.id,
        }, 'account deltas are not per-run consumption');

        // Different task: test headroom, not the first task's unresolved-run guard.
        const next = await layer.dispatch({ ...request, taskId: 'task_2' });
        const released = reservationStates[kind] === 'released';
        assert.equal(next.admission?.admitted, released);
        assert.equal(next.runtimeDispatched, released);
        assert.equal(next.admission?.windows.find((w) => w.kind === 'weekly')?.reservedPercent, released ? 0 : 20);
        assert.equal(fake.dispatchCalls, released ? 2 : 1);
        assert.deepEqual(layer.status().reservations.find((r) => r.id === reservation.id), reservation);
      } finally {
        s.cleanup();
      }
    });
  }

  for (const [name, error, state] of [
    ['unsupported setting', new UnsupportedSettingError('Unsupported model', 'model'), 'released'],
    ['lost response', new Error('response lost after submission'), 'outstanding'],
  ] as const) {
    it(`keeps ${name} exception settlement ${state}`, async () => {
      const s = sandbox();
      try {
        const fake = new FakeAdapter();
        fake.dispatchError = error;
        const layer = createCoordinatorCommands(() => fake);
        const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
        assert.equal(result.runtimeDispatched, true);
        assert.equal(result.outcome.kind, state === 'released' ? 'unsupported-settings' : 'remote-uncertain');
        const reservation = layer.status().reservations.find((r) => r.id === result.admission?.reservationId);
        assert.equal(reservation?.state, state);
        assert.equal(Boolean(reservation?.releasedAt), state === 'released');
        assert.ok(reservation?.note?.includes(result.outcome.kind));
      } finally {
        s.cleanup();
      }
    });
  }

  for (const localProcessStopped of [true, false]) {
    it(`records Pi evidence loss with local process ${localProcessStopped ? 'stopped' : 'unconfirmed'}`, async () => {
      const s = sandbox();
      try {
        const fake = new FakeAdapter();
        fake.dispatchError = new PiEvidenceError('append failed: disk full', localProcessStopped, 4321, 'pi-state-session');
        const layer = createCoordinatorCommands(() => fake);
        const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
        const status = 'remote-uncertain';
        assert.equal(fake.dispatchCalls, 1);
        assert.equal(result.runtimeDispatched, true);
        assert.equal(result.outcome.kind, status);
        assert.match(result.outcome.summary, /append failed: disk full/);
        assert.equal(result.outcome.details?.['processId'], 4321);
        assert.match(result.outcome.nextAction, /Quiesce the coordinator.*escaped descendants.*resolve-pi/);
        assert.equal(result.run?.status, status);
        assert.equal(result.run?.sessionId, 'pi-state-session');
        assert.equal(result.run?.delivery?.status, 'unverified', 'no task completion was proven');
        assert.equal(getRun(result.run!.id)?.status, status);
        assert.equal(getScorecard('card_task_1')?.finalStatus, status);
        assert.deepEqual(getScorecard('card_task_1')?.blockers, [result.outcome.summary]);
        const reservation = listReservations().find((r) => r.id === result.admission?.reservationId);
        assert.equal(reservation?.state, 'outstanding');
      } finally { s.cleanup(); }
    });
  }

  it('keeps typed Pi teardown failures uncertain even when the leader stopped but its pipes did not drain', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      fake.dispatchError = new PiTeardownError('pipes still open', 4321, true, false, 'pi-state-session');
      const layer = createCoordinatorCommands(() => fake);
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.outcome.details?.['processId'], 4321);
      assert.equal(result.run?.sessionId, 'pi-state-session');
      assert.equal(listReservations().find((r) => r.id === result.admission?.reservationId)?.state, 'outstanding');
    } finally { s.cleanup(); }
  });

  it('keeps Pi session and group evidence recoverable across a stubborn teardown', { timeout: 5_000 }, async () => {
    const s = sandbox();
    let pid: number | undefined;
    let stopped = false;
    try {
      const skill = join(s.root, 'claude-plugins/manifest-dev/skills/auto/SKILL.md');
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, 'fixture');
      const bin = join(s.root, 'pi-fixture');
      writeFileSync(bin, [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) process.exit(0);",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(join(s.root, 'pid'))}, String(process.pid));`,
        "const { createInterface } = require('node:readline');",
        "const sessionId = process.argv[process.argv.indexOf('--session-id') + 1];",
        "const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
        "setInterval(() => {}, 1000);",
        "process.on('SIGTERM', () => { process.stdout.end(); process.stderr.end(); });",
        "createInterface({ input: process.stdin }).on('line', line => {",
        "  const msg = JSON.parse(line);",
        "  if (msg.type === 'get_commands') reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { commands: [] } });",
        "  if (msg.type === 'prompt') { reply({ type: 'response', id: msg.id, command: msg.type, success: true }); reply({ type: 'agent_settled' }); }",
        "  if (msg.type === 'get_state') reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { sessionId } });",
        '});',
      ].join('\n'));
      chmodSync(bin, 0o755);
      class ObservedPi extends PiAdapter {
        override async dispatch(request: DispatchInput): Promise<DispatchResult> {
          const durable = getRun(request.runId)!;
          assert.match(durable.sessionId!, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
          assert.equal(request.sessionId, durable.sessionId, 'session was persisted before spawn');
          return super.dispatch(request);
        }
      }
      const pi = new ObservedPi(bin, s.root, { readUsage: () => Promise.resolve(reading()) }, undefined, 150);
      const layer = createCoordinatorCommands(() => pi);
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      pid = Number(readFileSync(join(s.root, 'pid'), 'utf8'));
      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.run?.sessionId, getRun(result.run!.id)?.sessionId);
      assert.equal(result.outcome.details?.['processId'], pid);
      assert.equal(result.run?.delivery?.status, 'unverified');
      assert.equal(getScorecard('card_task_1')?.finalStatus, 'remote-uncertain');
      const earlyLog = readFileSync(join(result.run!.evidenceDir!, 'pi-rpc-events.jsonl'), 'utf8');
      assert.match(earlyLog, new RegExp(`"processId":${pid}`));
      assert.doesNotMatch(earlyLog, /"phase":"prompt-sent"|"type":"agentsys_local_process_stopped"/);
      const reservation = result.admission?.reservationId;
      assert.equal(listReservations().find((r) => r.id === reservation)?.state, 'outstanding');
      const live = await layer.recover('pi-local');
      assert.equal(live[0]?.outcome.kind, 'remote-uncertain');
      assert.equal(listReservations().find((r) => r.id === reservation)?.state, 'outstanding');
      process.kill(-pid, 'SIGKILL');
      stopped = true;
      for (let i = 0; i < 100; i++) {
        try { process.kill(-pid, 0); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      const recovered = await layer.recover('pi-local');
      assert.equal(recovered[0]?.outcome.kind, 'remote-uncertain');
      assert.match(recovered[0]!.outcome.nextAction, /resolve-pi/);
      assert.equal(getRun(result.run!.id)?.status, 'remote-uncertain');
      assert.equal(getScorecard('card_task_1')?.finalStatus, 'remote-uncertain');
      assert.equal(getRun(result.run!.id)?.delivery?.status, 'unverified');
      assert.equal(listReservations().find((r) => r.id === reservation)?.state, 'outstanding');
    } finally {
      const pidPath = join(s.root, 'pid');
      const cleanupPid = pid ?? (existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : undefined);
      if (!stopped && cleanupPid !== undefined && Number.isSafeInteger(cleanupPid) && cleanupPid > 0) {
        try { process.kill(-cleanupPid, 'SIGKILL'); } catch { /* Already stopped. */ }
      }
      s.cleanup();
    }
  });

  it('releases a missing-job attempt that was never dispatched', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer), jobId: 'missing_job' }));
      assert.equal(result.outcome.kind, 'refused');
      assert.equal(fake.dispatchCalls, 0);
      const reservation = layer.status().reservations.find((r) => r.id === result.admission?.reservationId);
      assert.equal(reservation?.state, 'released');
      assert.match(reservation?.note ?? '', /job did not exist/);
    } finally {
      s.cleanup();
    }
  });

  it('releases only the never-dispatched retry, not the earlier uncertain job run', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveTestDispatch(layer);
      const { job } = submitJob({
        taskId: 'task_1', idempotencyKey: 'job_1', repo: REPO,
        workClass: 'ci-repair', runtime: 'pi-local', obligations: [],
      });
      const request = input({ approvalId, jobId: job.id });
      const first = await layer.dispatch(request);
      const original = layer.status().reservations.find((r) => r.id === first.admission?.reservationId);
      assert.equal(original?.state, 'outstanding');
      const retry = await layer.dispatch(request);
      assert.equal(retry.outcome.kind, 'remote-uncertain');
      assert.equal(retry.runtimeDispatched, false);
      assert.equal(fake.dispatchCalls, 1);
      assert.notEqual(retry.admission?.reservationId, first.admission?.reservationId);
      const reservations = layer.status().reservations;
      assert.deepEqual(reservations.find((r) => r.id === original?.id), original);
      const unused = reservations.find((r) => r.id === retry.admission?.reservationId);
      assert.equal(unused?.state, 'released');
      assert.match(unused?.note ?? '', /not dispatched/);
    } finally {
      s.cleanup();
    }
  });

  for (const missing of ['unreadable', 'missing window'] as const) {
    it(`does not treat a ${missing} reading after settlement as zero`, async () => {
      const s = sandbox();
      try {
        const fake = new FakeAdapter();
        const layer = createCoordinatorCommands(() => fake);
        const request = input({ approvalId: approveTestDispatch(layer) });
        const first = await layer.dispatch(request);
        assert.equal(first.outcome.kind, 'completed');
        fake.usageResult = missing === 'unreadable' ? {
          ok: false,
          unavailable: {
            subscriptionId: CAPS.subscriptionId, source: 'test adapter',
            attemptedAt: new Date().toISOString(), reason: 'unreadable', operatorAction: 'Restore readings.',
          },
        } : {
          ok: true,
          reading: { subscriptionId: CAPS.subscriptionId, source: 'test adapter', observedAt: new Date().toISOString(), windows: [] },
        };
        const next = await layer.dispatch({ ...request, taskId: 'task_2' });
        assert.equal(next.outcome.kind, 'quota-waiting');
        assert.equal(next.runtimeDispatched, false);
        assert.equal(fake.dispatchCalls, 1);
        assert.equal(layer.status().reservations.length, 1, 'missing usage cannot authorize another reservation');
        assert.equal(layer.status().reservations[0]?.state, 'released');
      } finally {
        s.cleanup();
      }
    });
  }

  it('records evaluation evidence through the shared commands and retains it on a task retry', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const request = input({ approvalId: approveTestDispatch(layer) });
      const first = await layer.dispatch(request);
      const id = 'card_task_1';
      layer.feedbackRecord(OPERATOR, id, { verdict: 'rework-needed', reason: 'repair requested' });
      layer.feedbackRecord(OPERATOR, id, { verdict: 'accepted', reason: 'operator verdict' });
      layer.checkResultRecord(OPERATOR, id, { name: 'unit', outcome: 'failed', source: 'unit.log', head: 'a'.repeat(40) });
      layer.reviewRecord(OPERATOR, id, {
        author: 'author-session', reviewer: { id: 'review-session', relationship: 'independent' },
        source: 'code-bugs', head: 'a'.repeat(40), findings: [{ severity: 'high', summary: 'lost evidence' }],
      });
      const recorded = layer.repairRecord(OPERATOR, id, {
        trigger: 'failed-check', detail: 'kept prior results', head: 'b'.repeat(40),
      });
      saveScorecard({ ...recorded, candidateHead: 'a'.repeat(40), prUrl: 'https://example.test/pr/1' });
      const reservations = layer.status().reservations;
      assert.deepEqual(recorded.usage, listScorecards()[0]?.usage);
      const second = await layer.dispatch(request);
      assert.equal(second.outcome.kind, 'completed');
      const next = listScorecards()[0]!;
      assert.deepEqual(next.checks, recorded.checks);
      assert.deepEqual(next.reviews, recorded.reviews);
      assert.deepEqual(next.reviewerFindings, recorded.reviewerFindings);
      assert.deepEqual(next.repairs, recorded.repairs);
      assert.deepEqual(next.feedback, recorded.feedback);
      assert.deepEqual(next.feedbackHistory, recorded.feedbackHistory);
      assert.deepEqual(next.runIds, [first.run?.id, second.run?.id]);
      assert.equal(next.attempts, 2);
      assert.equal(next.createdAt, recorded.createdAt);
      assert.equal(next.prUrl, 'https://example.test/pr/1');
      assert.equal(next.candidateHead, undefined, 'an unreported retry head must not inherit the old candidate');
      assert.deepEqual(layer.status().reservations.find((entry) => entry.id === reservations[0]?.id), reservations[0]);
      assert.equal(next.usage.observedAccountDeltaPercent, undefined);
      assert.equal(next.usage.paidCallUsd, undefined);
      const view = layer.evaluation({ view: 'scorecards' });
      assert.equal(view.view, 'scorecards');
      if (view.view !== 'scorecards') assert.fail('wrong evaluation view');
      assert.equal(view.report.failedAttempts, 1);
      assert.deepEqual(view.report.evidence[0]?.reviewerFindings, recorded.reviewerFindings);
      assert.equal(view.report.evidence[0]?.independentReviewStatus, 'reviewed');
      const filtered = layer.evaluation({ view: 'scorecards', repo: 'another/repo' });
      if (filtered.view !== 'scorecards') assert.fail('wrong evaluation view');
      assert.deepEqual(filtered.scorecards, []);
      assert.deepEqual(filtered.report.evidence, []);
    } finally {
      s.cleanup();
    }
  });

  it('keeps summary payloads aggregate-only over the same population as scorecard details', async () => {
    const s = sandbox();
    try {
      const layer = createCoordinatorCommands(() => new FakeAdapter());
      await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      const id = 'card_task_1';
      layer.checkResultRecord(OPERATOR, id, { name: 'unit', outcome: 'failed', source: 'unit.log', head: 'a'.repeat(40) });
      layer.reviewRecord(OPERATOR, id, {
        author: 'author', reviewer: { id: 'reviewer', relationship: 'independent' },
        source: 'review.log', head: 'a'.repeat(40), findings: [{ severity: 'high', summary: 'detail-only finding prose' }],
      });
      const recorded = layer.repairRecord(OPERATOR, id, {
        trigger: 'review-finding', detail: 'detail-only repair prose', head: 'b'.repeat(40),
      });
      saveScorecard({
        ...recorded, id: 'card_other', taskId: 'other', repo: 'other/repo', workClass: 'other-class',
        runtime: 'claude-web', authority: { type: 'approval', id: 'other-approval', version: 1 },
        workflowVersion: 'other-version', settings: {
          requested: { model: 'other-model', effort: 'low' }, resolved: { model: 'other-model', effort: 'low' },
          observed: { model: 'other-model', effort: 'low' },
        },
      });
      const filters: EvaluationInput[] = [
        {}, { repo: recorded.repo }, { workClass: recorded.workClass }, { runtime: recorded.runtime },
        { authorityId: recorded.authority.id }, { workflowVersion: recorded.workflowVersion },
        { effectiveConfiguration: `${recorded.settings.observed.model}/${recorded.settings.observed.effort}` },
        { repo: recorded.repo, runtime: 'claude-web' }, { repo: 'no/matches' },
      ];
      for (const filter of filters) {
        const detail = layer.evaluation({ ...filter, view: 'scorecards' });
        if (detail.view !== 'scorecards') assert.fail('wrong evaluation view');
        const { evidence, recordedAttempts: _attempts, ...aggregates } = detail.report;
        assert.equal(evidence.length, detail.scorecards.length);
        assert.equal(detail.scorecards.length, Object.keys(filter).length === 0 ? 2 :
          filter.repo === 'no/matches' || filter.runtime === 'claude-web' ? 0 : 1);
        for (const entry of evidence) assert.deepEqual(entry.reviewerFindings, recorded.reviewerFindings);
        for (const view of [undefined, 'summary'] as const) {
          const summary = layer.evaluation({ ...filter, ...(view ? { view } : {}) });
          if (summary.view !== 'summary') assert.fail('wrong evaluation view');
          assert.deepEqual(summary.scorecards, { count: detail.scorecards.length, report: aggregates });
          assert.doesNotMatch(JSON.stringify(summary), /detail-only|"recordedAttempts"|"evidence"|"checks"|"reviews"|"reviewerFindings"|"repairs"/);
        }
      }
      const before = layer.evaluation();
      layer.reviewRecord(OPERATOR, id, {
        author: 'author', reviewer: { id: 'reviewer', relationship: 'independent' },
        source: 'followup.log', head: 'b'.repeat(40), findings: [],
      });
      assert.deepEqual(layer.evaluation(), before, 'appended review history must not enlarge the summary');
    } finally {
      s.cleanup();
    }
  });

  it('gates every evidence command before recording or calling an adapter', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands(() => fake);
      await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      const original = listScorecards();
      const calls = [fake.dispatchCalls, fake.usageCalls, fake.reconcileCalls];
      for (const actor of [AGENT_ACTOR, { kind: 'operator' as const, id: 'someone-else' }]) {
        assert.throws(() => layer.checkResultRecord(actor, 'card_task_1', { name: 'unit', source: 'run', outcome: 'passed', head: 'a'.repeat(40) }));
        assert.throws(() => layer.reviewRecord(actor, 'card_task_1', {
          author: 'a', reviewer: { id: 'b', relationship: 'independent' }, source: 'review', head: 'a'.repeat(40), findings: [],
        }));
        assert.throws(() => layer.repairRecord(actor, 'card_task_1', { trigger: 'failed-check', detail: 'fixed it', head: 'a'.repeat(40) }));
      }
      assert.deepEqual(listScorecards(), original);
      assert.deepEqual([fake.dispatchCalls, fake.usageCalls, fake.reconcileCalls], calls);
    } finally {
      s.cleanup();
    }
  });

  it('keeps operator mutations gated while exposing read-only policy data', () => {
    const s = sandbox();
    try {
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => new FakeAdapter());
      assert.throws(
        () => layer.policySet(AGENT_ACTOR, {
          subscriptionId: CAPS.subscriptionId,
          fiveHourThresholdPercent: 20,
          weeklyThresholdPercent: 20,
          safetyMarginPercent: 5,
          maxReadingAgeSeconds: 300,
          applicableWindows: ['five-hour', 'weekly'],
        }),
        /cannot issue or change authority/,
      );
      const view = policyView(CAPS.subscriptionId);
      assert.equal(view.policy.fiveHourThresholdPercent, 60);
      assert.equal(layer.configuredOperator(), OPERATOR.id);
    } finally {
      s.cleanup();
    }
  });

  it('reports runtime-filtered recovery without asking other adapters', async () => {
    const s = sandbox();
    try {
      const fake = new FakeAdapter();
      const factories: RuntimeId[] = [];
      const layer = createCoordinatorCommands((runtime) => {
        factories.push(runtime);
        return fake;
      });
      const reports = await layer.recover('claude-web');
      assert.deepEqual(reports, []);
      assert.deepEqual(factories, ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'], 'all reconcilers are wired while only the selected runtime is queried');
      assert.equal(fake.reconcileCalls, 0);
      assert.deepEqual(statusView().runs, []);
    } finally {
      s.cleanup();
    }
  });
});

/**
 * Runtimes shaped like the two real ones this behaviour splits on, so the split
 * is exercised by the declaration that causes it rather than by a runtime name.
 */
const TIER_CAPS: RuntimeCapabilities = {
  ...CAPS,
  effortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const SILENT_CAPS: RuntimeCapabilities = {
  ...TIER_CAPS,
  runtime: 'claude-web',
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  reportsEffectiveSettings: false,
};

/** An adapter that resolves settings the way the real ones do, and remembers its input. */
class TierAdapter implements RuntimeAdapter {
  seen?: DispatchInput;

  constructor(
    readonly capabilities: RuntimeCapabilities = TIER_CAPS,
    private readonly reported: { model?: string; effort?: string } = {},
  ) {}

  readUsage(): Promise<UsageResult> {
    return Promise.resolve(reading());
  }

  checkReadiness() {
    return Promise.resolve(undefined);
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.seen = input;
    const resolved = resolveSettings(this.capabilities, input.settings, {
      model: input.approvedTier?.model ?? 'adapter-default',
      effort: input.approvedTier?.effort ?? 'high',
    });
    return Promise.resolve({
      outcome: {
        kind: 'completed', taskId: input.taskId, runId: input.runId,
        summary: 'fake run settled', nextAction: 'Review the retained evidence.',
      },
      settings: snapshot(this.capabilities, input.settings, resolved, this.reported),
    });
  }

  reconcile(): Promise<DispatchResult['outcome']> {
    return Promise.resolve({
      kind: 'remote-uncertain', summary: 'fake session remains uncertain',
      nextAction: 'Inspect the fake session before retrying.',
    });
  }
}

describe('a dispatch under an approved tier', () => {
  it('runs at the approved tier and records requested, resolved and observed apart', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter(TIER_CAPS, { model: 'gpt-5.6-luna', effort: 'max' });
      const layer = createCoordinatorCommands(() => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO, taskScope: 'run the bounded test task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'gpt-5.6-luna', effort: 'max',
      });

      // The command line names neither, which is the case the tier exists for.
      const result = await layer.dispatch(input({ approvalId: approval.id }));

      assert.equal(result.outcome.kind, 'completed');
      assert.deepEqual(fake.seen?.approvedTier, { model: 'gpt-5.6-luna', effort: 'max' });
      assert.deepEqual(result.run?.settings, {
        requested: { model: 'vendor-default', effort: 'vendor-default' },
        resolved: { model: 'gpt-5.6-luna', effort: 'max' },
        observed: { model: 'gpt-5.6-luna', effort: 'max' },
      });
      assert.deepEqual(listScorecards()[0]?.settings, result.run?.settings);
    } finally {
      s.cleanup();
    }
  });

  it('refuses a contradicting request without reaching the runtime', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO, taskScope: 'run the bounded test task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'gpt-5.6-luna', effort: 'max',
      });

      const result = await layer.dispatch(input({
        approvalId: approval.id, settings: { model: 'gpt-6-astra' },
      }));

      assert.equal(result.outcome.kind, 'refused');
      assert.match(result.outcome.summary, /approved to run at model gpt-5\.6-luna, requested gpt-6-astra/);
      assert.equal(result.runtimeDispatched, false);
      assert.equal(fake.seen, undefined, 'the runtime must not be called for a refused dispatch');
      assert.deepEqual(statusView().runs, [], 'a refusal before authority is not a run');
    } finally {
      s.cleanup();
    }
  });

  it('lets the caller name the approved tier explicitly', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter(TIER_CAPS, { model: 'gpt-5.6-luna', effort: 'max' });
      const layer = createCoordinatorCommands(() => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO, taskScope: 'run the bounded test task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'gpt-5.6-luna', effort: 'max',
      });

      const result = await layer.dispatch(input({
        approvalId: approval.id, settings: { model: 'gpt-5.6-luna', effort: 'max' },
      }));

      assert.equal(result.outcome.kind, 'completed');
      assert.deepEqual(result.run?.settings.requested, { model: 'gpt-5.6-luna', effort: 'max' });
      assert.deepEqual(result.run?.settings.resolved, { model: 'gpt-5.6-luna', effort: 'max' });
    } finally {
      s.cleanup();
    }
  });

  it('sends the tier to a runtime that confirms nothing, and records observed as unknown', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter(SILENT_CAPS);
      const layer = createCoordinatorCommands(() => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO, taskScope: 'run the bounded test task', workClass: 'ci-repair',
        runtime: 'claude-web', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'opus', effort: 'max',
      });

      // No contradicting request: the tier is inherited, which is the case this
      // covers. A runtime that confirms nothing can still be sent a tier.
      const result = await layer.dispatch(input({
        approvalId: approval.id, runtime: 'claude-web',
      }));

      assert.equal(result.outcome.kind, 'completed');
      assert.deepEqual(fake.seen?.approvedTier, { model: 'opus', effort: 'max' });
      assert.deepEqual(result.run?.settings, {
        requested: { model: 'vendor-default', effort: 'vendor-default' },
        resolved: { model: 'opus', effort: 'max' },
        // Nothing came back, so nothing is claimed about what actually ran.
        observed: { model: 'unknown', effort: 'unknown' },
      });
    } finally {
      s.cleanup();
    }
  });

  /**
   * A runtime's silence about what it ran is not the operator's consent to
   * something else. This case used to dispatch at `sonnet` against an `opus`
   * approval, because the refusal was gated on `reportsEffectiveSettings` — a
   * capability describing post-run evidence, used as a pre-dispatch authority
   * rule. Both values are known before anything is dispatched.
   */
  it('refuses a contradicting request even where the runtime confirms nothing', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter(SILENT_CAPS);
      const layer = createCoordinatorCommands(() => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO, taskScope: 'run the bounded test task', workClass: 'ci-repair',
        runtime: 'claude-web', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
        model: 'opus', effort: 'max',
      });

      const result = await layer.dispatch(input({
        approvalId: approval.id, runtime: 'claude-web', settings: { model: 'sonnet', effort: 'low' },
      }));

      assert.equal(result.outcome.kind, 'refused');
      assert.equal(result.runtimeDispatched, false);
      assert.equal(fake.seen, undefined, 'nothing may reach a runtime under a tier the operator did not approve');
      assert.match(result.outcome.summary ?? '', /model opus/);
    } finally {
      s.cleanup();
    }
  });

  it('leaves an untiered approval resolving to the adapter default', async () => {
    const s = sandbox();
    try {
      const fake = new TierAdapter();
      const layer = createCoordinatorCommands(() => fake);
      const approvalId = approveTestDispatch(layer);

      const result = await layer.dispatch(input({ approvalId }));

      assert.equal(result.outcome.kind, 'completed');
      assert.equal(fake.seen?.approvedTier, undefined);
      assert.deepEqual(result.run?.settings.resolved, { model: 'adapter-default', effort: 'high' });
    } finally {
      s.cleanup();
    }
  });
});

/**
 * Intake work has a job, and a dispatch that does not name it leaves the run
 * unattached. The job then stays open with no runs, and the next delivery of the
 * same signal sees no attempt to refuse and starts a second repair. Fixing the
 * printed hint only helps callers who read it.
 */
describe('a task that belongs to a job cannot be dispatched without naming it', () => {
  it('refuses the task-only call and says which job to use', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'job-owned work',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });

      const job = submitJob({
        idempotencyKey: 'github-actions:owner/repo:run/1',
        taskId: 'job_owned_task',
        repo: REPO,
        workClass: 'ci-repair',
        runtime: 'pi-local',
        obligations: ['unit'],
      }).job;

      const result = await layer.dispatch(input({ taskId: 'job_owned_task', approvalId: approval.id }));

      assert.equal(result.outcome.kind, 'refused');
      assert.equal(result.runtimeDispatched, false);
      assert.match(result.outcome.nextAction ?? '', new RegExp(`--job ${job.id}\\b`));
      assert.equal(fake.dispatchCalls, 0, 'nothing may reach the runtime unattached');
    } finally { box.cleanup(); }
  });

  it('dispatches normally for a task with no job behind it', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'ordinary work',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const result = await layer.dispatch(input({ taskId: 'ordinary_task', approvalId: approval.id }));
      assert.equal(result.runtimeDispatched, true, 'only job-owned tasks are constrained');
    } finally { box.cleanup(); }
  });
});

/**
 * An uncertain run holds admission headroom until something establishes what it
 * used. Recovery is the only thing that can, so the reservation's fate is part of
 * reconciliation rather than of dispatch.
 *
 * These two sat under the job describe above, carrying its titles, from the merge
 * in `ffc3fda` until `gpt-5.6-sol` read the bodies rather than the names. The job
 * guard had no test at all in that window: disabling it left the suite green.
 */
describe('Pi setup after admission', () => {
  it('holds an attempt uncertain when the first process-started append fails before any RPC', { timeout: 5_000 }, async () => {
    const box = sandbox();
    try {
      const skill = join(box.root, 'claude-plugins/manifest-dev/skills/auto/SKILL.md');
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, 'fixture');
      const requests = join(box.root, 'requests.jsonl');
      const bin = join(box.root, 'pi-fixture');
      writeFileSync(bin, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "require('node:readline').createInterface({ input: process.stdin }).on('line', line => {",
        `  fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');`,
        '});',
      ].join('\n'));
      chmodSync(bin, 0o755);
      class FailingPi extends PiAdapter {
        override readonly capabilities = { ...PI_CAPABILITIES, subscriptionId: CAPS.subscriptionId };
      }
      const pi = new FailingPi(bin, box.root, { readUsage: () => Promise.resolve(reading()) }, () => {
        throw new Error('synthetic first append failure');
      });
      const layer = createCoordinatorCommands(() => pi);
      const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer), repoPath: box.root }));
      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.outcome.promptNotSent, undefined, 'lost evidence cannot certify a negative');
      assert.equal(result.run?.promptNotSent, undefined);
      assert.equal(existsSync(requests), false, 'no discovery request or task prompt reached Pi');
      assert.equal(existsSync(join(result.run!.evidenceDir!, 'pi-rpc-events.jsonl')), false);
      const pid = result.outcome.details?.['processId'];
      assert.equal(typeof pid, 'number');
      assert.equal(processGroupAbsent(pid as number), true);
      assert.equal(getRun(result.run!.id)?.status, 'remote-uncertain');
      assert.equal(listReservations().find((r) => r.id === result.admission?.reservationId)?.state, 'outstanding');
      const reports = await layer.recover('pi-local');
      assert.equal(reports[0]?.outcome.kind, 'remote-uncertain');
      assert.equal(reports[0]?.outcome.promptNotSent, undefined);
      assert.equal(reports[0]?.blocksNewAttempt, true);
      assert.equal(getScorecard('card_task_1')?.finalStatus, 'remote-uncertain');
    } finally { box.cleanup(); }
  });

  for (const failure of ['missing-disk-skill', 'spawn-error', 'missing-registered-skill'] as const) {
    it(`settles ${failure} without sending a task prompt and releases only its reservation`, async () => {
      const box = sandbox();
      try {
        const skill = join(box.root, 'claude-plugins/manifest-dev/skills/auto/SKILL.md');
        mkdirSync(dirname(skill), { recursive: true });
        if (failure !== 'missing-disk-skill') writeFileSync(skill, 'fixture');
        const bin = join(box.root, 'pi-fixture');
        const requests = join(box.root, 'requests.jsonl');
        writeFileSync(bin, [
          '#!/usr/bin/env node',
          "if (process.argv.includes('--version')) process.exit(0);",
          "const fs = require('node:fs');",
          "const { createInterface } = require('node:readline');",
          "const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
          'createInterface({ input: process.stdin }).on(\'line\', line => {',
          `  fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');`,
          '  const msg = JSON.parse(line);',
          "  if (msg.type === 'get_commands') reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { commands: [] } });",
          '});',
        ].join('\n'));
        chmodSync(bin, 0o755);
        class RealPi extends PiAdapter {
          override readonly capabilities = { ...PI_CAPABILITIES, subscriptionId: CAPS.subscriptionId };
          override async checkReadiness(entry: 'skill' | 'review-pr' | 'prompt' = 'skill') {
            const result = await super.checkReadiness(entry);
            if (failure === 'spawn-error') rmSync(bin); // readiness passed; spawn now fails
            return result;
          }
        }
        const pi = new RealPi(bin, box.root, { readUsage: () => Promise.resolve(reading()) });
        const layer = createCoordinatorCommands(() => pi);
        const result = await layer.dispatch(input({ approvalId: approveTestDispatch(layer), repoPath: box.root }));
        assert.equal(result.runtimeDispatched, true);
        assert.equal(result.outcome.kind, 'checks-failed');
        assert.equal(result.outcome.promptNotSent, true);
        assert.equal(result.run?.promptNotSent, true);
        assert.equal(getRun(result.run!.id)?.promptNotSent, true, 'the proof survives a stored run read');
        assert.match(result.outcome.summary, /no task prompt was sent/i);
        assert.equal(result.run?.status, 'checks-failed');
        assert.equal(result.run?.delivery?.status, 'unverified');
        assert.equal(getScorecard('card_task_1')?.finalStatus, 'checks-failed');
        assert.equal(listReservations().find((r) => r.id === result.admission?.reservationId)?.state, 'released');
        assert.equal(existsSync(requests), failure === 'missing-registered-skill');
        if (existsSync(requests)) assert.doesNotMatch(readFileSync(requests, 'utf8'), /"type":"prompt"/);
        if (failure === 'missing-registered-skill') {
          const log = readFileSync(join(result.run!.evidenceDir!, 'pi-rpc-events.jsonl'), 'utf8');
          assert.match(log, /"type":"agentsys_local_process_stopped"/);
        }
        // Simulate a crash after saving the terminal run, before its card and reservation.
        const reservation = listReservations().find((r) => r.id === result.admission?.reservationId)!;
        writeFileSync(join(box.root, 'reservations', `${reservation.id}.json`), JSON.stringify({ ...reservation, state: 'outstanding' }));
        saveScorecard({ ...getScorecard('card_task_1')!, finalStatus: 'remote-uncertain' });
        await layer.recover('pi-local');
        assert.equal(listReservations().find((r) => r.id === reservation.id)?.state, 'released');
        assert.equal(getScorecard('card_task_1')?.finalStatus, 'checks-failed');
      } finally { box.cleanup(); }
    });
  }
});

it('retains recovered pre-prompt proof on the run, but not when evidence has no stop marker', async () => {
  const box = sandbox();
  try {
    const fake = new FakeAdapter('remote-uncertain');
    fake.sessionId = 'session-recovered-pre-prompt';
    const pi = new PiAdapter('unused');
    fake.reconcile = (sessionId, evidenceDir) => pi.reconcile(sessionId!, evidenceDir);
    const layer = createCoordinatorCommands(() => fake);
    const dispatched = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
    const run = dispatched.run!;
    assert.equal(run.promptNotSent, undefined);
    const log = join(run.evidenceDir!, 'pi-rpc-events.jsonl');
    writeFileSync(log, [
      JSON.stringify({ type: 'agentsys_phase', phase: 'process-started' }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n') + '\n');
    const uncertain = await layer.recover('pi-local');
    assert.equal(uncertain[0]?.outcome.kind, 'remote-uncertain');
    assert.equal(getRun(run.id)?.promptNotSent, undefined);
    writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ type: 'agentsys_local_process_stopped' }) + '\n');
    const recovered = await layer.recover('pi-local');
    assert.equal(recovered[0]?.outcome.kind, 'checks-failed');
    assert.equal(recovered[0]?.outcome.promptNotSent, true);
    assert.equal(getRun(run.id)?.promptNotSent, true);
    assert.equal(getRun(run.id)?.status, 'checks-failed');
    assert.equal(getScorecard(`card_${run.taskId}`)?.finalStatus, 'checks-failed');
  } finally { box.cleanup(); }
});

describe('operator-attested Pi stop recovery', () => {
  const attest = (runId: string) => ({ runId, confirmStopped: true, evidence: 'inspection/log-42', reason: 'Checked group and escaped descendants; stopped all.' });

  it('requires the operator, explicit evidence, a dispatched Pi run and its exact held reservation', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands(() => fake);
      const run = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }))).run!;
      assert.throws(() => layer.resolvePiStopped(AGENT_ACTOR, attest(run.id)), /operator/i);
      assert.throws(() => layer.resolvePiStopped(OPERATOR, { ...attest(run.id), confirmStopped: false }), /confirm-stopped/);
      assert.throws(() => layer.resolvePiStopped(OPERATOR, { ...attest(run.id), reason: ' ' }), /reason/);
      assert.throws(() => layer.resolvePiStopped(OPERATOR, { ...attest(run.id), evidence: '' }), /evidence/);
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest('../run')), /run ID/);
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest('run_missing')), /No run/);
      saveRun({ ...run, runtime: 'claude-local' });
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest(run.id)), /Pi run/);
      saveRun({ ...run, runtimeDispatched: false });
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest(run.id)), /dispatched Pi/);
      saveRun({ ...run, admissionId: 'res_other' });
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest(run.id)), /matching held reservation/);
      saveRun({ ...run, status: 'completed' });
      assert.throws(() => layer.resolvePiStopped(OPERATOR, attest(run.id)), /not unsettled/);
      assert.equal(listReservations().find((r) => r.runId === run.id)?.state, 'outstanding');
    } finally { box.cleanup(); }
  });

  for (const initial of ['running', 'remote-uncertain', 'setup-blocked'] as const) {
    it(`attests ${initial} without a PID, retains obligations and repairs replay crash gaps`, async () => {
      const box = sandbox();
      try {
        const fake = new FakeAdapter('remote-uncertain');
        const layer = createCoordinatorCommands(() => fake);
        const job = submitJob({ idempotencyKey: 'stop-case', taskId: 'task_1', repo: REPO,
          workClass: 'ci-repair', runtime: 'pi-local', obligations: ['unit'] }).job;
        const run = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer), jobId: job.id }))).run!;
        const interrupted = { ...run, status: initial };
        if (initial === 'running') delete interrupted.endedAt;
        saveRun(interrupted);
        const oldCard = getScorecard('card_task_1')!;
        const check = { name: 'earlier check', outcome: 'failed' as const, source: 'retained' };
        saveScorecard({ ...oldCard, checks: [check] });
        const headroom = () => admit({ subscriptionId: CAPS.subscriptionId, taskId: 'other-task', runId: 'run_other',
          estimate: { fiveHourPercent: 54, weeklyPercent: 1, uncertaintyPercent: 0,
            basis: 'operator-bound', detail: 'test headroom' }, readUsage: reading, preview: true });
        assert.equal((await headroom()).admitted, false, 'uncertain run holds future headroom');
        const resolved = layer.resolvePiStopped(OPERATOR, attest(run.id));
        assert.equal((await headroom()).admitted, true, 'attested stop restores admission headroom');
        assert.equal(resolved.status, 'checks-failed');
        assert.equal(resolved.stopAttestation?.priorStatus, initial);
        assert.equal(resolved.stopAttestation?.processId, undefined);
        assert.equal(resolved.delivery?.status, 'unverified');
        assert.match(resolved.summary!, /unverified/);
        assert.equal(listReservations().find((r) => r.runId === run.id)?.state, 'released');
        assert.deepEqual(getScorecard(oldCard.id)?.checks, [check]);
        assert.equal(getScorecard(oldCard.id)?.finalStatus, 'checks-failed');
        assert.equal(layer.jobs().jobs[0]?.outstandingObligations[0], 'unit');
        assert.deepEqual(layer.resolvePiStopped(OPERATOR, attest(run.id)), resolved);
        assert.throws(() => layer.resolvePiStopped(OPERATOR, { ...attest(run.id), evidence: 'different' }), /different stop attestation/);
        // Simulate a crash immediately after the run write, before reservation and card updates.
        const reservation = listReservations().find((r) => r.runId === run.id)!;
        writeFileSync(join(box.root, 'reservations', `${reservation.id}.json`), JSON.stringify({ ...reservation, state: 'outstanding' }));
        saveScorecard(oldCard);
        layer.resolvePiStopped(OPERATOR, attest(run.id));
        assert.equal(listReservations().find((r) => r.id === reservation.id)?.state, 'released');
        assert.equal(getScorecard(oldCard.id)?.finalStatus, 'checks-failed');
        assert.equal(layer.evaluation({ view: 'scorecards' }).view, 'scorecards');
      } finally { box.cleanup(); }
    });
  }

  it('does not overwrite a newer attempt card when an old Pi stop is replayed', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands(() => fake);
      const old = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }))).run!;
      layer.resolvePiStopped(OPERATOR, attest(old.id));
      const card = getScorecard('card_task_1')!;
      const { stopAttestation: _attestation, ...prior } = old;
      const newer = { ...prior, id: 'run_newer', attempt: 2, status: 'completed' as const };
      saveRun(newer);
      const latest = { ...card, runIds: [old.id, newer.id], attempts: 2,
        finalStatus: 'completed' as const, blockers: [], elapsedMs: 4242 };
      saveScorecard(latest);
      layer.resolvePiStopped(OPERATOR, attest(old.id));
      assert.deepEqual(getScorecard(card.id), latest);
    } finally { box.cleanup(); }
  });

  it('refuses a live process group despite operator confirmation and retained PID', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands(() => fake);
      const run = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }))).run!;
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      try {
        assert.ok(child.pid);
        writeFileSync(join(run.evidenceDir!, 'pi-rpc-events.jsonl'), JSON.stringify({ type: 'agentsys_phase', phase: 'process-started', processId: child.pid }) + '\n');
        assert.throws(() => layer.resolvePiStopped(OPERATOR, attest(run.id)), /process group .* exists/);
        assert.equal(getRun(run.id)?.status, 'remote-uncertain');
        assert.equal(listReservations().find((r) => r.runId === run.id)?.state, 'outstanding');
      } finally { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
    } finally { box.cleanup(); }
  });

  it('records a retained absent process group ID without inferring task completion', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      const layer = createCoordinatorCommands(() => fake);
      const run = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }))).run!;
      const absent = 2_000_000_000;
      writeFileSync(join(run.evidenceDir!, 'pi-rpc-events.jsonl'), JSON.stringify({
        type: 'agentsys_phase', phase: 'process-started', processId: absent,
      }) + '\n');
      const resolved = layer.resolvePiStopped(OPERATOR, attest(run.id));
      assert.equal(resolved.stopAttestation?.processId, absent);
      assert.equal(resolved.status, 'checks-failed');
      assert.equal(resolved.delivery?.status, 'unverified');
    } finally { box.cleanup(); }
  });

  it('does not let a stale reconciliation answer overwrite an attested run', async () => {
    const box = sandbox();
    try {
      let answer!: (outcome: DispatchResult['outcome']) => void;
      class Delayed extends FakeAdapter {
        override reconcile(): Promise<DispatchResult['outcome']> {
          return new Promise((resolve) => { answer = resolve; });
        }
      }
      const fake = new Delayed('remote-uncertain');
      fake.sessionId = 'session-reconcile';
      const layer = createCoordinatorCommands(() => fake);
      const run = (await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }))).run!;
      const recovery = layer.recover('pi-local');
      while (!answer) await new Promise((resolve) => setTimeout(resolve, 1));
      layer.resolvePiStopped(OPERATOR, attest(run.id));
      answer({ kind: 'completed', summary: 'old answer', nextAction: 'none' });
      const reports = await recovery;
      assert.equal(reports[0]?.outcome.kind, 'checks-failed');
      assert.equal(reports[0]?.blocksNewAttempt, false);
      assert.equal(getRun(run.id)?.stopAttestation?.priorStatus, 'remote-uncertain');
      assert.equal(getScorecard('card_task_1')?.finalStatus, 'checks-failed');
    } finally { box.cleanup(); }
  });

  it('does not let a stale dispatch completion overwrite a manual stop', async () => {
    const box = sandbox();
    try {
      let finish!: (result: DispatchResult) => void;
      class Delayed extends FakeAdapter {
        override dispatch(_request: DispatchInput): Promise<DispatchResult> {
          return new Promise((resolve) => { finish = resolve; });
        }
      }
      const fake = new Delayed();
      const layer = createCoordinatorCommands(() => fake);
      const promise = layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
      const running = layer.status().runs[0]!.run;
      layer.resolvePiStopped(OPERATOR, attest(running.id));
      finish({ outcome: { kind: 'completed', summary: 'stale completion', nextAction: 'none' },
        settings: running.settings });
      const result = await promise;
      assert.equal(result.outcome.kind, 'checks-failed');
      assert.equal(getRun(running.id)?.status, 'checks-failed');
      assert.equal(getScorecard(`card_${running.taskId}`)?.finalStatus, 'checks-failed');
      assert.equal(listReservations().find((r) => r.runId === running.id)?.state, 'released');
    } finally { box.cleanup(); }
  });
});

describe('an uncertain run settles its reservation only when recovery confirms it', () => {
  for (const settledStatus of ['completed', 'checks-failed'] as const) {
    it(`settles a linked pre-dispatch scorecard as ${settledStatus} without erasing evidence`, async () => {
      const box = sandbox();
      try {
        const fake = new FakeAdapter('remote-uncertain');
        fake.sessionId = `session-${settledStatus}`;
        fake.reconcileKind = settledStatus;
        const layer = createCoordinatorCommands(() => fake);
        const dispatched = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
        const run = dispatched.run!;
        const card = getScorecard('card_task_1')!;
        assert.equal(run.status, 'remote-uncertain');
        assert.equal(card.finalStatus, 'remote-uncertain');
        const check = { name: 'retained check', outcome: 'failed' as const, source: 'earlier evidence' };
        const feedback = { verdict: 'rework-needed' as const, by: 'operator', reason: 'retain this', at: run.startedAt };
        saveScorecard({ ...card, checks: [check], feedback });

        const reports = await layer.recover();
        assert.ok(reports.some((r) => r.runId === run.id && r.outcome.kind === settledStatus));
        const recovered = getRun(run.id)!;
        const updated = getScorecard(card.id)!;
        assert.equal(recovered.status, settledStatus);
        assert.equal(updated.finalStatus, settledStatus);
        assert.deepEqual(updated.blockers, []);
        assert.equal(updated.elapsedMs, Date.parse(recovered.endedAt!) - Date.parse(run.startedAt));
        assert.deepEqual(updated.checks, [check]);
        assert.deepEqual(updated.feedback, feedback);
        assert.deepEqual(updated.usage, card.usage);
        assert.deepEqual(updated.runIds, card.runIds);
        assert.equal(updated.createdAt, card.createdAt);
      } finally { box.cleanup(); }
    });
  }

  it('repairs a stale latest card after the terminal run was saved in an earlier recovery', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      fake.sessionId = 'session-crash-gap';
      const layer = createCoordinatorCommands(() => fake);
      const dispatched = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      const run = dispatched.run!;
      const card = getScorecard('card_task_1')!;
      const check = { name: 'retained check', outcome: 'failed' as const, source: 'earlier evidence' };
      saveScorecard({ ...card, checks: [check] });
      const endedAt = new Date(Date.parse(run.startedAt) + 5000).toISOString();
      saveRun({ ...run, status: 'checks-failed', summary: 'Checks failed before the crash.', endedAt });

      const skipped = await layer.recover('claude-local');
      assert.deepEqual(skipped, []);
      assert.equal(getScorecard(card.id)?.finalStatus, 'remote-uncertain', 'runtime filter must not update other cards');
      const reports = await layer.recover('pi-local');
      assert.deepEqual(reports, [], 'the terminal run no longer generates a reconciliation report');
      const updated = getScorecard(card.id)!;
      assert.equal(updated.finalStatus, 'checks-failed');
      assert.deepEqual(updated.blockers, []);
      assert.equal(updated.elapsedMs, 5000);
      assert.deepEqual(updated.checks, [check]);
      assert.deepEqual(updated.runIds, card.runIds);
      assert.deepEqual(updated.usage, card.usage);
      assert.equal(updated.createdAt, card.createdAt);
      await layer.recover('pi-local');
      assert.deepEqual(getScorecard(card.id), updated, 'recovery is idempotent');
    } finally { box.cleanup(); }
  });

  it('does not replace a newer scorecard when an older uncertain attempt settles', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      fake.sessionId = 'session-older';
      fake.reconcileKind = 'completed';
      const layer = createCoordinatorCommands(() => fake);
      const dispatched = await layer.dispatch(input({ approvalId: approveTestDispatch(layer) }));
      const old = dispatched.run!;
      const card = getScorecard('card_task_1')!;
      assert.equal(old.status, 'remote-uncertain');
      const newer = { ...old, id: 'run_newer', attempt: 2, sessionId: 'session-newer',
        status: 'completed' as const, endedAt: new Date().toISOString() };
      saveRun(newer);
      const latest = { ...card, runIds: [old.id, newer.id], attempts: 2,
        finalStatus: 'completed' as const, elapsedMs: 1234, blockers: [] };
      saveScorecard(latest);

      const reports = await layer.recover();
      assert.ok(reports.some((r) => r.runId === old.id && r.outcome.kind === 'completed'));
      assert.equal(getRun(old.id)?.status, 'completed');
      assert.deepEqual(getScorecard(latest.id), latest, 'older recovery must not rewrite the newer attempt');
    } finally { box.cleanup(); }
  });

  it('releases the headroom in the same pass that confirms the run', async () => {
    const box = sandbox();
    try {
      // Uncertain by construction, and with a session id: reconciliation skips a
      // run that has none, so a default adapter never reaches the reconciler and
      // the run settles as `completed` instead.
      const fake = new FakeAdapter('remote-uncertain');
      fake.sessionId = 'fake-session-uncertain';
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'job-owned work',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });

      // A real dispatch that comes back uncertain: its reservation stays
      // outstanding on purpose, because nothing has established what it used.
      const dispatched = await layer.dispatch(input({ taskId: 'uncertain_task', approvalId: approval.id }));
      assert.equal(dispatched.run?.status, 'remote-uncertain');
      const reservationId = dispatched.admission?.reservationId;
      assert.ok(reservationId);
      assert.equal(listReservations().find((r) => r.id === reservationId)?.state, 'outstanding');

      // The vendor now reports it finished. One recovery pass must both record
      // that and settle the headroom it was holding.
      fake.reconcileKind = 'completed';
      // The same fake must serve recovery; the default factory would build the
      // real adapters and ask them about a session that does not exist.
      const reports = await recoverUnsettled(undefined, (_runtime: RuntimeId) => fake);

      assert.ok(
        reports.some((r) => r.runId === dispatched.run?.id),
        'recovery must have reconciled the uncertain run',
      );
      assert.equal(fake.reconcileEvidenceDir, dispatched.run?.evidenceDir, 'recovery must give the adapter durable evidence');
      assert.equal(
        listReservations().find((r) => r.id === reservationId)?.state,
        'released',
        'a run confirmed during this pass must not wait for another recovery to give its headroom back',
      );
    } finally { box.cleanup(); }
  });
  it('leaves the reservation outstanding when reconciliation still cannot confirm it', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter('remote-uncertain');
      fake.sessionId = 'fake-session-still-uncertain';
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'still uncertain',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const dispatched = await layer.dispatch(input({ taskId: 'still_uncertain', approvalId: approval.id }));
      const reservationId = dispatched.admission?.reservationId;

      await recoverUnsettled(undefined, (_runtime: RuntimeId) => fake);

      assert.equal(
        listReservations().find((r) => r.id === reservationId)?.state,
        'outstanding',
        'assuming an unconfirmed job stopped is what overspends the account',
      );
    } finally { box.cleanup(); }
  });
});
/**
 * The attempt label on runs that really ran.
 *
 * The CLI-level coverage exercises only histories where nothing was spent, so
 * every assertion there is satisfied by a constant 1. That would label real
 * retries as first attempts and record two spent attempts as one on the
 * scorecard, understating retry cost against a budget that is genuinely being
 * consumed. These dispatch through a fake adapter so attempts actually advance.
 */
describe('the attempt label counts the attempts that ran', () => {
  it('advances across real dispatches and matches what the budget spent', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'two real attempts',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });

      const first = await layer.dispatch(input({ taskId: 'attempts_task', approvalId: approval.id }));
      const second = await layer.dispatch(input({ taskId: 'attempts_task', approvalId: approval.id }));

      assert.equal(first.runtimeDispatched, true);
      assert.equal(second.runtimeDispatched, true);
      assert.equal(first.run?.attempt, 1);
      assert.equal(second.run?.attempt, 2, 'a second real attempt must not be labelled the first');

      // The budget is now spent, and the label and the budget agree about why.
      const third = await layer.dispatch(input({ taskId: 'attempts_task', approvalId: approval.id }));
      assert.equal(third.outcome.kind, 'attempts-exhausted');
      assert.match(third.outcome.summary, /2 of 2/);
    } finally { box.cleanup(); }
  });

  /** The scorecard reads its attempts figure from the label, so it moves too. */
  it('carries the advancing count onto the scorecard', async () => {
    const box = sandbox();
    try {
      const fake = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime: RuntimeId) => fake);
      const approval = layer.approve(OPERATOR, {
        repo: REPO,
        taskScope: 'scorecard attempts',
        workClass: 'ci-repair',
        runtime: 'pi-local',
        profile: 'default',
        actions: ['author-changes'],
        limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      await layer.dispatch(input({ taskId: 'card_task', approvalId: approval.id }));
      await layer.dispatch(input({ taskId: 'card_task', approvalId: approval.id }));

      // One card per task, carrying the latest attempt. A constant label would
      // record two real attempts as one and understate the retry cost.
      const cards = listScorecards().filter((c: Scorecard) => c.taskId === 'card_task');
      assert.equal(cards.length, 1);
      assert.equal(cards[0]!.attempts, 2, 'the scorecard must show both attempts, not just the first');
    } finally { box.cleanup(); }
  });
});
