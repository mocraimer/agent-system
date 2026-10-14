import { join } from 'node:path';
import { capabilitiesFor } from '../adapters/capabilities.js';
import type { Outcome } from './outcome.js';
import { listRecords, newId, readJson, readRecord, stateRoot, withLock, writeJson } from './store.js';

/**
 * Who is acting. Only an `operator` actor matching the configured operator id can
 * mint or widen authority; every other kind is data, however it is phrased.
 */
export type ActorKind = 'operator' | 'agent' | 'automation';
export interface Actor {
  kind: ActorKind;
  /** Operator identity, agent run id, or automation source name. */
  id: string;
}

export type RuntimeId = 'pi-local' | 'codex-cloud' | 'claude-web' | 'claude-local';

/** What a run is permitted to do. Absent from any list means not permitted. */
export type ActionId =
  | 'author-changes'
  | 'open-pr'
  | 'push-branch'
  | 'review'
  | 'run-verification'
  | 'deploy-dev'
  /**
   * Merge a pull request into `dev` — never `main`, which stays `merge` and is
   * forbidden. Grantable like any other action; the loop's merge stage adds its
   * own conditions on top of the authority check.
   */
  | 'merge-dev';

/** Limits that bind one task, whichever authority allowed it. */
export interface PerTaskLimits {
  maxAttempts: number;
  maxConcurrentRuns: number;
  /** Ceiling on paid API spend (calls the ledger meters) this task may reserve, in USD. */
  maxPaidCallUsd: number;
}

export interface Approval {
  kind: 'approval';
  id: string;
  version: number;
  issuedBy: Actor;
  issuedAt: string;
  repo: string;
  /** Free text describing exactly what was approved. Shown back at dispatch. */
  taskScope: string;
  workClass: string;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  limits: PerTaskLimits;
  /**
   * The tier the operator approved this work to run at.
   *
   * Both optional, and absent means the operator named no tier — which is what
   * every approval written before these fields existed says, and why they still
   * load. Where a tier is named it becomes the run's setting when the caller
   * names none; whether a *contradicting* caller value is refused depends on
   * the runtime, since a refusal is only meaningful where the runtime reports
   * back what it actually ran.
   */
  model?: string;
  effort?: string;
  revokedAt?: string;
}

export type GrantStatus = 'active' | 'revoked';

export interface AggregateLimits {
  /** Total dispatches this grant may authorize inside the rolling window. */
  maxDispatchesPerWindow: number;
  windowHours: number;
  /** Runs this grant may have in flight at once. */
  maxConcurrentRuns: number;
}

export interface Grant {
  kind: 'grant';
  id: string;
  version: number;
  issuedBy: Actor;
  issuedAt: string;
  status: GrantStatus;
  repos: string[];
  workClasses: string[];
  /** Event sources whose events may trigger work, e.g. `github-actions:example-org/larkspur`. */
  triggerSources: string[];
  actions: ActionId[];
  runtimes: RuntimeId[];
  profiles: string[];
  perTask: PerTaskLimits;
  aggregate: AggregateLimits;
  /** Every change, appended. Narrowing bumps `version`. */
  history: GrantChange[];
}

export interface GrantChange {
  at: string;
  by: Actor;
  change: 'created' | 'narrowed' | 'revoked';
  reason: string;
  /** Version this change produced. */
  version: number;
}

export interface AuthorityRef {
  type: 'approval' | 'grant';
  id: string;
  version: number;
}

export interface DispatchRequest {
  repo: string;
  workClass: string;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  /** Present when the work was triggered by an event rather than an operator. */
  triggerSource?: string;
  /** Base branch a pull request would target, when the work opens one. */
  prBase?: string;
  /** Cloud project the work would act on, when it touches one. */
  targetProject?: string;
  /** The approval the caller believes covers this, when dispatching under one. */
  approvalId?: string;
  /** Model and effort the caller named, so an approved tier can be checked against them. */
  settings?: { model?: string; effort?: string };
  taskId: string;
}

export type AuthorityDecision =
  | {
      allowed: true;
      authority: AuthorityRef;
      limits: PerTaskLimits;
      /** The approved tier, when the authority named one. Grants never do. */
      tier?: { model?: string; effort?: string };
    }
  | { allowed: false; outcome: Outcome };

/* ------------------------------------------------------------------ storage */

const approvalsDir = (): string => join(stateRoot(), 'approvals');
const grantsDir = (): string => join(stateRoot(), 'grants');

export function listApprovals(): Approval[] {
  return listRecords<Approval>('approval', approvalsDir());
}
export function listGrants(): Grant[] {
  return listRecords<Grant>('grant', grantsDir());
}
export function getApproval(id: string): Approval | undefined {
  const path = join(approvalsDir(), `${id}.json`);
  return readRecord<Approval>('approval', path);
}
export function getGrant(id: string): Grant | undefined {
  const path = join(grantsDir(), `${id}.json`);
  return readRecord<Grant>('grant', path);
}

/** The operator this installation answers to. */
export function configuredOperator(): string | undefined {
  const cfg = readJson<{ operator?: string }>(join(stateRoot(), 'config.json'));
  return cfg?.operator;
}

/**
 * Reject any actor that is not the configured operator.
 *
 * This is the single choke point for minting authority. It exists because the
 * material an agent produces — its own output, a PR comment, a review verdict, an
 * evaluation score — reaches the coordinator as text and can claim anything;
 * treating that text as a decision is the failure this guards.
 */
export function assertOperator(actor: Actor): void {
  if (actor.kind !== 'operator') {
    throw new AuthorityError(
      `A ${actor.kind} cannot issue or change authority. Only the configured operator can.`,
    );
  }
  const configured = configuredOperator();
  if (!configured) {
    throw new AuthorityError('No operator is configured. Run `agentsys init --operator <id>` first.');
  }
  if (actor.id !== configured) {
    throw new AuthorityError(
      `Actor "${actor.id}" is not the configured operator ("${configured}").`,
    );
  }
}

export class AuthorityError extends Error {
  override readonly name = 'AuthorityError';
}

/* ----------------------------------------------------------------- minting */

export interface ApprovalInput {
  repo: string;
  taskScope: string;
  workClass: string;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  limits: PerTaskLimits;
  /** The tier this work is approved to run at. Both optional; see `Approval`. */
  model?: string;
  effort?: string;
}

/**
 * Refuse a tier the named runtime could never take.
 *
 * Checked when the approval is written rather than at dispatch: a runtime that
 * chooses its own model makes `resolveSettings` throw on every single dispatch
 * under such an approval, which tells the operator about the mistake at the
 * worst moment and once per attempt instead of once.
 *
 * Model *strings* are not checked against a catalogue — no runtime publishes one
 * — so a model the vendor does not offer still fails at the runtime. Effort is
 * different: each runtime declares its own levels, so a bad one is knowable here.
 */
function assertTierFits(input: ApprovalInput): void {
  const caps = capabilitiesFor(input.runtime);
  if (input.model !== undefined && !caps.supportsModelSelection) {
    throw new AuthorityError(
      `${input.runtime} chooses its own model, so an approval cannot name one (asked for "${input.model}"). ` +
        'Approve this work without a model, or approve it for a runtime that takes one.',
    );
  }
  if (input.effort !== undefined && !caps.supportsEffortSelection) {
    throw new AuthorityError(
      `${input.runtime} chooses its own effort, so an approval cannot name one (asked for "${input.effort}"). ` +
        'Approve this work without an effort, or approve it for a runtime that takes one.',
    );
  }
  if (input.effort !== undefined && !caps.effortLevels.includes(input.effort)) {
    throw new AuthorityError(
      `${input.runtime} has no effort level "${input.effort}". It accepts: ${caps.effortLevels.join(', ')}. ` +
        'Effort names are runtime-specific, not points on a shared scale.',
    );
  }
}

export function createApproval(actor: Actor, input: ApprovalInput): Approval {
  assertOperator(actor);
  assertTierFits(input);
  const approval: Approval = {
    kind: 'approval',
    id: newId('apv'),
    version: 1,
    issuedBy: actor,
    issuedAt: new Date().toISOString(),
    ...input,
  };
  writeJson(join(approvalsDir(), `${approval.id}.json`), approval);
  return approval;
}

export interface GrantInput {
  repos: string[];
  workClasses: string[];
  triggerSources: string[];
  actions: ActionId[];
  runtimes: RuntimeId[];
  profiles: string[];
  perTask: PerTaskLimits;
  aggregate: AggregateLimits;
  reason: string;
}

export function createGrant(actor: Actor, input: GrantInput): Grant {
  assertOperator(actor);
  const now = new Date().toISOString();
  const grant: Grant = {
    kind: 'grant',
    id: newId('grant'),
    version: 1,
    issuedBy: actor,
    issuedAt: now,
    status: 'active',
    repos: input.repos,
    workClasses: input.workClasses,
    triggerSources: input.triggerSources,
    actions: input.actions,
    runtimes: input.runtimes,
    profiles: input.profiles,
    perTask: input.perTask,
    aggregate: input.aggregate,
    history: [{ at: now, by: actor, change: 'created', reason: input.reason, version: 1 }],
  };
  writeJson(join(grantsDir(), `${grant.id}.json`), grant);
  return grant;
}

/** Fields a narrowing may touch. Anything absent is left as it was. */
export interface NarrowInput {
  repos?: string[];
  workClasses?: string[];
  triggerSources?: string[];
  actions?: ActionId[];
  runtimes?: RuntimeId[];
  profiles?: string[];
  perTask?: Partial<PerTaskLimits>;
  aggregate?: Partial<AggregateLimits>;
  reason: string;
}

/**
 * Narrow a grant. Every supplied field must be a subset of, or numerically not
 * greater than, what the grant already allows — so this entry point cannot be used
 * to widen authority under a friendlier name.
 */
export function narrowGrant(actor: Actor, id: string, input: NarrowInput): Grant {
  assertOperator(actor);
  return withLock(`grant-${id}`, () => {
    const grant = getGrant(id);
    if (!grant) throw new AuthorityError(`No grant "${id}".`);
    if (grant.status !== 'active') {
      throw new AuthorityError(`Grant ${id} is ${grant.status}; a non-active grant cannot be narrowed.`);
    }

    const subset = <T>(next: T[] | undefined, prev: T[], field: string): T[] => {
      if (!next) return prev;
      const extra = next.filter((v) => !prev.includes(v));
      if (extra.length > 0) {
        throw new AuthorityError(
          `Narrowing cannot add to ${field}: ${extra.join(', ')} not in the current grant. Revoke and issue a new grant to widen.`,
        );
      }
      return next;
    };
    const noGreater = (next: number | undefined, prev: number, field: string): number => {
      if (next === undefined) return prev;
      if (next > prev) {
        throw new AuthorityError(
          `Narrowing cannot raise ${field} from ${prev} to ${next}. Revoke and issue a new grant to widen.`,
        );
      }
      return next;
    };

    const version = grant.version + 1;
    const next: Grant = {
      ...grant,
      version,
      repos: subset(input.repos, grant.repos, 'repos'),
      workClasses: subset(input.workClasses, grant.workClasses, 'workClasses'),
      triggerSources: subset(input.triggerSources, grant.triggerSources, 'triggerSources'),
      actions: subset(input.actions, grant.actions, 'actions'),
      runtimes: subset(input.runtimes, grant.runtimes, 'runtimes'),
      profiles: subset(input.profiles, grant.profiles, 'profiles'),
      perTask: {
        maxAttempts: noGreater(input.perTask?.maxAttempts, grant.perTask.maxAttempts, 'perTask.maxAttempts'),
        maxConcurrentRuns: noGreater(input.perTask?.maxConcurrentRuns, grant.perTask.maxConcurrentRuns, 'perTask.maxConcurrentRuns'),
        maxPaidCallUsd: noGreater(input.perTask?.maxPaidCallUsd, grant.perTask.maxPaidCallUsd, 'perTask.maxPaidCallUsd'),
      },
      aggregate: {
        maxDispatchesPerWindow: noGreater(input.aggregate?.maxDispatchesPerWindow, grant.aggregate.maxDispatchesPerWindow, 'aggregate.maxDispatchesPerWindow'),
        windowHours: noGreater(input.aggregate?.windowHours, grant.aggregate.windowHours, 'aggregate.windowHours'),
        maxConcurrentRuns: noGreater(input.aggregate?.maxConcurrentRuns, grant.aggregate.maxConcurrentRuns, 'aggregate.maxConcurrentRuns'),
      },
      history: [
        ...grant.history,
        { at: new Date().toISOString(), by: actor, change: 'narrowed', reason: input.reason, version },
      ],
    };
    writeJson(join(grantsDir(), `${id}.json`), next);
    return next;
  });
}

export function revokeGrant(actor: Actor, id: string, reason: string): Grant {
  assertOperator(actor);
  return withLock(`grant-${id}`, () => {
    const grant = getGrant(id);
    if (!grant) throw new AuthorityError(`No grant "${id}".`);
    const version = grant.version + 1;
    const next: Grant = {
      ...grant,
      version,
      status: 'revoked',
      history: [
        ...grant.history,
        { at: new Date().toISOString(), by: actor, change: 'revoked', reason, version },
      ],
    };
    writeJson(join(grantsDir(), `${id}.json`), next);
    return next;
  });
}

export function revokeApproval(actor: Actor, id: string): Approval {
  assertOperator(actor);
  const approval = getApproval(id);
  if (!approval) throw new AuthorityError(`No approval "${id}".`);
  const next: Approval = { ...approval, version: approval.version + 1, revokedAt: new Date().toISOString() };
  writeJson(join(approvalsDir(), `${id}.json`), next);
  return next;
}
