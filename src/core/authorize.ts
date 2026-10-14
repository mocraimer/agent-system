import type {
  Approval, AuthorityDecision, DispatchRequest, Grant, PerTaskLimits,
} from './authority.js';
import { getApproval, listGrants } from './authority.js';
import type { Outcome } from './outcome.js';
import { dispatchesUnderAuthority, spentAttempts } from './run.js';
import { readFloor } from './floor.js';

/**
 * Constraints no authority can relax.
 *
 * A grant widens *which tasks may start without asking*. It is not a second way to
 * reach the things the contract puts outside every task's reach, so these are
 * checked after a match rather than folded into matching — an operator who writes
 * a broad grant still cannot accidentally authorize a merge or a production write.
 */
export const FORBIDDEN_ACTIONS = ['merge', 'auto-merge', 'force-push', 'release', 'deploy-prod'] as const;

/** Actions that would write to whatever project they name. */
const WRITING_ACTIONS: readonly string[] = ['deploy-dev', 'deploy-prod'];

export interface FloorViolation {
  rule: string;
  detail: string;
}

/**
 * Check a dispatch against the constraints that hold regardless of authority.
 * Returns every violation rather than the first, so an operator fixing a request
 * sees the whole picture in one pass.
 */
export function checkFloor(req: DispatchRequest): FloorViolation[] {
  const out: FloorViolation[] = [];
  const floor = readFloor();
  for (const action of req.actions as string[]) {
    if ((FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
      out.push({
        rule: 'forbidden-action',
        detail: `Action "${action}" is never authorized, by approval or grant.`,
      });
    }
  }

  // A repository whose integration PRs must target a particular base (`agentsys floor`).
  const requiredBase = floor.prBases[req.repo];
  if (requiredBase !== undefined && req.actions.includes('open-pr')) {
    if (req.prBase === undefined) {
      out.push({
        rule: 'pr-base-unstated',
        detail: `${req.repo} requires pull requests to target "${requiredBase}", so a dispatch that opens one must state its base.`,
      });
    } else if (req.prBase !== requiredBase) {
      out.push({
        rule: 'pr-base',
        detail: `${req.repo} requires pull requests to target "${requiredBase}"; this dispatch targets "${req.prBase}".`,
      });
    }
  }

  // A project nothing may write to, whatever the action is called.
  if (req.targetProject !== undefined &&
      floor.readOnlyProjects.includes(req.targetProject) &&
      req.actions.some((a) => WRITING_ACTIONS.includes(a))) {
    out.push({
      rule: 'read-only-project',
      detail: `${req.targetProject} is read-only; no action may write to it.`,
    });
  }

  return out;
}

function grantMatches(grant: Grant, req: DispatchRequest): string | undefined {
  if (grant.status !== 'active') return `grant is ${grant.status}`;
  if (!grant.repos.includes(req.repo)) return `repo ${req.repo} not in grant`;
  if (!grant.workClasses.includes(req.workClass)) return `work class ${req.workClass} not in grant`;
  if (!grant.runtimes.includes(req.runtime)) return `runtime ${req.runtime} not in grant`;
  if (!grant.profiles.includes(req.profile)) return `profile ${req.profile} not in grant`;
  const extraActions = req.actions.filter((a) => !grant.actions.includes(a));
  if (extraActions.length > 0) return `actions not in grant: ${extraActions.join(', ')}`;
  // A grant authorizes *event-triggered* work; it must name the source that fired.
  if (req.triggerSource === undefined) {
    return 'grant-authorized work must name its trigger source';
  }
  if (!grant.triggerSources.includes(req.triggerSource)) {
    return `trigger source ${req.triggerSource} not in grant`;
  }
  return undefined;
}

function refuse(req: DispatchRequest, summary: string, nextAction: string, details?: Record<string, unknown>): AuthorityDecision {
  const outcome: Outcome = {
    kind: 'refused',
    taskId: req.taskId,
    summary,
    nextAction,
    ...(details ? { details } : {}),
  };
  return { allowed: false, outcome };
}

function pending(req: DispatchRequest, summary: string, details?: Record<string, unknown>): AuthorityDecision {
  const outcome: Outcome = {
    kind: 'awaiting-approval',
    taskId: req.taskId,
    summary,
    nextAction: `Approve this task explicitly: \`agentsys approve --task ${req.taskId}\`, or issue a grant that covers it.`,
    ...(details ? { details } : {}),
  };
  return { allowed: false, outcome };
}

/**
 * Decide whether a dispatch may proceed.
 *
 * Order matters: the floor is checked first so a request for something never
 * allowed is refused outright rather than reported as merely unapproved, which
 * would invite an operator to "fix" it by approving harder.
 */
export function authorizeDispatch(req: DispatchRequest): AuthorityDecision {
  const violations = checkFloor(req);
  if (violations.length > 0) {
    return refuse(
      req,
      `Request includes ${violations.length} action(s) no authority can permit.`,
      'Remove the forbidden actions from the task, or perform them yourself outside the system.',
      { violations: violations.map((v) => `${v.rule}: ${v.detail}`) },
    );
  }

  // 1. An individual approval, when the caller named one.
  if (req.approvalId) {
    const approval = getApproval(req.approvalId);
    if (!approval) {
      return refuse(req, `Approval ${req.approvalId} does not exist.`, 'Issue an approval, then dispatch again.');
    }
    if (approval.revokedAt) {
      return refuse(
        req,
        `Approval ${approval.id} was revoked at ${approval.revokedAt}.`,
        'Issue a fresh approval if this work should still run.',
      );
    }
    const mismatch = approvalMismatch(approval, req);
    if (mismatch) {
      return refuse(
        req,
        `Approval ${approval.id} does not cover this dispatch: ${mismatch}.`,
        'Dispatch within the approved scope, or issue an approval that covers it.',
      );
    }
    const attemptCheck = attemptsRemaining(req.taskId, approval.limits);
    if (attemptCheck) return attemptCheck;
    const tier = approvedTier(approval);
    return {
      allowed: true,
      authority: { type: 'approval', id: approval.id, version: approval.version },
      limits: approval.limits,
      ...(tier ? { tier } : {}),
    };
  }

  // 2. A standing grant.
  const reasons: string[] = [];
  for (const grant of listGrants()) {
    const why = grantMatches(grant, req);
    if (why) {
      reasons.push(`${grant.id}: ${why}`);
      continue;
    }
    const aggregate = aggregateCheck(grant, req);
    if (aggregate) return aggregate;
    const attemptCheck = attemptsRemaining(req.taskId, grant.perTask);
    if (attemptCheck) return attemptCheck;
    return {
      allowed: true,
      authority: { type: 'grant', id: grant.id, version: grant.version },
      limits: grant.perTask,
    };
  }

  return pending(
    req,
    reasons.length > 0
      ? 'No active grant covers this work and no approval was supplied.'
      : 'No approval was supplied and there are no grants.',
    reasons.length > 0 ? { unmatchedGrants: reasons } : undefined,
  );
}

/** The tier an approval binds a run to, or nothing when it named none. */
function approvedTier(approval: Approval): { model?: string; effort?: string } | undefined {
  if (approval.model === undefined && approval.effort === undefined) return undefined;
  return {
    ...(approval.model !== undefined ? { model: approval.model } : {}),
    ...(approval.effort !== undefined ? { effort: approval.effort } : {}),
  };
}

/**
 * Refuse a dispatch that contradicts the approved tier.
 *
 * This compares two values the coordinator already holds: what the operator
 * approved, and what the caller explicitly asked for. Both are known before
 * anything is dispatched, on every runtime, so the contradiction is decidable
 * everywhere.
 *
 * It deliberately does NOT consult `reportsEffectiveSettings`. That capability
 * says whether the runtime will tell us what it actually ran — it is evidence
 * about the past, and the right input to a post-run conformance check. Gating
 * authority on it let a caller escape an approved tier on `claude-web` and
 * `codex-cloud` simply because those runtimes confirm nothing: an `opus`/`max`
 * approval plus an explicit `sonnet`/`low` request dispatched at `sonnet`/`low`.
 * A runtime's silence about what it ran is not the operator's consent to
 * something else.
 *
 * An absent request still defers to the approval — that is the tier being
 * inherited, not contradicted.
 */
function tierMismatch(approval: Approval, req: DispatchRequest): string | undefined {
  if (approval.model === undefined && approval.effort === undefined) return undefined;

  const pairs = [
    ['model', approval.model, req.settings?.model],
    ['effort', approval.effort, req.settings?.effort],
  ] as const;
  for (const [field, approved, requested] of pairs) {
    if (approved === undefined || requested === undefined) continue;
    if (approved !== requested) {
      return `approved to run at ${field} ${approved}, requested ${requested}`;
    }
  }
  return undefined;
}

function approvalMismatch(approval: Approval, req: DispatchRequest): string | undefined {
  if (approval.repo !== req.repo) return `approved for repo ${approval.repo}, requested ${req.repo}`;
  if (approval.workClass !== req.workClass) {
    return `approved for work class ${approval.workClass}, requested ${req.workClass}`;
  }
  if (approval.runtime !== req.runtime) {
    return `approved for runtime ${approval.runtime}, requested ${req.runtime}`;
  }
  if (approval.profile !== req.profile) {
    return `approved for profile ${approval.profile}, requested ${req.profile}`;
  }
  const extra = req.actions.filter((a) => !approval.actions.includes(a));
  if (extra.length > 0) return `actions not approved: ${extra.join(', ')}`;
  return tierMismatch(approval, req);
}

/** Refuse when the task has already spent its attempts. */
function attemptsRemaining(taskId: string, limits: PerTaskLimits): AuthorityDecision | undefined {
  const prior = spentAttempts(taskId);
  if (prior.length >= limits.maxAttempts) {
    const outcome: Outcome = {
      kind: 'attempts-exhausted',
      taskId,
      summary: `Task has used ${prior.length} of ${limits.maxAttempts} permitted attempts.`,
      nextAction: 'Review the prior attempts, then issue a fresh approval with a new attempt budget if the work should continue.',
      details: { attempts: prior.map((r) => `${r.id}:${r.status}`) },
    };
    return { allowed: false, outcome };
  }
  const inFlight = prior.filter((r) => r.status === 'running').length;
  if (inFlight >= limits.maxConcurrentRuns) {
    const outcome: Outcome = {
      kind: 'refused',
      taskId,
      summary: `Task already has ${inFlight} run(s) in flight; its limit is ${limits.maxConcurrentRuns}.`,
      nextAction:
        `Run \`agentsys status --task ${taskId}\` to find the run and its session id, then ` +
        '`agentsys recover` to reconcile it with the vendor. A run whose session id is blank lost ' +
        'contact before the vendor acknowledged it, and recovery will say so rather than guess.',
    };
    return { allowed: false, outcome };
  }
  return undefined;
}

/** Refuse when a grant has spent its aggregate budget. */
function aggregateCheck(grant: Grant, req: DispatchRequest): AuthorityDecision | undefined {
  const spent = dispatchesUnderAuthority(grant.id, grant.aggregate.windowHours);
  if (spent.length >= grant.aggregate.maxDispatchesPerWindow) {
    const outcome: Outcome = {
      kind: 'refused',
      taskId: req.taskId,
      summary: `Grant ${grant.id} has used ${spent.length} of ${grant.aggregate.maxDispatchesPerWindow} dispatches in its ${grant.aggregate.windowHours}h window.`,
      nextAction: 'Wait for the window to roll over, approve this task individually, or issue a grant with a larger budget.',
    };
    return { allowed: false, outcome };
  }
  const inFlight = spent.filter((r) => r.status === 'running').length;
  if (inFlight >= grant.aggregate.maxConcurrentRuns) {
    const outcome: Outcome = {
      kind: 'refused',
      taskId: req.taskId,
      summary: `Grant ${grant.id} already has ${inFlight} concurrent run(s); its limit is ${grant.aggregate.maxConcurrentRuns}.`,
      nextAction: 'Wait for a run to finish, or approve this task individually.',
    };
    return { allowed: false, outcome };
  }
  return undefined;
}
