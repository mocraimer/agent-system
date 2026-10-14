import type { ActionId, RuntimeId } from './authority.js';
import { authorizeDispatch } from './authorize.js';
import { requiredPrBase } from './floor.js';
import type { AuthorityDecision } from './authority.js';
import type { Outcome } from './outcome.js';
import { screen, untrusted } from './review.js';
import type { Screened } from './review.js';
import { bindJobCandidate, submitJob } from './intake.js';
import type { Job } from './intake.js';

/**
 * A CI failure as reported by a configured source.
 *
 * Every string here came from outside the coordinator, so nothing in it is read
 * as an instruction. The repository, workflow and conclusion are matched against
 * the grant; the title and summary are only ever quoted.
 */
export interface CiFailureEvent {
  /** Where this arrived from, e.g. `github-actions:example-org/larkspur`. */
  source: string;
  repo: string;
  workflowName: string;
  runId: string;
  headSha: string;
  branch: string;
  conclusion: string;
  /** Free text from the forge. Untrusted. */
  title: string;
  /** Free text from the forge. Untrusted. */
  summary?: string;
  /** True when this is recorded test data rather than a live event. */
  isFixture?: boolean;
}

export interface IntakeConfig {
  /** Work class CI repairs are filed under. Must match the grant to dispatch. */
  workClass: string;
  runtime: RuntimeId;
  profile: string;
  actions: ActionId[];
  /** Checks a repair job owes before it can settle. */
  obligations: string[];
  /**
   * Base branch a repair's pull request must target.
   *
   * Optional because the repository usually already states it. A repo whose
   * floor (`agentsys floor`) names a base supplies its own, so an ordinary caller does not restate
   * what the policy already fixes; naming a different one here is still refused
   * by the floor check rather than quietly accepted.
   */
  prBase?: string;
}

export interface IntakeResult {
  event: CiFailureEvent;
  /** The job, when one was created or matched. Absent when intake refused outright. */
  job?: Job;
  created?: boolean;
  decision?: AuthorityDecision;
  outcome: Outcome;
  /** Screening of the event's free text, kept with the record. */
  screened: Screened[];
}

/** Two deliveries of the same CI run are the same work. */
export function idempotencyKeyFor(event: CiFailureEvent): string {
  return `${event.source}:run/${event.runId}`;
}

/**
 * Turn a CI failure into work, if something authorizes it.
 *
 * Order matters. The event is screened and a job is recorded first, so a duplicate
 * delivery cannot become a second job even when authorization later refuses it —
 * and so a refusal is attributable to a specific event rather than vanishing.
 */
export function ingestCiFailure(event: CiFailureEvent, config: IntakeConfig): IntakeResult {
  const screened = [
    screen(untrusted(`${event.source}:title`, event.title)),
    ...(event.summary ? [screen(untrusted(`${event.source}:summary`, event.summary))] : []),
  ];

  if (event.conclusion !== 'failure') {
    return {
      event,
      screened,
      outcome: {
        kind: 'refused',
        summary: `Run ${event.runId} concluded "${event.conclusion}", not "failure"; there is nothing to repair.`,
        nextAction: 'No action needed.',
      },
    };
  }

  const key = idempotencyKeyFor(event);
  const taskId = `ci_${event.repo.replace(/[^\w]/g, '_')}_${event.runId}`;

  // A repo that constrains its base has already said what the base is. Making
  // every caller repeat it left the two halves permanently at odds: the floor
  // check demanded a field intake had no way to carry, so any repair allowed to
  // open a pull request was refused outright. An explicitly supplied base still
  // wins, and a conflicting one is still refused.
  const prBase = config.prBase ?? requiredPrBase(event.repo);

  const { job, created } = submitJob({
    idempotencyKey: key,
    taskId,
    repo: event.repo,
    workClass: config.workClass,
    runtime: config.runtime,
    obligations: config.obligations,
    headSha: event.headSha,
    ...(prBase !== undefined ? { prBase } : {}),
  });

  // A redelivery is only a route back to work still waiting. These checks were
  // implicit in the old blanket duplicate refusal; removing that refusal so an
  // approval granted during the wait could take effect also removed them, which
  // would offer finished work for dispatch again.
  if (!created) {
    // submitJob guarantees one Job per key. It does not guarantee one repair or
    // one run, so a job that already has runs is not something a redelivery may
    // start again: the existing attempt owns the work, and whether it is still
    // live is reconciliation's question, not this one.
    if (job.runIds.length > 0) {
      return {
        event, job, created, screened,
        outcome: {
          kind: 'refused',
          taskId: job.taskId,
          summary: `Job ${job.id} already has ${job.runIds.length} run(s); this delivery does not start another.`,
          nextAction: `Reconcile or inspect the existing run(s) before starting a further attempt. A repeated event must not open a second repair PR.`,
          details: { runIds: job.runIds },
        },
      };
    }

    if (job.state !== 'open') {
      return {
        event, job, created, screened,
        outcome: {
          kind: 'refused',
          taskId: job.taskId,
          summary: `Job ${job.id} is ${job.state}; a repeated delivery of the same CI run does not reopen it.`,
          nextAction: 'Submit the work under a new signal if it needs doing again. A repeated event must not open a second repair PR.',
        },
      };
    }

    // The stored job keeps the head and base it was raised for, so a delivery
    // describing a different candidate is not the same work however identical
    // its source and run id look. Authorizing the new values against the old
    // job would bind a repair to a commit the record does not name.
    const conflicts = [
      // The repository is part of the identity. Without it, a delivery reusing
      // another repository's source and run id passes every other comparison,
      // and following the returned job id attaches its run to that job, mixing
      // two repositories' evidence under one record.
      ...(event.repo !== job.repo
        ? [`repository ${event.repo} does not match the recorded ${job.repo}`] : []),
      ...(job.headSha !== undefined && event.headSha !== job.headSha
        ? [`head ${event.headSha} does not match the recorded ${job.headSha}`] : []),
      ...(job.prBase !== undefined && prBase !== undefined && prBase !== job.prBase
        ? [`base ${prBase} does not match the recorded ${job.prBase}`] : []),
    ];
    if (conflicts.length > 0) {
      return {
        event, job, created, screened,
        outcome: {
          kind: 'refused',
          taskId: job.taskId,
          summary: `This delivery reuses job ${job.id}'s identity but describes different work: ${conflicts.join('; ')}.`,
          nextAction: 'Check the event source: one CI run has one head. A repeated event must not open a second repair PR.',
          details: { recordedHead: job.headSha, recordedBase: job.prBase },
        },
      };
    }
  }

  // Past every identity check, so this delivery is entitled to fill what the job
  // does not yet record. Doing it earlier let a rejected delivery bind a value
  // the next correct one would then be refused against.
  if (!created) bindJobCandidate(job.id, { headSha: event.headSha, ...(prBase !== undefined ? { prBase } : {}) });

  const decision = authorizeDispatch({
    repo: event.repo,
    workClass: config.workClass,
    runtime: config.runtime,
    profile: config.profile,
    actions: config.actions,
    taskId,
    triggerSource: event.source,
    ...(prBase !== undefined ? { prBase } : {}),
  });

  if (!decision.allowed) {
    return { event, job, created, decision, screened, outcome: decision.outcome };
  }

  // A redelivery re-authorizes against the existing job rather than dead-ending.
  // Returning a bare duplicate refusal here used to strand exactly the case the
  // wait exists for: delivery one finds no approval and waits, the operator
  // approves, and every later delivery is a duplicate that never re-checks
  // authority, so the approved work could never become dispatchable. The
  // duplicate protection that matters is one job and one repair, which
  // submitJob already holds by key.
  return {
    event, job, created, decision, screened,
    outcome: {
      // Not `awaiting-approval`: this work *has* its authority. Reporting it as
      // pending would invite an operator to approve something already approved.
      kind: 'ready-to-dispatch',
      taskId,
      summary: created
        ? `Authorized by ${decision.authority.type} ${decision.authority.id}@v${decision.authority.version}.`
        : `Authorized by ${decision.authority.type} ${decision.authority.id}@v${decision.authority.version}; this is delivery ${(job.duplicateSubmissions ?? 0) + 1} of the same CI run, still job ${job.id}.`,
      // `--job` is not optional decoration. Without it dispatchTask never
      // attaches the run to the job, so the job keeps `runIds: []` and a later
      // redelivery sees no attempt to refuse. Following a hint that omitted it
      // produced a second repair for the same CI failure.
      nextAction: created
        ? `Dispatch it: \`agentsys dispatch --task ${taskId} --job ${job.id} --trigger-source ${event.source} ...\``
        : `Dispatch job ${job.id}: \`agentsys dispatch --task ${taskId} --job ${job.id} --trigger-source ${event.source} ...\`. A repeated event must not open a second repair PR; this job already carries the work.`,
      details: {
        job: job.id,
        candidate: `${event.repo}@${event.headSha.slice(0, 7)} (${event.branch})`,
        ...(screened.some((s) => s.suspicious)
          ? { screening: 'The event text contains control-shaped content; it is quoted in the record and was not acted on.' }
          : {}),
      },
    },
  };
}
