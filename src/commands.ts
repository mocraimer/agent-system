import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildIdentityView, loadedBuild } from './core/build.js';
import { join } from 'node:path';
import { admit, getPolicy, listReservations, markOutstanding, releaseReservation, savePolicy, sweepStrandedReservations,
} from './core/admission.js';
import type { AdmissionDecision, SubscriptionPolicy, UsageEstimate } from './core/admission.js';
import { getLedgerPolicy, listCalls, remainingUsd, setLedgerPolicy } from './core/ledger.js';
import type { CallReservation, LedgerPolicy } from './core/ledger.js';
import type {
  ActionId, Actor, Approval, ApprovalInput, AuthorityRef, DispatchRequest, Grant, GrantInput,
  NarrowInput, PerTaskLimits, RuntimeId,
} from './core/authority.js';
import {
  assertOperator, configuredOperator as configuredOperatorId, createApproval, createGrant,
  getApproval, getGrant, listApprovals, listGrants, narrowGrant, revokeGrant,
} from './core/authority.js';
import { authorizeDispatch, FORBIDDEN_ACTIONS } from './core/authorize.js';
import type { Outcome } from './core/outcome.js';
import { activeRuns, getRun, listRuns, newRunId, saveRun, spentAttempts } from './core/run.js';
import type { RunRecord } from './core/run.js';
import { attachRun, getJob, listJobs, mayDispatchAgain, reconcileUnsettled } from './core/intake.js';
import type { Job, ReconcileReport, Reconciler } from './core/intake.js';
import { ingestCiFailure } from './core/ci-intake.js';
import type { CiFailureEvent, IntakeConfig, IntakeResult } from './core/ci-intake.js';
import { readJson, stateRoot, withLock, writeJson } from './core/store.js';
import type { CandidateIdentity } from './core/run.js';
import type { EvidenceItem, RequiredCheck, AggregateReport } from './core/evidence.js';
import { aggregate, assertOperatorDeferrals } from './core/evidence.js';
import type { RuntimeAdapter, RuntimeCapabilities, SettingsRequest, DispatchResult } from './adapters/types.js';
import { UnsupportedSettingError } from './adapters/types.js';
import { ClaudeLocalAdapter } from './adapters/claude-local.js';
import { ClaudeWebAdapter } from './adapters/claude-web.js';
import { CodexCloudAdapter } from './adapters/codex-cloud.js';
import { PiAdapter, PiEvidenceError, PiTeardownError, processGroupAbsent, retainedPiProcessId } from './adapters/pi.js';
import type { UsageResult } from './core/usage.js';
import {
  compareConfigurations, listSuites, listTrials,
} from './eval/oracle.js';
import type { CaseComparison, EvalSuite, TrialResult } from './eval/oracle.js';
import {
  blockersFor, getScorecard, groupReport, listScorecards, recordCheckResult, recordFeedback,
  recordRepairCycle, recordReview, saveScorecard, scorecardFromRun,
} from './eval/scorecard.js';
import type {
  CheckInput, FeedbackVerdict, GroupKey, GroupReport, LoopRecord, RepairInput, ReviewInput, Scorecard, UsageRecord,
} from './eval/scorecard.js';
import { activateVersion, activeVersion, listCandidates, rollback, versionHistory } from './core/version.js';
import type { ActivateInput, ActiveVersionRecord, CandidateRecord } from './core/version.js';

/** The runtimes exposed by the coordinator's public command surfaces. */
export const RUNTIMES: RuntimeId[] = ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'];

/** Configuration read by both the CLI and the MCP command layer. */
export interface Config {
  operator?: string;
  claudeCloudSessionId?: string;
  codexEnvId?: string;
  codexSkillEntryVerified?: boolean;
}

export const configPath = (): string => join(stateRoot(), 'config.json');
export const readConfig = (): Config => readJson<Config>(configPath()) ?? {};
export const writeConfig = (config: Config): void => writeJson(configPath(), config);

/** Construct the same runtime adapter the CLI uses, without accepting agent input as configuration. */
export function adapterFor(runtime: RuntimeId): RuntimeAdapter {
  const config = readConfig();
  switch (runtime) {
    case 'pi-local':
      return new PiAdapter();
    case 'claude-web':
      return new ClaudeWebAdapter('claude', config.claudeCloudSessionId);
    case 'claude-local':
      return new ClaudeLocalAdapter();
    case 'codex-cloud':
      return new CodexCloudAdapter({
        ...(config.codexEnvId ? { envId: config.codexEnvId } : {}),
        ...(config.codexSkillEntryVerified ? { skillEntryVerified: true } : {}),
      });
  }
}

export type AdapterFactory = (runtime: RuntimeId) => RuntimeAdapter;

export const VALID_ACTIONS: readonly ActionId[] = [
  'author-changes', 'open-pr', 'push-branch', 'review', 'run-verification', 'deploy-dev', 'merge-dev',
];

export const ESTIMATE_BASES: readonly UsageEstimate['basis'][] = [
  'comparable-history', 'operator-bound', 'calibration-approval', 'none',
];

/** Bounds applied at the shared command boundary before an adapter can run. */
export const DISPATCH_LIMITS = {
  identifierLength: 256,
  promptLength: 100_000,
  detailLength: 4_000,
  maxActions: 6,
  maxTimeoutMs: 3_600_000,
} as const;

export class CommandInputError extends Error {
  override readonly name = 'CommandInputError';
}

export interface StatusInput {
  taskId?: string;
  now?: number;
}

export interface StatusRun {
  run: RunRecord;
  elapsedSeconds: number;
  active: boolean;
}

export interface StatusView {
  generatedAt: string;
  runs: StatusRun[];
  reservations: ReturnType<typeof listReservations>;
}

export interface JobsView {
  generatedAt: string;
  jobs: Job[];
}

export interface UsageInput {
  runtime?: RuntimeId;
}

export interface UsageRuntimeView {
  runtime: RuntimeId;
  subscriptionId: string;
  capabilities: RuntimeCapabilities;
  policy: SubscriptionPolicy;
  reservations: ReturnType<typeof listReservations>;
  result: UsageResult;
}

export interface UsageView {
  generatedAt: string;
  runtimes: UsageRuntimeView[];
}

export interface ReadinessInput {
  runtime?: RuntimeId;
}

export interface ReadinessRuntimeView {
  runtime: RuntimeId;
  capabilities: RuntimeCapabilities;
  ready: boolean;
  outcome: Outcome | null;
}

export interface ReadinessView {
  generatedAt: string;
  runtimes: ReadinessRuntimeView[];
}

export interface EvidenceInput {
  candidate?: CandidateIdentity;
  evidence?: EvidenceItem[];
  enforceDeferred?: readonly string[];
  maxEvidenceAgeMs?: number;
  now?: number;
}

export interface EvidenceView {
  generatedAt: string;
  requiredChecks: RequiredCheck[];
  deferred: string[];
  evidenceCount: number;
  configuration: { valid: true } | { valid: false; error: string };
  report?: AggregateReport;
}

export type EvaluationViewName = 'summary' | 'scorecards' | 'suites' | 'trials' | 'compare';

export interface EvaluationInput {
  view?: EvaluationViewName;
  repo?: string;
  workClass?: string;
  runtime?: RuntimeId;
  authorityId?: string;
  effectiveConfiguration?: string;
  workflowVersion?: string;
  configurationA?: string;
  configurationB?: string;
}

export type EvaluationView =
  | {
      view: 'summary';
      scorecards: { report: Omit<GroupReport, 'evidence' | 'recordedAttempts'>; count: number };
      suites: { count: number };
      trials: { count: number };
    }
  | { view: 'scorecards'; scorecards: Scorecard[]; report: GroupReport }
  | { view: 'suites'; suites: EvalSuite[] }
  | { view: 'trials'; trials: TrialResult[] }
  | { view: 'compare'; configurationA: string; configurationB: string; comparisons: CaseComparison[] };

export interface DispatchTaskInput {
  taskId: string;
  repo: string;
  workClass: string;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  approvalId?: string;
  triggerSource?: string;
  prBase?: string;
  targetProject?: string;
  prompt: string;
  repoPath?: string;
  jobId?: string;
  settings: SettingsRequest;
  estimate: UsageEstimate;
  timeoutMs?: number;
  /** How the prompt reaches the runtime; see `DispatchInput.entry`. Defaults to the skill entry. */
  entry?: 'skill' | 'review-pr' | 'prompt';
  /** The versioned template the prompt was rendered from, recorded on the run's settings snapshot. */
  promptVersion?: { template: string; digest: string };
  outputPath?: string;
  loop?: LoopRecord;
  setupStartedAt?: string;
}

/** The file in a run's evidence directory that holds the dispatch request it was started from. */
export const DISPATCH_REQUEST_FILE = 'dispatch-request.json';

export interface DispatchCommandResult {
  outcome: Outcome;
  recovered: ReconcileReport[];
  /** True only after the selected runtime adapter's dispatch method was called. */
  runtimeDispatched: boolean;
  authority?: AuthorityRef;
  limits?: PerTaskLimits;
  admission?: AdmissionDecision;
  run?: RunRecord;
}

/**
 * Record only what admission knew about usage.
 *
 * The account delta is intentionally absent: other activity may have changed the
 * same subscription, so it cannot be presented as this run's consumption.
 */
function admissionUsage(admission: AdmissionDecision): UsageRecord {
  const resetContext = admission.windows
    .filter((window) => window.resetsAt !== undefined)
    .map((window) => `${window.kind} resets ${window.resetsAt}`)
    .join('; ');
  return {
    admissionEstimatePercent: {
      fiveHour: admission.estimate.fiveHourPercent,
      weekly: admission.estimate.weeklyPercent,
    },
    deltaContaminated: true,
    ...(admission.reservationId ? { reservationId: admission.reservationId } : {}),
    ...(resetContext ? { resetContext } : {}),
  };
}

/** Settle future exposure, not consumption: account-wide usage deltas are not per-run charges. */
function settleDispatchedReservation(reservationId: string | undefined, outcome: Outcome): void {
  if (!reservationId) return;
  switch (outcome.kind) {
    case 'completed':
    case 'checks-failed':
    case 'refused':
    case 'unsupported-settings':
    case 'attempts-exhausted':
      releaseReservation(reservationId, `Run settled (${outcome.kind}); no future headroom needed.`);
      break;
    default:
      // Local observation ending is not proof that uncertain work stopped.
      markOutstanding(reservationId, `Run remains ${outcome.kind}: ${outcome.summary}`);
  }
}

function finalizeDispatchedRun(
  record: RunRecord, outcome: Outcome, admission: AdmissionDecision, repo: string, workClass: string,
): { run: RunRecord; outcome: Outcome } {
  return withLock(`run-${record.id}`, () => {
    const current = getRun(record.id);
    if (current?.stopAttestation) {
      return {
        run: current,
        outcome: {
          kind: 'checks-failed', runId: current.id, taskId: current.taskId,
          summary: current.summary ?? 'Pi process stopped by operator; task result unverified.',
          nextAction: 'Inspect retained evidence before retrying.',
          ...(current.promptNotSent === true ? { promptNotSent: true } : {}),
        },
      };
    }
    saveRun(record);
    settleDispatchedReservation(admission.reservationId, outcome);
    persistScorecard(record, outcome, repo, workClass, admission);
    return { run: record, outcome };
  });
}

function persistScorecard(
  run: RunRecord,
  outcome: Outcome,
  repo: string,
  workClass: string,
  admission: AdmissionDecision,
): void {
  const id = `card_${run.taskId}`;
  // Evidence and feedback writers use this same lock. A later task attempt must
  // not erase what was learned from earlier attempts or a concurrent review.
  withLock(`scorecard-${id}`, () => {
    const previous = getScorecard(id);
    const card = scorecardFromRun(run, {
      repo,
      workClass,
      workflowVersion: run.build?.digest ?? 'unversioned',
    });
    saveScorecard({
      ...card,
      ...(previous?.reviews ? { reviews: previous.reviews } : {}),
      ...(previous?.feedback ? { feedback: previous.feedback } : {}),
      ...(previous?.feedbackHistory ? { feedbackHistory: previous.feedbackHistory } : {}),
      ...(previous?.attestedDeliveries ? { attestedDeliveries: previous.attestedDeliveries } : {}),
      ...(previous?.prUrl ? { prUrl: previous.prUrl } : {}),
      ...(run.loop ? { loop: run.loop } : previous?.loop ? { loop: previous.loop } : {}),
      ...(previous?.stops ? { stops: previous.stops } : {}),
      createdAt: previous?.createdAt ?? card.createdAt,
      runIds: [...new Set([...(previous?.runIds ?? []), ...card.runIds])],
      manifestPaths: [...new Set([...(previous?.manifestPaths ?? []), ...card.manifestPaths])],
      checks: previous?.checks ?? [],
      reviewerFindings: previous?.reviewerFindings ?? [],
      repairs: previous?.repairs ?? [],
      usage: admissionUsage(admission),
      blockers: blockersFor(outcome),
    });
  });
}

export interface AuthorityView {
  generatedAt: string;
  operatorConfigured: boolean;
  approvals: Approval[];
  grants: Grant[];
}

export interface PolicyView {
  generatedAt: string;
  policy: SubscriptionPolicy;
}

export interface LedgerView {
  generatedAt: string;
  policy: LedgerPolicy;
  remainingUsd: number;
  calls: CallReservation[];
}

export interface VersionView {
  generatedAt: string;
  active: ActiveVersionRecord | null;
  candidates: CandidateRecord[];
  history: ActiveVersionRecord[];
  identity: ReturnType<typeof buildIdentityView>;
}

export interface FeedbackInput {
  verdict: FeedbackVerdict;
  reason: string;
}

export interface CheckMutationResult {
  checks: RequiredCheck[];
  changed: RequiredCheck;
}

export function authorityView(): AuthorityView {
  return {
    generatedAt: new Date().toISOString(),
    operatorConfigured: configuredOperatorId() !== undefined,
    approvals: listApprovals(),
    grants: listGrants(),
  };
}

export function policyView(subscriptionId: string): PolicyView {
  return { generatedAt: new Date().toISOString(), policy: getPolicy(subscriptionId) };
}

export function ledgerView(): LedgerView {
  return {
    generatedAt: new Date().toISOString(),
    policy: getLedgerPolicy(),
    remainingUsd: remainingUsd(),
    calls: listCalls(),
  };
}

export function versionView(): VersionView {
  return {
    generatedAt: new Date().toISOString(),
    active: activeVersion() ?? null,
    candidates: listCandidates(),
    history: versionHistory(),
    identity: buildIdentityView(activeVersion()?.coordinator),
  };
}

/** Operator-only authority creation; the MCP surface intentionally does not expose this. */
export function approve(actor: Actor, input: ApprovalInput): Approval {
  return createApproval(actor, input);
}

export function approvalList(): Approval[] {
  return listApprovals();
}

export function approvalGet(id: string): Approval | undefined {
  return getApproval(id);
}

/** Operator-only grant lifecycle methods; narrowing still cannot widen. */
export function grantCreate(actor: Actor, input: GrantInput): Grant {
  return createGrant(actor, input);
}

export function grantList(): Grant[] {
  return listGrants();
}

export function grantGet(id: string): Grant | undefined {
  return getGrant(id);
}

export function grantNarrow(actor: Actor, id: string, input: NarrowInput): Grant {
  return narrowGrant(actor, id, input);
}

export function grantRevoke(actor: Actor, id: string, reason: string): Grant {
  return revokeGrant(actor, id, reason);
}

/** Change a subscription threshold through the same operator gate as the CLI. */
export function policySet(actor: Actor, policy: SubscriptionPolicy): SubscriptionPolicy {
  assertOperator(actor);
  if (!Number.isFinite(policy.fiveHourThresholdPercent) || !Number.isFinite(policy.weeklyThresholdPercent) ||
      !Number.isFinite(policy.safetyMarginPercent) || !Number.isFinite(policy.maxReadingAgeSeconds)) {
    throw new CommandInputError('Policy values must be finite numbers.');
  }
  savePolicy(policy);
  return getPolicy(policy.subscriptionId);
}

/** Change the paid-call allowance through an operator-only path. */
export function ledgerAllowanceSet(actor: Actor, allowanceUsd: number): LedgerPolicy {
  assertOperator(actor);
  if (!Number.isFinite(allowanceUsd) || allowanceUsd < 0) {
    throw new CommandInputError('Paid-call allowance must be a finite non-negative number.');
  }
  const next: LedgerPolicy = {
    allowanceUsd,
    setBy: actor.id,
    setAt: new Date().toISOString(),
  };
  setLedgerPolicy(next);
  return next;
}

/** Defer a check only as the configured operator, and return the full new list. */
export function checkDefer(actor: Actor, name: string, reason: string): CheckMutationResult {
  return mutateCheckList(actor, name, reason, true);
}

export function checkRestore(actor: Actor, name: string): CheckMutationResult {
  return mutateCheckList(actor, name, undefined, false);
}

function mutateCheckList(
  actor: Actor,
  name: string,
  reason: string | undefined,
  defer: boolean,
): CheckMutationResult {
  assertOperator(actor);
  if (name.trim() === '') throw new CommandInputError('Check name must not be empty.');
  if (defer && (!reason || reason.trim() === '')) throw new CommandInputError('A deferral needs a reason.');
  return withLock('required-checks', () => {
    const path = join(stateRoot(), 'required-checks.json');
    const checks = readJson<RequiredCheck[]>(path) ?? [];
    const changed = checks.find((check) => check.name === name);
    if (!changed) throw new CommandInputError(`No required check named "${name}".`);
    if (defer) {
      changed.deferral = {
        reason: reason!,
        deferredBy: actor.id,
        deferredAt: new Date().toISOString(),
      };
    } else {
      delete changed.deferral;
    }
    writeJson(path, checks);
    return { checks, changed };
  });
}

/** Record a human verdict; agent/evaluation text cannot supply the actor. */
export function feedbackRecord(actor: Actor, scorecardId: string, input: FeedbackInput): Scorecard {
  assertOperator(actor);
  if (!['accepted', 'rework-needed', 'rejected'].includes(input.verdict)) {
    throw new CommandInputError(`Feedback verdict must be accepted, rework-needed or rejected.`);
  }
  return recordFeedback(scorecardId, { verdict: input.verdict, by: actor.id, reason: input.reason });
}

/** Evidence is operator-attested data; it grants no authority or acceptance. */
export function checkResultRecord(actor: Actor, scorecardId: string, input: CheckInput): Scorecard {
  assertOperator(actor);
  return recordCheckResult(scorecardId, input);
}

export function reviewRecord(actor: Actor, scorecardId: string, input: ReviewInput): Scorecard {
  assertOperator(actor);
  return recordReview(scorecardId, input);
}

export function repairRecord(
  actor: Actor, scorecardId: string, input: RepairInput,
): Scorecard {
  assertOperator(actor);
  return recordRepairCycle(scorecardId, input);
}

export function versionActivate(actor: Actor, input: ActivateInput): ActiveVersionRecord {
  return activateVersion(actor, input);
}

export function versionRollback(actor: Actor): ActiveVersionRecord {
  return rollback(actor);
}

/** Record a CI event as data and apply the existing grant/intake rules. */
export function intakeFailure(event: CiFailureEvent, input: IntakeConfig): IntakeResult {
  return ingestCiFailure(event, input);
}

/**
 * Read the current run and reservation records without making a vendor call.
 * `elapsedSeconds` is a fact about wall-clock time, not a progress estimate.
 */
export function statusView(input: StatusInput = {}): StatusView {
  const now = input.now ?? Date.now();
  const runs = listRuns()
    .filter((run) => input.taskId === undefined || run.taskId === input.taskId)
    .map((run) => ({
      run,
      elapsedSeconds: Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)) / 1000)),
      active: run.status === 'running' || run.status === 'remote-uncertain',
    }));
  return {
    generatedAt: new Date(now).toISOString(),
    runs,
    reservations: listReservations(),
  };
}

export function jobsView(): JobsView {
  return { generatedAt: new Date().toISOString(), jobs: listJobs() };
}

export async function usageView(
  input: UsageInput = {},
  adapterFactory: AdapterFactory = adapterFor,
): Promise<UsageView> {
  const runtimes = input.runtime === undefined ? RUNTIMES : [input.runtime];
  const entries: UsageRuntimeView[] = [];
  for (const runtime of runtimes) {
    const adapter = adapterFactory(runtime);
    entries.push({
      runtime,
      subscriptionId: adapter.capabilities.subscriptionId,
      capabilities: adapter.capabilities,
      policy: getPolicy(adapter.capabilities.subscriptionId),
      reservations: listReservations(adapter.capabilities.subscriptionId),
      result: await adapter.readUsage(),
    });
  }
  return { generatedAt: new Date().toISOString(), runtimes: entries };
}

export async function readinessView(
  input: ReadinessInput = {},
  adapterFactory: AdapterFactory = adapterFor,
): Promise<ReadinessView> {
  const runtimes = input.runtime === undefined ? RUNTIMES : [input.runtime];
  const entries: ReadinessRuntimeView[] = [];
  for (const runtime of runtimes) {
    const adapter = adapterFactory(runtime);
    const outcome = await adapter.checkReadiness();
    entries.push({
      runtime,
      capabilities: adapter.capabilities,
      ready: outcome === undefined,
      outcome: outcome ?? null,
    });
  }
  return { generatedAt: new Date().toISOString(), runtimes: entries };
}

export function evidenceView(input: EvidenceInput = {}): EvidenceView {
  const checks = readJson<RequiredCheck[]>(join(stateRoot(), 'required-checks.json')) ?? [];
  const configuration = validateCheckConfiguration(checks);
  const view: EvidenceView = {
    generatedAt: new Date().toISOString(),
    requiredChecks: checks,
    deferred: checks.filter((check) => check.deferral !== undefined).map((check) => check.name),
    evidenceCount: input.evidence?.length ?? 0,
    configuration,
  };

  if (configuration.valid && input.candidate !== undefined) {
    view.report = aggregate(input.candidate, checks, input.evidence ?? [], {
      ...(input.enforceDeferred ? { enforceDeferred: input.enforceDeferred } : {}),
      ...(input.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: input.maxEvidenceAgeMs } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
  }
  return view;
}

function validateCheckConfiguration(
  checks: RequiredCheck[],
): EvidenceView['configuration'] {
  if (checks.length === 0) {
    return {
      valid: false,
      error: 'No required checks are configured; acceptance cannot be established.',
    };
  }
  const configured = readConfig().operator;
  if (configured === undefined && checks.some((check) => check.deferral !== undefined)) {
    return {
      valid: false,
      error: 'A deferred check exists but no operator is configured; its authorship cannot be verified.',
    };
  }
  if (configured !== undefined) {
    try {
      assertOperatorDeferrals(checks, configured);
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { valid: true };
}

export function evaluationView(input: EvaluationInput = {}): EvaluationView {
  const view = input.view ?? 'summary';
  const cards = listScorecards();
  const key: GroupKey = {
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    ...(input.workClass !== undefined ? { workClass: input.workClass } : {}),
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
    ...(input.effectiveConfiguration !== undefined ? { effectiveConfiguration: input.effectiveConfiguration } : {}),
    ...(input.workflowVersion !== undefined ? { workflowVersion: input.workflowVersion } : {}),
  };

  switch (view) {
    case 'summary': {
      const { evidence: _evidence, recordedAttempts: _attempts, ...report } = groupReport(cards, key);
      return {
        view,
        scorecards: { report, count: report.sampleCount },
        suites: { count: listSuites().length },
        trials: { count: listTrials().length },
      };
    }
    case 'scorecards': {
      const report = groupReport(cards, key);
      const ids = new Set(report.evidence.map((entry) => entry.scorecardId));
      return { view, scorecards: cards.filter((card) => ids.has(card.id)), report };
    }
    case 'suites':
      return { view, suites: listSuites() };
    case 'trials':
      return { view, trials: listTrials() };
    case 'compare': {
      const a = input.configurationA;
      const b = input.configurationB;
      if (!a || !b) {
        throw new CommandInputError('configurationA and configurationB are required for an evaluation comparison.');
      }
      return { view, configurationA: a, configurationB: b, comparisons: compareConfigurations(listTrials(), a, b) };
    }
  }
}

export interface ResolvePiInput {
  runId: string;
  confirmStopped: boolean;
  evidence: string;
  reason: string;
}

/** Manual recovery only: the operator checked the group AND escaped descendants. */
export function resolvePiStopped(actor: Actor, input: ResolvePiInput): RunRecord {
  assertOperator(actor);
  if (!input.confirmStopped) throw new CommandInputError('Explicit --confirm-stopped is required.');
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new CommandInputError('A valid run ID is required.');
  for (const [name, value] of [['evidence', input.evidence], ['reason', input.reason]] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > DISPATCH_LIMITS.detailLength) {
      throw new CommandInputError(`${name} must be nonempty and at most ${DISPATCH_LIMITS.detailLength} characters.`);
    }
  }
  return withLock(`run-${input.runId}`, () => {
    const run = getRun(input.runId);
    if (!run) throw new CommandInputError(`No run "${input.runId}".`);
    if (run.runtime !== 'pi-local' || run.runtimeDispatched !== true) {
      throw new CommandInputError('Only an already dispatched Pi run can be stop-attested.');
    }
    if (run.stopAttestation) {
      const prior = run.stopAttestation;
      if (prior.by !== actor.id || prior.evidence !== input.evidence || prior.reason !== input.reason) {
        throw new CommandInputError(`Run ${run.id} already has a different stop attestation.`);
      }
      // A crash may have occurred after saving the run but before releasing its
      // reservation or repairing the card. Replay completes those exact writes.
      repairPiStop(run);
      return run;
    }
    if (run.status !== 'running' && run.status !== 'remote-uncertain' && run.status !== 'setup-blocked') {
      throw new CommandInputError(`Run ${run.id} is ${run.status}, not unsettled.`);
    }
    const reservation = listReservations().find((r) => r.id === run.admissionId);
    if (!reservation || reservation.runId !== run.id || reservation.taskId !== run.taskId ||
      (reservation.state !== 'held' && reservation.state !== 'outstanding')) {
      throw new CommandInputError(`Run ${run.id} has no matching held reservation.`);
    }
    // No PID is not proof of stop; it is allowed only because the operator has
    // explicitly attested to inspecting all local work and stopping it.
    const processId = retainedPiProcessId(run.evidenceDir);
    if (processId !== undefined && !processGroupAbsent(processId)) {
      throw new CommandInputError(`Pi process group ${processId} exists or cannot be inspected; stop it before attesting.`);
    }
    const now = new Date().toISOString();
    const next: RunRecord = {
      ...run, status: 'checks-failed', endedAt: now,
      summary: 'Pi process stopped by operator attestation; task result unverified.',
      delivery: { status: 'unverified', reason: 'Pi stop attested; task result and delivery unverified.', evidence: [] },
      stopAttestation: {
        kind: 'pi-process-stopped', by: actor.id, at: now, reason: input.reason,
        evidence: input.evidence, priorStatus: run.status,
        ...(processId !== undefined ? { processId } : {}),
      },
    };
    saveRun(next);
    repairPiStop(next);
    return next;
  });
}

function repairPiStop(run: RunRecord): void {
  if (run.admissionId) {
    const reservation = listReservations().find((r) => r.id === run.admissionId);
    if (!reservation || reservation.runId !== run.id || reservation.taskId !== run.taskId) {
      throw new CommandInputError(`Run ${run.id} has no matching reservation to repair.`);
    }
    releaseReservation(reservation.id, 'Pi process stopped by operator attestation; usage is not inferred.');
  }
  repairTerminalScorecard(run.id, true);
}

/** Replay a terminal run onto its latest card after either stop attestation or recovery. */
function repairTerminalScorecard(runId: string, manualReplay = false): void {
  const run = getRun(runId);
  if (!run || (run.status !== 'completed' && run.status !== 'checks-failed')) return;
  const id = `card_${run.taskId}`;
  withLock(`scorecard-${id}`, () => {
    // Re-read under the card lock: a delayed recovery must not project its old
    // snapshot after a manual stop or a newer attempt has updated the card.
    const latest = getRun(runId);
    if (!latest || (latest.status !== 'completed' && latest.status !== 'checks-failed')) return;
    const existing = getScorecard(id);
    const card = existing ?? (manualReplay && latest.repo && latest.workClass ? scorecardFromRun(latest, {
      repo: latest.repo, workClass: latest.workClass, workflowVersion: latest.build?.digest ?? 'unversioned',
    }) : undefined);
    if (!card || card.runIds.at(-1) !== latest.id || card.taskId !== latest.taskId) return;
    // Recovery repairs unresolved cards. A stop replay can also finish a card
    // whose status was saved but whose other terminal fields were not.
    if (!manualReplay && card.finalStatus !== 'running' && card.finalStatus !== 'remote-uncertain') return;
    saveScorecard({
      ...card, finalStatus: latest.status,
      blockers: blockersFor({ kind: latest.status, summary: latest.summary ?? '' }),
      ...(latest.endedAt ? { elapsedMs: Date.parse(latest.endedAt) - Date.parse(latest.startedAt) } : {}),
    });
  });
}

export interface RunStopResult {
  runId: string;
  taskId: string;
  stoppedBy: string;
  at: string;
}

/**
 * Stop a run in flight, as an operator.
 *
 * Signals the runtime's process; the dispatch that started the run then records
 * how it ended, and its reservation is settled by the ordinary recovery path. The
 * stop itself is recorded on the task's scorecard with who made it.
 */
export async function runStop(actor: Actor, runId: string, adapterFactory: AdapterFactory = adapterFor): Promise<RunStopResult> {
  assertOperator(actor);
  const run = getRun(runId);
  if (!run) throw new CommandInputError(`No run "${runId}".`);
  if (run.status !== 'running') throw new CommandInputError(`Run ${runId} is ${run.status}, not running; there is nothing to stop.`);
  const adapter = adapterFactory(run.runtime);
  if (!adapter.stop) throw new CommandInputError(`${run.runtime} gives the coordinator no way to stop a run; stop it in the runtime itself.`);
  const signalled = await adapter.stop(run.sessionId ?? run.id);
  if (!signalled) {
    throw new CommandInputError(`No live process for run ${runId} on this machine. If it ended without being recorded, recover unsettled work.`);
  }
  const at = new Date().toISOString();
  const id = `card_${run.taskId}`;
  // A run's scorecard is written when its dispatch returns, which may be after
  // this: the stop then starts the card from the run and its kept request, and
  // the dispatch's own write keeps the stop.
  const request = run.evidenceDir ? readJson<DispatchTaskInput>(join(run.evidenceDir, DISPATCH_REQUEST_FILE)) : undefined;
  withLock(`scorecard-${id}`, () => {
    const card = getScorecard(id) ?? (request ? scorecardFromRun(run, {
      repo: request.repo, workClass: request.workClass, workflowVersion: run.build?.digest ?? 'unversioned',
    }) : undefined);
    if (card) saveScorecard({ ...card, stops: [...(card.stops ?? []), { runId, by: actor.id, at }] });
  });
  return { runId, taskId: run.taskId, stoppedBy: actor.id, at };
}

/**
 * Send a finished or stopped run's task again: the same request, so the same
 * text and the same authority, as a new run with a new id.
 */
export async function runRedispatch(actor: Actor, runId: string, adapterFactory: AdapterFactory = adapterFor): Promise<DispatchCommandResult> {
  assertOperator(actor);
  const run = getRun(runId);
  if (!run) throw new CommandInputError(`No run "${runId}".`);
  if (run.status === 'running') throw new CommandInputError(`Run ${runId} is still running; stop it before sending its task again.`);
  const request = run.evidenceDir ? readJson<DispatchTaskInput>(join(run.evidenceDir, DISPATCH_REQUEST_FILE)) : undefined;
  if (!request) throw new CommandInputError(`Run ${runId} kept no dispatch request, so its task cannot be sent again as it was.`);
  // Old loop and replay-review requests named a shared output in their prompt
  // without declaring outputPath. A retry could overwrite the first attempt.
  const outputBearingStage = /^(shape|assess|review|fix|improve)$/;
  if (!request.outputPath && (
    (request.loop && outputBearingStage.test(request.loop.stage)) ||
    /^loop-(shape|assess|review|fix|improve)$/.test(request.workClass) ||
    request.workClass === 'replay-review'
  )) {
    throw new CommandInputError(`Run ${runId} predates attempt-owned output paths. Its prompt may write over the earlier attempt; inspect its retained evidence and dispatch a new task explicitly instead of redispatching it.`);
  }
  const decision = authorizeDispatch(toAuthorityRequest(request));
  if (!decision.allowed) return { outcome: decision.outcome, recovered: [], runtimeDispatched: false };
  if (decision.authority.id !== run.authority.id) {
    throw new CommandInputError(`${run.authority.type} ${run.authority.id}, which authorized run ${runId}, no longer covers its task; ${decision.authority.id} would. Dispatch it anew instead.`);
  }
  // The prompt and authority remain the same, but a pre-dispatch PR observation
  // belongs to the original attempt. A CLI retry has not freshly checked the PR,
  // so it cannot inherit a description baseline or a no-PR-at-dispatch claim.
  const retryLoop = request.loop ? { ...request.loop } : undefined;
  if (retryLoop) {
    delete retryLoop.descriptionBeforeDigest;
    delete retryLoop.reviewCommentAtDispatch;
    delete retryLoop.sweepNoPullAtDispatch;
  }
  const retryRequest = { ...request, ...(retryLoop ? { loop: retryLoop } : {}) };
  // Setup time is an observation of the original attempt, not part of its task.
  delete retryRequest.setupStartedAt;
  return dispatchTask(retryRequest, adapterFactory);
}

/** Reconcile only the selected runtime, or every runtime for the public recovery command. */
export async function recoverUnsettled(
  runtimeFilter?: RuntimeId,
  adapterFactory: AdapterFactory = adapterFor,
): Promise<ReconcileReport[]> {
  // Build every reconciler so a missing adapter is never reported for a runtime the
  // caller deliberately filtered out. `onlyRuntime` scopes which stored runs are
  // queried, matching the CLI's runtime-filtered recovery path.
  const reconcilers: Reconciler[] = RUNTIMES.map((runtime) => {
    const adapter = adapterFactory(runtime);
    return { runtime, reconcile: (sessionId: string, evidenceDir?: string) => adapter.reconcile(sessionId, evidenceDir) };
  });
  const reports = await reconcileUnsettled(reconcilers, runtimeFilter);
  // A prior recovery may have saved the terminal run but died before saving its
  // card. Recheck unresolved latest cards even when this pass has no new report.
  for (const unresolved of listScorecards()) {
    if (unresolved.finalStatus !== 'running' && unresolved.finalStatus !== 'remote-uncertain') continue;
    const runId = unresolved.runIds.at(-1);
    const run = runId ? getRun(runId) : undefined;
    if (run && run.taskId === unresolved.taskId && (!runtimeFilter || run.runtime === runtimeFilter)) {
      repairTerminalScorecard(run.id);
    }
  }

  // Reconciliation only asks vendors about work that may still be running, so a
  // reservation stranded by a run that already stopped would never be reached.
  // Sweeping here gives it the one supported way out.
  sweepStrandedReservations(
    listRuns().map((run) => ({ id: run.id, status: run.status, reservationId: run.admissionId })),
  );

  return reports;
}

/**
 * Run the CLI's dispatch sequence for any client.
 *
 * Authority is checked before recovery and admission. This means a pending MCP
 * request cannot make a vendor status call, reserve allowance, or create a run.
 * Once a request has an authority match, recovery across all runtimes and a second
 * authorization check close the small window in which a grant could have been
 * revoked or a run could have become concurrent.
 */
export async function dispatchTask(
  input: DispatchTaskInput,
  adapterFactory: AdapterFactory = adapterFor,
): Promise<DispatchCommandResult> {
  assertDispatchInput(input);
  const authorityRequest = toAuthorityRequest(input);
  const initial = authorizeDispatch(authorityRequest);
  if (!initial.allowed) return { outcome: initial.outcome, recovered: [], runtimeDispatched: false };

  const adapter = adapterFactory(input.runtime);
  // A task's concurrency limit is per task, not per runtime. Reconcile every
  // runtime before dispatching so a stale run on another adapter cannot be
  // mistaken for free capacity.
  const recovered = await recoverUnsettled(undefined, adapterFactory);
  const decision = authorizeDispatch(authorityRequest);
  if (!decision.allowed) return { outcome: decision.outcome, recovered, runtimeDispatched: false };

  // A task without an explicit job id still cannot start a duplicate while one
  // of its recovered runs is unresolved. Job-aware callers get the same check
  // again below through mayDispatchAgain; this closes the task-only path too.
  if (input.jobId === undefined) {
    // A task intake raised has a job, and a dispatch that does not name it never
    // attaches its run. The job then stays open with no runs, and the next
    // delivery of the same signal sees no attempt to refuse and starts a second
    // repair. Refusing here is what makes the redelivery guard mean anything,
    // since fixing the printed hint only helps callers who read it.
    const existing = listJobs().find((job) => job.taskId === input.taskId && job.state === 'open');
    if (existing) {
      const outcome: Outcome = {
        kind: 'refused',
        taskId: input.taskId,
        summary: `Task ${input.taskId} belongs to job ${existing.id}; a dispatch that does not name it would leave the run unattached.`,
        nextAction: `Dispatch it with \`--job ${existing.id}\` so the attempt is recorded against the work it belongs to.`,
        details: { job: existing.id },
      };
      return { outcome, recovered, runtimeDispatched: false };
    }

    const blocked = recovered.filter((report) => {
      if (!report.blocksNewAttempt) return false;
      return listRuns().find((run) => run.id === report.runId)?.taskId === input.taskId;
    });
    if (blocked.length > 0) {
      const outcome: Outcome = {
        kind: 'remote-uncertain',
        taskId: input.taskId,
        summary: `${blocked.length} earlier run(s) for this task have unresolved remote state.`,
        nextAction:
          'Resolve or explicitly abandon those sessions first. Launching a second worker while the first is unaccounted for is how one task becomes two.',
        details: { runs: blocked.map((report) => `${report.runId}: ${report.outcome.summary}`) },
      };
      return { outcome, recovered, runtimeDispatched: false };
    }
  }

  const runId = newRunId();
  const evidenceDir = join(stateRoot(), 'evidence', runId);
  const attempt = spentAttempts(input.taskId).length + 1;
  const sessionId = adapter.newSessionId?.();
  // Each dispatch owns its output, even when replaying an earlier request.
  const attemptOutput = input.outputPath ? join(evidenceDir, 'output.md') : undefined;
  const attemptInput = attemptOutput ? { ...input, outputPath: attemptOutput, prompt: input.prompt.split(input.outputPath!).join(attemptOutput) } : input;
  const inFlight: RunRecord = {
    id: runId,
    taskId: input.taskId,
    attempt,
    ...(sessionId ? { sessionId } : {}),
    authority: decision.authority,
    limits: decision.limits,
    runtime: input.runtime,
    profile: input.profile,
    actions: input.actions,
    settings: {
      requested: {
        model: input.settings.model ?? 'vendor-default',
        effort: input.settings.effort ?? 'vendor-default',
      },
      // Seeded with what is already decided, in the precedence `resolveSettings`
      // uses: the caller's explicit setting, then the approved tier, then the
      // vendor default. The adapter's own snapshot replaces this when it returns.
      //
      // Hard-coding vendor defaults here recorded `vendor-default/vendor-default`
      // for a tiered run whenever the adapter never returned — a quota refusal, a
      // status read taken during dispatch, an adapter throw, or the process dying.
      // Those are exactly the records someone later reads to find out what a run
      // was authorized to spend.
      resolved: {
        model: input.settings.model ?? decision.tier?.model ?? 'vendor-default',
        effort: input.settings.effort ?? decision.tier?.effort ?? 'vendor-default',
      },
      observed: { model: 'unknown', effort: 'unknown' },
      ...(input.promptVersion ? { prompt: input.promptVersion } : {}),
    },
    startedAt: new Date().toISOString(),
    status: 'running',
    evidenceDir,
    build: loadedBuild,
    repo: input.repo,
    workClass: input.workClass,
    runtimeDispatched: false,
    ...(input.loop ? { loop: input.loop } : {}),
    ...(attemptOutput ? { outputPath: attemptOutput } : {}),
    promptDigest: createHash('sha256').update(attemptInput.prompt).digest('hex'),
    delivery: { status: 'unverified', reason: 'No task artifact has been verified.', evidence: [] },
    timing: { setupStartedAt: input.setupStartedAt ?? new Date().toISOString() },
  };

  const admission = await admit({
    subscriptionId: adapter.capabilities.subscriptionId,
    taskId: input.taskId,
    runId,
    estimate: input.estimate,
    readUsage: () => adapter.readUsage(),
  });
  if (!admission.admitted) {
    // Admission can refuse before the runtime is reached. Keep that refusal as
    // non-executed history so quota failures are visible without making them
    // consume the task's attempt budget (authorize.ts excludes quota-waiting).
    const outcome = admission.outcome!;
    const refused: RunRecord = {
      ...inFlight,
      endedAt: new Date().toISOString(),
      status: outcome.kind,
      summary: outcome.summary,
    };
    saveRun(refused);
    persistScorecard(refused, outcome, input.repo, input.workClass, admission);
    return {
      outcome,
      recovered,
      authority: decision.authority,
      limits: decision.limits,
      admission,
      run: refused,
      runtimeDispatched: false,
    };
  }

  // The run is durable before vendor dispatch. A process dying here leaves the
  // session deliberately uncertain instead of disappearing or looking cancelled.
  const recordedInFlight: RunRecord = {
    ...inFlight,
    ...(admission.reservationId ? { admissionId: admission.reservationId } : {}),
  };
  saveRun(recordedInFlight);

  if (input.jobId !== undefined) {
    const job = getJob(input.jobId);
    if (!job) {
      const outcome: Outcome = {
        kind: 'refused',
        taskId: input.taskId,
        runId,
        summary: `Job ${input.jobId} does not exist; the run was not sent to the runtime.`,
        nextAction: 'Use the jobs view to find the existing job, or dispatch without a job id.',
      };
      const record: RunRecord = {
        ...recordedInFlight,
        status: 'refused',
        endedAt: new Date().toISOString(),
        summary: outcome.summary,
      };
      saveRun(record);
      if (admission.reservationId) releaseReservation(admission.reservationId, 'job did not exist');
      persistScorecard(record, outcome, input.repo, input.workClass, admission);
      return { outcome, recovered, admission, run: record, runtimeDispatched: false };
    }
    const blocked = mayDispatchAgain(input.jobId, recovered);
    if (blocked) {
      const record: RunRecord = {
        ...recordedInFlight,
        status: 'remote-uncertain',
        endedAt: new Date().toISOString(),
        summary: blocked.summary,
      };
      saveRun(record);
      // Only this never-dispatched attempt is released; the earlier uncertain run keeps its reservation.
      if (admission.reservationId) releaseReservation(admission.reservationId, 'earlier run unresolved; this attempt was not dispatched');
      persistScorecard(record, blocked, input.repo, input.workClass, admission);
      return { outcome: blocked, recovered, admission, run: record, runtimeDispatched: false };
    }
    // The CLI and MCP both retain the job's artifacts and obligations through this attachment.
    // The existence check above happens before the adapter runs.
    attachRun(job.id, recordedInFlight);
  }

  // What was asked, kept beside the run's evidence so the same task can be sent
  // again under the same authority after a stop. No credential is part of it.
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, DISPATCH_REQUEST_FILE), JSON.stringify(attemptInput, null, 2), 'utf8');
  recordedInFlight.runtimeDispatched = true;
  recordedInFlight.timing = { ...recordedInFlight.timing, dispatchStartedAt: new Date().toISOString() };
  saveRun(recordedInFlight);
  persistScorecard(recordedInFlight, { kind: 'remote-uncertain', summary: 'Runtime dispatch in progress.', nextAction: 'Wait for completion or reconcile.' }, input.repo, input.workClass, admission);

  let result: DispatchResult;
  try {
    result = await adapter.dispatch({
      taskId: input.taskId,
      runId,
      task: attemptInput.prompt,
      repoPath: input.repoPath ?? process.cwd(),
      settings: input.settings,
      evidenceDir,
      actions: input.actions,
      ...(sessionId ? { sessionId } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
      ...(decision.tier ? { approvedTier: decision.tier } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsupportedSettingError) {
      const outcome: Outcome = {
        kind: 'unsupported-settings',
        taskId: input.taskId,
        runId,
        summary: message,
        nextAction: `Choose a supported ${err.field} for ${input.runtime}, or dispatch to a runtime that supports it.`,
      };
      const record: RunRecord = {
        ...recordedInFlight,
        timing: { ...recordedInFlight.timing, providerEndedAt: new Date().toISOString() },
        status: outcome.kind,
        endedAt: new Date().toISOString(),
        summary: outcome.summary,
      };
      const final = finalizeDispatchedRun(record, outcome, admission, input.repo, input.workClass);
      return { ...final, recovered, admission, runtimeDispatched: true };
    }

    const piFailure = err instanceof PiEvidenceError || err instanceof PiTeardownError ? err : undefined;
    const pid = piFailure?.processId;
    const outcome: Outcome = {
      kind: 'remote-uncertain',
      taskId: input.taskId,
      runId,
      summary: `The runtime call failed after the run was recorded: ${message}${pid !== undefined ? ` (local process group PID ${pid})` : ''}`,
      nextAction: piFailure
        ? 'Quiesce the coordinator, inspect Pi evidence and all local work (including escaped descendants), then use `agentsys resolve-pi` with operator stop attestation before retrying.'
        : `Inspect the ${input.runtime} session and run evidence, then reconcile before starting another attempt.`,
      ...(pid !== undefined ? { details: { processId: pid } } : {}),
    };
    const record: RunRecord = {
      ...recordedInFlight,
      ...(piFailure?.sessionId ? { sessionId: piFailure.sessionId } : {}),
      timing: { ...recordedInFlight.timing, providerEndedAt: new Date().toISOString() },
      status: outcome.kind,
      endedAt: new Date().toISOString(),
      summary: outcome.summary,
    };
    const final = finalizeDispatchedRun(record, outcome, admission, input.repo, input.workClass);
    return { ...final, recovered, admission, runtimeDispatched: true };
  }

  const record: RunRecord = {
    ...recordedInFlight,
    timing: { ...recordedInFlight.timing, providerEndedAt: new Date().toISOString() },
    settings: { ...result.settings, ...(input.promptVersion ? { prompt: input.promptVersion } : {}) },
    endedAt: new Date().toISOString(),
    status: result.outcome.kind,
    summary: result.outcome.summary,
    ...(result.outcome.promptNotSent === true ? { promptNotSent: true } : {}),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.skill ? { skill: result.skill } : {}),
    ...(admission.reservationId ? { admissionId: admission.reservationId } : {}),
  };
  const final = finalizeDispatchedRun(record, result.outcome, admission, input.repo, input.workClass);
  return {
    runtimeDispatched: true,
    outcome: final.outcome,
    recovered,
    authority: decision.authority,
    limits: decision.limits,
    admission,
    run: final.run,
  };
}

function toAuthorityRequest(input: DispatchTaskInput): DispatchRequest {
  return {
    repo: input.repo,
    workClass: input.workClass,
    runtime: input.runtime,
    profile: input.profile,
    actions: input.actions,
    taskId: input.taskId,
    settings: {
      ...(input.settings.model !== undefined ? { model: input.settings.model } : {}),
      ...(input.settings.effort !== undefined ? { effort: input.settings.effort } : {}),
    },
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.prBase !== undefined ? { prBase: input.prBase } : {}),
    ...(input.targetProject !== undefined ? { targetProject: input.targetProject } : {}),
  };
}

function assertDispatchInput(input: DispatchTaskInput): void {
  const strings = [
    ['taskId', input.taskId], ['repo', input.repo], ['workClass', input.workClass],
    ['profile', input.profile], ['prompt', input.prompt],
  ] as const;
  for (const [name, value] of strings) {
    if (value.trim() === '') throw new CommandInputError(`${name} must not be empty.`);
  }
  for (const [name, value] of strings) {
    const limit = name === 'prompt' ? DISPATCH_LIMITS.promptLength : DISPATCH_LIMITS.identifierLength;
    if (value.length > limit) throw new CommandInputError(`${name} is longer than the ${limit}-character bound.`);
  }
  if (input.actions.length === 0 || input.actions.length > DISPATCH_LIMITS.maxActions) {
    throw new CommandInputError(`actions must contain between 1 and ${DISPATCH_LIMITS.maxActions} entries.`);
  }
  const unknown = input.actions.filter((action) => !VALID_ACTIONS.includes(action));
  if (unknown.length > 0) throw new CommandInputError(`Unknown action(s): ${unknown.join(', ')}.`);
  const forbidden = input.actions.filter((action) => (FORBIDDEN_ACTIONS as readonly string[]).includes(action));
  if (forbidden.length > 0) {
    throw new CommandInputError(`Action(s) ${forbidden.join(', ')} are never authorized by the coordinator.`);
  }
  if (input.estimate.detail.length > DISPATCH_LIMITS.detailLength) {
    throw new CommandInputError(`estimate.detail is longer than the ${DISPATCH_LIMITS.detailLength}-character bound.`);
  }
  if (!ESTIMATE_BASES.includes(input.estimate.basis)) {
    throw new CommandInputError(`estimate.basis must be one of: ${ESTIMATE_BASES.join(', ')}.`);
  }
  for (const [name, value] of [
    ['estimate.fiveHourPercent', input.estimate.fiveHourPercent],
    ['estimate.weeklyPercent', input.estimate.weeklyPercent],
    ['estimate.uncertaintyPercent', input.estimate.uncertaintyPercent],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new CommandInputError(`${name} must be a finite percentage from 0 through 100.`);
    }
  }
  if (input.timeoutMs !== undefined &&
      (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > DISPATCH_LIMITS.maxTimeoutMs)) {
    throw new CommandInputError(`timeoutMs must be between 1000 and ${DISPATCH_LIMITS.maxTimeoutMs}.`);
  }
}

export interface CoordinatorCommands {
  /** Read-only views used by the CLI, local UI, and MCP adapter. */
  status(input?: StatusInput): StatusView;
  jobs(): JobsView;
  authority(): AuthorityView;
  policy(subscriptionId: string): PolicyView;
  ledger(): LedgerView;
  version(): VersionView;
  usage(input?: UsageInput): Promise<UsageView>;
  readiness(input?: ReadinessInput): Promise<ReadinessView>;
  evidence(input?: EvidenceInput): EvidenceView;
  evaluation(input?: EvaluationInput): EvaluationView;
  /** The configured id is read-only; callers cannot set it through this layer. */
  configuredOperator(): string | undefined;

  /** Operator-gated mutation methods; the MCP server does not expose these. */
  approve(actor: Actor, input: ApprovalInput): Approval;
  approvalList(): Approval[];
  approvalGet(id: string): Approval | undefined;
  grantCreate(actor: Actor, input: GrantInput): Grant;
  grantList(): Grant[];
  grantGet(id: string): Grant | undefined;
  grantNarrow(actor: Actor, id: string, input: NarrowInput): Grant;
  grantRevoke(actor: Actor, id: string, reason: string): Grant;
  policySet(actor: Actor, policy: SubscriptionPolicy): SubscriptionPolicy;
  ledgerAllowanceSet(actor: Actor, allowanceUsd: number): LedgerPolicy;
  checkDefer(actor: Actor, name: string, reason: string): CheckMutationResult;
  checkRestore(actor: Actor, name: string): CheckMutationResult;
  feedbackRecord(actor: Actor, scorecardId: string, input: FeedbackInput): Scorecard;
  checkResultRecord(actor: Actor, scorecardId: string, input: CheckInput): Scorecard;
  reviewRecord(actor: Actor, scorecardId: string, input: ReviewInput): Scorecard;
  repairRecord(actor: Actor, scorecardId: string, input: RepairInput): Scorecard;
  versionActivate(actor: Actor, input: ActivateInput): ActiveVersionRecord;
  versionRollback(actor: Actor): ActiveVersionRecord;
  intakeFailure(event: CiFailureEvent, input: IntakeConfig): IntakeResult;

  recover(runtime?: RuntimeId): Promise<ReconcileReport[]>;
  dispatch(input: DispatchTaskInput): Promise<DispatchCommandResult>;
  runStop(actor: Actor, runId: string): Promise<RunStopResult>;
  resolvePiStopped(actor: Actor, input: ResolvePiInput): RunRecord;
  runRedispatch(actor: Actor, runId: string): Promise<DispatchCommandResult>;
}

/** Factory used by production clients and by tests with fake adapters. */
export function createCoordinatorCommands(
  adapterFactory: AdapterFactory = adapterFor,
): CoordinatorCommands {
  return {
    status: statusView,
    jobs: jobsView,
    authority: authorityView,
    policy: policyView,
    ledger: ledgerView,
    version: versionView,
    usage: (input = {}) => usageView(input, adapterFactory),
    readiness: (input = {}) => readinessView(input, adapterFactory),
    evidence: evidenceView,
    evaluation: evaluationView,
    configuredOperator: configuredOperatorId,
    approve,
    approvalList,
    approvalGet,
    grantCreate,
    grantList,
    grantGet,
    grantNarrow,
    grantRevoke,
    policySet,
    ledgerAllowanceSet,
    checkDefer,
    checkRestore,
    feedbackRecord,
    checkResultRecord,
    reviewRecord,
    repairRecord,
    versionActivate,
    versionRollback,
    intakeFailure,
    recover: (runtime) => recoverUnsettled(runtime, adapterFactory),
    dispatch: (input) => dispatchTask(input, adapterFactory),
    runStop: (actor, runId) => runStop(actor, runId, adapterFactory),
    resolvePiStopped,
    runRedispatch: (actor, runId) => runRedispatch(actor, runId, adapterFactory),
  };
}

export const commands = createCoordinatorCommands();

/** Public type surface for UI/client implementations; the implementations stay in the coordinator. */
export type {
  ActionId, Actor, Approval, ApprovalInput, AuthorityRef, DispatchRequest, Grant, GrantInput,
  NarrowInput, PerTaskLimits, RuntimeId,
} from './core/authority.js';
export type {
  AdmissionDecision, SubscriptionPolicy, UsageEstimate,
} from './core/admission.js';
export type { Outcome } from './core/outcome.js';
export type { RunRecord, CandidateIdentity } from './core/run.js';
export type { Job, ReconcileReport } from './core/intake.js';
export type { EvidenceItem, RequiredCheck, AggregateReport } from './core/evidence.js';
export type { RuntimeAdapter, RuntimeCapabilities, SettingsRequest } from './adapters/types.js';
export type { UsageResult } from './core/usage.js';
export type { CallReservation, LedgerPolicy } from './core/ledger.js';
export type { ActivateInput, ActiveVersionRecord, CandidateRecord } from './core/version.js';
export type { CiFailureEvent, IntakeConfig, IntakeResult } from './core/ci-intake.js';
export type {
  CheckInput, CheckResult, CompletedReview, FeedbackVerdict, FindingInput, GroupKey, GroupReport,
  RepairCycle, RepairInput, Reviewer, ReviewerFinding, ReviewerRelationship, ReviewInput, Scorecard,
} from './eval/scorecard.js';
export type { CaseComparison, EvalSuite, TrialResult } from './eval/oracle.js';
export { stateRoot, activeRuns };
