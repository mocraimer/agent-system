#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { getPolicy, listReservations, savePolicy } from '../core/admission.js';
import type { MeteredWindow, UsageEstimate } from '../core/admission.js';
import type { ActionId, Actor, RuntimeId } from '../core/authority.js';
import {
  AuthorityError, assertOperator, createApproval, createGrant,
  getGrant, listApprovals, listGrants, narrowGrant, revokeGrant,
} from '../core/authority.js';
import { FORBIDDEN_ACTIONS } from '../core/authorize.js';
import { integrationBase, readFloor, writeFloor } from '../core/floor.js';
import {
  formatUsd, getLedgerPolicy, listCalls, releaseCall, remainingUsd, reserveCall, setLedgerPolicy,
  settleCall,
} from '../core/ledger.js';
import { render } from '../core/outcome.js';
import { activeRuns, getRun, listRuns } from '../core/run.js';
import { newId, readJson, stateRoot, writeJson } from '../core/store.js';
import { aggregate, assertOperatorDeferrals } from '../core/evidence.js';
import type { EvidenceItem, RequiredCheck } from '../core/evidence.js';
import {
  CASE_KINDS, compareConfigurations, freezeBuiltinSuite, listSuites, listTrials, runControls, scoreTrial,
} from '../eval/replay.js';
import type { CaseResult } from '../eval/replay.js';
import { getSuite } from '../eval/oracle.js';
import { parseConfiguration, renderConfiguration, replaySuite } from '../eval/replay-run.js';
import { ingestCiFailure } from '../core/ci-intake.js';
import type { CiFailureEvent, IntakeConfig } from '../core/ci-intake.js';
import { listJobs } from '../core/intake.js';
import { ScorecardEvidenceError } from '../eval/scorecard.js';
import type { CheckResult, FeedbackVerdict, RepairCycle, ReviewInput, ReviewerRelationship } from '../eval/scorecard.js';
import { activateVersion, activeVersion, listCandidates, recordCandidate, rollback, versionHistory } from '../core/version.js';
import { readFileSync } from 'node:fs';
import { listScorecards } from '../eval/scorecard.js';
import { renderBoard } from '../console/print.js';
import { ceilingLines } from './usage.js';
import { createConsoleCommands } from '../console/commands.js';
import type { ConsoleCommands } from '../console/commands.js';
import { FileStore } from '../console/file-store.js';
import { consoleTarget, readBoard } from '../console/service.js';
import { GitRepo } from '../loop/git.js';
import { GhStore, runGh } from '../loop/github.js';
import { attestDelivery } from '../loop/attest.js';
import { useMarkerPrefix } from '../loop/markers.js';
import { actOnStageItem, coordinatorCommands, lastPass, LoopBusyError, loopDir, passLogTail } from '../loop/pass.js';
import { parseStoreConfig, PolicyError, STORE_CONFIG_PATH } from '../loop/policy.js';
import { armedConfigPath, arm, disarm, readArmed, runLoop } from '../loop/runner.js';
import { renderTrust, trustReport } from '../loop/trust.js';
import type { PassStage } from '../loop/types.js';
import { STAGES } from '../loop/types.js';
import {
  adapterFor, CommandInputError, commands, dispatchTask, ESTIMATE_BASES, readConfig, recoverUnsettled, RUNTIMES,
  VALID_ACTIONS, writeConfig,
} from '../commands.js';
import type { Config } from '../commands.js';
import {
  flag, list, optionalNumber, optionalString, parseArgs, requireNumber, requireString, UsageError,
} from './args.js';

/**
 * The acting operator.
 *
 * Taken from an explicit flag or the environment, never inferred from anything an
 * agent could write. `assertOperator` still checks it against the configured id.
 */
function actingOperator(flags: Map<string, string | true>): Actor {
  const id = optionalString(flags, 'as') ?? process.env['AGENTSYS_OPERATOR'];
  if (!id) {
    throw new UsageError(
      'Who is acting? Pass --as <operator-id> or set AGENTSYS_OPERATOR. Only the configured operator can change authority.',
    );
  }
  return { kind: 'operator', id };
}

const EVENT_STRING_FIELDS = [
  'source', 'repo', 'workflowName', 'runId', 'headSha', 'branch', 'conclusion', 'title',
] as const;

/**
 * Read a CI event file, checking it before trusting its shape.
 *
 * `intake` is the automation entry point, fed by whatever a forge or runner emits.
 * A cast alone would let a malformed event reach field access and crash after a
 * job had already been recorded.
 */
function parseEventFile(path: string): CiFailureEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`Event file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError(`Event file ${path} must contain a JSON object.`);
  }
  const o = raw as Record<string, unknown>;
  const missing = EVENT_STRING_FIELDS.filter((f) => typeof o[f] !== 'string');
  if (missing.length > 0) {
    throw new UsageError(`Event file ${path} is missing required string field(s): ${missing.join(', ')}.`);
  }
  return o as unknown as CiFailureEvent;
}

function parseEstimateBasis(flags: Map<string, string | true>): UsageEstimate['basis'] {
  const raw = optionalString(flags, 'estimate-basis') ?? 'none';
  if (!(ESTIMATE_BASES as readonly string[]).includes(raw)) {
    throw new UsageError(
      `--estimate-basis must be one of: ${ESTIMATE_BASES.join(', ')}; got "${raw}". ` +
        'An unrecognised basis would otherwise slip past the check that refuses work with no estimate.',
    );
  }
  return raw as UsageEstimate['basis'];
}

/**
 * Parse the action list, refusing a typo rather than storing it.
 *
 * An action the contract forbids outright gets its own message: telling an
 * operator who asked to merge that the word is "unknown" would invite them to
 * look for the right spelling, when the answer is that no spelling exists.
 */
function parseActions(flags: Map<string, string | true>, fallback: string[] = []): ActionId[] {
  const raw = list(flags, 'actions');
  const chosen = raw.length > 0 ? raw : fallback;
  for (const a of chosen) {
    if ((FORBIDDEN_ACTIONS as readonly string[]).includes(a)) {
      throw new UsageError(
        `Action "${a}" is never authorized, by approval or grant. It is not a spelling problem: ` +
          'merging, force-pushing, releasing and production deploys are outside what this system does. ' +
          'Perform it yourself, or drop it from the task.',
      );
    }
    if (!(VALID_ACTIONS as readonly string[]).includes(a)) {
      throw new UsageError(`Unknown action "${a}". Valid actions: ${VALID_ACTIONS.join(', ')}.`);
    }
  }
  return chosen as ActionId[];
}

function parseRuntime(value: string): RuntimeId {
  if (!RUNTIMES.includes(value as RuntimeId)) {
    throw new UsageError(`Unknown runtime "${value}". Choose one of: ${RUNTIMES.join(', ')}.`);
  }
  return value as RuntimeId;
}

const HELP = `agentsys — run approved coding-agent tasks and keep the evidence

  init      --operator <id>
  config    [--claude-cloud-session <id>] [--codex-env <id>] [--codex-skill-verified] [--show]
  policy    --subscription <id> [--five-hour <pct>] [--weekly <pct>] [--margin <pct>] [--max-age <s>]
            [--windows five-hour,weekly] [--ramp-hours <h>] --as <operator>
  policy    --subscription <id> --show
  floor     [--show] | --repo <owner/name> --pr-base <branch> --as <operator>
            | --repo <owner/name> --clear-pr-base --as <operator>
            | --read-only-project <id> --as <operator> | --writable-project <id> --as <operator>
            (limits no approval or grant can relax: a repo's required PR base, read-only cloud projects)
  approve   --repo <r> --scope <text> --class <c> --runtime <rt> --profile <p>
            --actions <a,b> [--max-attempts N] [--max-concurrent N] [--max-paid-usd N]
            [--model m] [--effort e]   (the tier this work is approved to run at)
            --as <operator>
  approvals
  grant     create|list|show|narrow|revoke   (see: agentsys grant)
  dispatch  --task <id> --repo <r> --class <c> --runtime <rt> --profile <p> --actions <a,b>
            [--job <id>] [--pr-base <b>] [--target-project <p>]
            --prompt <text> [--approval <id>] [--trigger-source <s>] [--model m] [--effort e]
            [--repo-path <dir>] [--estimate-five-hour N --estimate-weekly N --estimate-basis <b>]
            [--entry prompt]  (send the prompt as written instead of through the auto skill)
  intake    --event <file.json> [--class <c>] [--runtime <rt>] [--profile <p>] [--actions <a,b>]
            [--pr-base <b>]  (defaults to the repo's required base where it has one)
  jobs
  evidence  (the required checks acceptance is judged against, and whether that list is usable)
  recover   [--runtime <rt>]
  resolve-pi --run <id> --confirm-stopped --evidence <inspection-reference> --reason <text> --as <operator>
  feedback  --scorecard <id> --verdict <accepted|rework-needed|rejected> --reason <text> --as <operator>
  attest-delivery --run <id> --pr <number> --head <sha> [--body-digest <sha256>]
            --reason <text> --as <operator>  (operator-attested, not automatic)
  scorecards check --scorecard <id> --name <check> --outcome <passed|failed|skipped>
            --source <report-path-or-url> --head <sha> [--at <timestamp>] --as <operator>
  scorecards review --scorecard <id> --author <identity> --reviewer <identity>
            --relationship <author|independent|not-independent> --source <dimension-or-report>
            --head <sha> (--findings <file.json> | --no-findings) [--at <timestamp>] --as <operator>
            Findings file: [{"severity":"high","summary":"what the reviewer found"}]
            Use stable person/session identities, not model names. The author cannot be independent.
            --no-findings means a completed review found nothing, not that no review ran.
  scorecards repair --scorecard <id> --trigger <review-finding|failed-check> --detail <text>
            --head <repaired-sha> [--at <timestamp>] --as <operator>
            Every evidence write needs a full 40- or 64-character hexadecimal commit ID, not a branch or short SHA.
  scorecards [--repo <r>] [--class <c>] [--runtime <rt>] [--grant <id>]
  replay    suites | freeze --version <v> | run --version <v> --results <f.json> --configuration <c>
            | run --version <v> --configuration <stage:runtime/model/effort:digest> --repo <path> [--approval <id>]
            | controls --version <v> | trials | compare --version <v> --a <cfg> --b <cfg>
  version   [show|activate|rollback|candidates]
  status    [--task <id>] | --repo <path>  (with --repo: the loop's last pass and its log)
  loop      --repo <path> [--once] [--dry-run] [--interval <s>] [--policy-ref <ref>]
            [--stage <a,b>] [--release <pr>] [--e2e-worktree <dir>] [--coordinator-repo <path>]
            (--stage improve runs the improve stage now; otherwise it runs on its store-config interval)
  loop      arm --repo <path> [--interval <s>] [--policy-ref <ref>] | disarm | --armed
  evaluation --trust --repo <path> [--policy-ref <ref>]  (per work type and stage, from scorecards)
  console   --repo <path> --print  (the board: every open item's column, the system state, verdicts)
  ui        [--port <n>] [--repo <path> [--store-file <file.json>]]  (local loopback operator UI;
            --repo opens the console over that store, --store-file reads a fixture store instead of GitHub)
  usage     [--runtime <rt>]
  readiness [--runtime <rt>]
  reconcile <session-id> --runtime <rt>
  checks    [show] [--defer <name> --reason <text> --as <operator>] [--restore <name> --as <operator>]
  accept    --evidence <file.json> [--require <name>]...
  ledger    [show] [--set-allowance <usd> --as <operator>]
            reserve --task <id> --run <id> --operation <p:op> --bound-usd <n> --basis <text>
            settle <call-id> (--actual-usd <n> | --actual-unknown)
            release <call-id>

Every dispatch needs either an individual approval or an active standing grant.
A fresh install has neither, so work waits until an operator says otherwise.`;

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const [head, sub] = command;

  if (!head || head === 'help' || flag(flags, 'help')) {
    console.log(HELP);
    return 0;
  }

  switch (head) {
    case 'init': {
      const operator = requireString(flags, 'operator');
      writeConfig({ ...readConfig(), operator });
      console.log(`Operator set to ${operator}. No autonomy grants are active.`);
      return 0;
    }

    case 'config': {
      const cfg = readConfig();
      if (flag(flags, 'show') || flags.size === 0) {
        console.log(JSON.stringify({ ...cfg, stateRoot: stateRoot() }, null, 2));
        return 0;
      }
      const next: Config = { ...cfg };
      const claude = optionalString(flags, 'claude-cloud-session');
      if (claude) next.claudeCloudSessionId = claude;
      const codexEnv = optionalString(flags, 'codex-env');
      if (codexEnv) next.codexEnvId = codexEnv;
      if (flag(flags, 'codex-skill-verified')) next.codexSkillEntryVerified = true;
      writeConfig(next);
      console.log(JSON.stringify(next, null, 2));
      return 0;
    }

    case 'policy': {
      const subscriptionId = requireString(flags, 'subscription');
      const current = getPolicy(subscriptionId);
      if (flag(flags, 'show') || flags.size === 1) {
        console.log(JSON.stringify(current, null, 2));
        return 0;
      }
      assertOperator(actingOperator(flags));
      const rampHours = optionalNumber(flags, 'ramp-hours') ?? current.weeklyRampHours;
      if (rampHours !== undefined && (rampHours < 0 || rampHours > 168)) {
        throw new UsageError('--ramp-hours takes 0 (no ramp) up to 168, the hours in a week.');
      }
      savePolicy({
        subscriptionId,
        fiveHourThresholdPercent: optionalNumber(flags, 'five-hour') ?? current.fiveHourThresholdPercent,
        weeklyThresholdPercent: optionalNumber(flags, 'weekly') ?? current.weeklyThresholdPercent,
        safetyMarginPercent: optionalNumber(flags, 'margin') ?? current.safetyMarginPercent,
        maxReadingAgeSeconds: optionalNumber(flags, 'max-age') ?? current.maxReadingAgeSeconds,
        applicableWindows: parseWindows(optionalString(flags, 'windows')) ?? current.applicableWindows,
        // 0 turns the ramp off by leaving the field out, so the file reads as it did before there was one.
        ...(rampHours !== undefined && rampHours > 0 ? { weeklyRampHours: rampHours } : {}),
      });
      console.log(JSON.stringify(getPolicy(subscriptionId), null, 2));
      return 0;
    }

    case 'floor': {
      const current = readFloor();
      if (flag(flags, 'show') || flags.size === 0) {
        console.log(JSON.stringify(current, null, 2));
        return 0;
      }
      assertOperator(actingOperator(flags));
      const next = { prBases: { ...current.prBases }, readOnlyProjects: [...current.readOnlyProjects] };
      const repo = optionalString(flags, 'repo');
      const prBase = optionalString(flags, 'pr-base');
      if (prBase !== undefined || flag(flags, 'clear-pr-base')) {
        if (!repo) throw new UsageError('--pr-base and --clear-pr-base need --repo <owner/name>.');
        if (prBase !== undefined) next.prBases[repo] = prBase;
        else delete next.prBases[repo];
      }
      const readOnly = optionalString(flags, 'read-only-project');
      if (readOnly && !next.readOnlyProjects.includes(readOnly)) next.readOnlyProjects.push(readOnly);
      const writable = optionalString(flags, 'writable-project');
      if (writable) next.readOnlyProjects = next.readOnlyProjects.filter((p) => p !== writable);
      writeFloor(next);
      console.log(JSON.stringify(readFloor(), null, 2));
      return 0;
    }

    case 'approve': {
      const actor = actingOperator(flags);
      const runtime = parseRuntime(requireString(flags, 'runtime'));
      const model = optionalString(flags, 'model');
      const effort = optionalString(flags, 'effort');
      const approval = createApproval(actor, {
        repo: requireString(flags, 'repo'),
        taskScope: requireString(flags, 'scope'),
        workClass: requireString(flags, 'class'),
        runtime,
        profile: requireString(flags, 'profile'),
        actions: parseActions(flags),
        limits: {
          maxAttempts: optionalNumber(flags, 'max-attempts') ?? 3,
          maxConcurrentRuns: optionalNumber(flags, 'max-concurrent') ?? 1,
          maxPaidCallUsd: optionalNumber(flags, 'max-paid-usd') ?? 1,
        },
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      });
      console.log(`Approved ${approval.id} (version ${approval.version}) by ${actor.id}:`);
      console.log(renderApprovedTier(approval));
      console.log(JSON.stringify(approval, null, 2));
      return 0;
    }

    case 'approvals':
      console.log(JSON.stringify(listApprovals(), null, 2));
      return 0;

    case 'grant':
      return grantCommand(sub, flags);

    case 'intake': {
      const path = requireString(flags, 'event');
      const event = parseEventFile(path);
      const config: IntakeConfig = {
        workClass: optionalString(flags, 'class') ?? 'ci-repair',
        runtime: parseRuntime(optionalString(flags, 'runtime') ?? 'pi-local'),
        profile: optionalString(flags, 'profile') ?? 'default',
        actions: parseActions(flags, ['author-changes', 'open-pr']),
        obligations: list(flags, 'obligations').length > 0 ? list(flags, 'obligations') : ['unit', 'review'],
        ...(optionalString(flags, 'pr-base') !== undefined ? { prBase: optionalString(flags, 'pr-base')! } : {}),
      };
      const result = ingestCiFailure(event, config);
      if (result.job) console.log(`Job ${result.job.id} (${result.created ? 'new' : 'existing'}) for task ${result.job.taskId}`);
      for (const s2 of result.screened) {
        if (s2.suspicious) {
          console.log(`  ! ${s2.source} contains control-shaped text (${s2.attempts.map((a) => a.pattern).join(', ')}); quoted, not acted on.`);
        }
      }
      console.log(render(result.outcome));
      return result.decision?.allowed === true ? 0 : 1;
    }

    case 'recover': {
      const runtime = optionalString(flags, 'runtime');
      const reports = await recoverUnsettled(runtime === undefined ? undefined : parseRuntime(runtime));
      if (reports.length === 0) {
        console.log('No runs were left unsettled. Nothing to recover.');
        return 0;
      }
      for (const r of reports) {
        console.log(`${r.runId} (was ${r.before}):`);
        console.log(render(r.outcome).split('\n').map((l) => `  ${l}`).join('\n'));
      }
      const blocking = reports.filter((r) => r.blocksNewAttempt).length;
      console.log(`\n${reports.length} unsettled run(s); ${blocking} still block a new attempt.`);
      return blocking > 0 ? 1 : 0;
    }

    case 'resolve-pi': {
      const run = commands.resolvePiStopped(actingOperator(flags), {
        runId: requireString(flags, 'run'),
        confirmStopped: flag(flags, 'confirm-stopped'),
        evidence: requireString(flags, 'evidence'),
        reason: requireString(flags, 'reason'),
      });
      console.log(`Pi stop attested for ${run.id} by ${run.stopAttestation!.by}; checks-failed, task result and delivery unverified. Reservation released; inspect retained evidence before retrying.`);
      return 0;
    }

    case 'jobs': {
      const jobs = listJobs();
      if (jobs.length === 0) {
        console.log('No jobs recorded.');
        return 0;
      }
      for (const j of jobs) {
        console.log(
          `${j.id}  task=${j.taskId}  ${j.repo}  ${j.workClass}  ${j.state}` +
            `  runs=${j.runIds.length}  outstanding=[${j.outstandingObligations.join(', ')}]` +
            (j.duplicateSubmissions ? `  duplicates=${j.duplicateSubmissions}` : ''),
        );
      }
      return 0;
    }

    case 'feedback': {
      const actor = actingOperator(flags);
      const verdict = requireString(flags, 'verdict') as FeedbackVerdict;
      if (!['accepted', 'rework-needed', 'rejected'].includes(verdict)) {
        throw new UsageError(`--verdict must be accepted, rework-needed or rejected; got "${verdict}".`);
      }
      const card = commands.feedbackRecord(actor, requireString(flags, 'scorecard'), {
        verdict, reason: requireString(flags, 'reason'),
      });
      console.log(
        `Recorded ${card.feedback?.verdict} on ${card.id} by ${card.feedback?.by}` +
          (card.feedback?.supersedes ? ` (supersedes ${card.feedback.supersedes}, which is kept)` : ''),
      );
      return 0;
    }

    case 'attest-delivery': {
      const actor = actingOperator(flags);
      assertOperator(actor);
      const runId = requireString(flags, 'run');
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new UsageError('--run must be a run ID, not a path.');
      const run = getRun(runId);
      if (!run?.repo) throw new UsageError(`Run ${runId} has no recorded repository.`);
      const bodyDigest = optionalString(flags, 'body-digest');
      const entry = await attestDelivery(actor, new GhStore(run.repo), {
        runId, pr: requireNumber(flags, 'pr'), head: requireString(flags, 'head'),
        ...(bodyDigest !== undefined ? { bodyDigest } : {}),
        reason: requireString(flags, 'reason'),
      });
      console.log(`Operator-attested delivery by ${entry.by} for run ${entry.runId}, PR #${entry.pr} at ${entry.head}; not automatic delivery or merge approval.`);
      return 0;
    }

    case 'scorecards': {
      if (sub !== undefined) return scorecardRecordCommand(sub, flags);
      const view = commands.evaluation({
        view: 'scorecards',
        ...(optionalString(flags, 'repo') ? { repo: requireString(flags, 'repo') } : {}),
        ...(optionalString(flags, 'class') ? { workClass: requireString(flags, 'class') } : {}),
        ...(optionalString(flags, 'runtime') ? { runtime: parseRuntime(requireString(flags, 'runtime')) } : {}),
        ...(optionalString(flags, 'grant') ? { authorityId: requireString(flags, 'grant') } : {}),
      });
      if (view.view !== 'scorecards') throw new Error('Expected scorecards evaluation.');
      const report = view.report;
      console.log(`Samples: ${report.sampleCount}`);
      console.log(`  by status:    ${JSON.stringify(report.byStatus)}`);
      console.log(`  unresolved:   ${report.unresolved}`);
      console.log(`  failed checks:${report.failedAttempts}`);
      console.log(`  your verdicts:${JSON.stringify(report.operatorVerdicts)}`);
      console.log(`  unrated:      ${report.unrated}`);
      for (const entry of report.evidence) {
        console.log(`\n${entry.scorecardId} task=${entry.taskId}`);
        console.log(`  checks: ${entry.checkStatus === 'not-recorded' ? 'not recorded (not verified)' : `${entry.checks.length} recorded`}`);
        for (const check of entry.checks) {
          console.log(`    ${check.name}: ${check.outcome} — ${check.source}  head=${check.head ?? 'not recorded'}  at=${check.at ?? 'not recorded'}`);
        }
        console.log(`  review: ${entry.reviewStatus}; independent review: ${entry.independentReviewStatus}`);
        for (const review of entry.reviews) {
          console.log(`    ${review.findingCount === 0 ? 'reviewed, no findings' : `reviewed, ${review.findingCount} finding(s)`}` +
            ` — reviewer=${review.reviewer.id} (${review.reviewer.relationship}; independent=${review.reviewer.independent})` +
            ` author=${review.author} source=${review.source} head=${review.head ?? 'not recorded'} at=${review.at}`);
        }
        for (const finding of entry.reviewerFindings) {
          console.log(`    [${finding.severity}] ${finding.summary} — reviewer=${finding.reviewer.id}` +
            ` independent=${finding.reviewer.independent} author=${finding.author}` +
            ` source=${finding.source} head=${finding.head ?? 'not recorded'} at=${finding.at}`);
        }
        console.log(`  repairs: ${entry.repairs.length === 0 ? 'none recorded' : entry.repairs.length}`);
        for (const repair of entry.repairs) {
          console.log(`    ${repair.trigger}: ${repair.detail} — head=${repair.head ?? 'not recorded'} at=${repair.at}`);
        }
      }
      console.log(`\n${report.caveat}`);
      return 0;
    }

    case 'version':
      return versionCommand(sub, flags);

    case 'evidence': {
      const view = commands.evidence();
      console.log(`Required checks: ${view.requiredChecks.length}`);
      for (const check of view.requiredChecks) {
        console.log(`  ${check.name} (${check.requiredClass})${check.deferral ? `  DEFERRED by ${check.deferral.deferredBy}: ${check.deferral.reason}` : ''}`);
      }
      console.log(view.configuration.valid
        ? 'Configuration: usable.'
        : `Configuration: NOT usable — ${view.configuration.error}`);
      return 0;
    }

    case 'dispatch':
      return await dispatchCommand(flags);

    case 'loop':
      return await loopCommand(sub, flags);

    case 'evaluation': {
      if (!flag(flags, 'trust')) throw new UsageError('Usage: agentsys evaluation --trust --repo <path> [--policy-ref <ref>]');
      const repo = new GitRepo(requireString(flags, 'repo'));
      const slug = await repo.slug();
      const ref = optionalString(flags, 'policy-ref') ?? `origin/${integrationBase(slug)}`;
      await repo.fetch([ref.replace(/^origin\//, '')]).catch(() => undefined);
      const policy = parseStoreConfig(await repo.show(ref, STORE_CONFIG_PATH), `${STORE_CONFIG_PATH} at ${ref}`);
      useMarkerPrefix(policy.protocol.markerPrefix.value);
      console.log(`Trust report for ${slug}, stop-lines from ${policy.source}\n`);
      console.log(renderTrust(trustReport(listScorecards(), policy, slug)));
      return 0;
    }

    case 'status': {
      const repoPath = optionalString(flags, 'repo');
      if (repoPath !== undefined) {
        const slug = await new GitRepo(repoPath).slug();
        const last = lastPass(slug);
        if (!last) {
          console.log(`No loop pass recorded for ${slug}.`);
          return 0;
        }
        console.log(`${slug}: last pass ${last.passId} ended ${last.endedAt} — ${last.classification}: ${last.because}`);
        console.log('');
        console.log('stage     rung          queue  dispatched  produced  blocked  waiting');
        for (const s of last.stages) {
          const c = s.counts;
          console.log(`${s.stage.padEnd(9)} ${s.rung.padEnd(13)} ${String(c.queue).padStart(5)} ${String(c.dispatched).padStart(11)} ${String(c.produced).padStart(9)} ${String(c.blocked).padStart(8)} ${String(c.waiting).padStart(8)}`);
        }
        const tail = passLogTail(slug, 80);
        if (tail) console.log(`\nPass log (last lines of ${join(loopDir(slug), 'passes.log')}):\n${tail}`);
        return 0;
      }
      const taskId = optionalString(flags, 'task');
      const runs = listRuns().filter((r) => !taskId || r.taskId === taskId);
      if (runs.length === 0) {
        console.log(taskId ? `No runs for task ${taskId}.` : 'No runs recorded.');
        return 0;
      }
      for (const r of runs) {
        const elapsed = r.endedAt
          ? `${Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)}s`
          : `${Math.round((Date.now() - Date.parse(r.startedAt)) / 1000)}s so far`;
        console.log(
          `${r.id}  task=${r.taskId}  attempt=${r.attempt}  ${r.runtime}  ${r.status}  ${elapsed}` +
            `  authority=${r.authority.type}:${r.authority.id}@v${r.authority.version}` +
            `  model=${r.settings.resolved.model}/${r.settings.resolved.effort}` +
            `  observed=${r.settings.observed.model}/${r.settings.observed.effort}`,
        );
        if (r.summary) console.log(`    ${r.summary}`);
      }
      const outstanding = listReservations().filter((x) => x.state !== 'released');
      if (outstanding.length > 0) {
        console.log(`\nOutstanding subscription reservations: ${outstanding.length}`);
        for (const x of outstanding) {
          console.log(`  ${x.id} ${x.subscriptionId} ${x.state} run=${x.runId}${x.note ? ` — ${x.note}` : ''}`);
        }
      }
      return 0;
    }

    case 'console': {
      if (!flag(flags, 'print')) throw new UsageError('Usage: agentsys console --repo <path> --print');
      const { board } = await readBoard(await consoleTarget(new GitRepo(requireString(flags, 'repo'))));
      console.log(renderBoard(board));
      return board.stale && !board.snapshotAt ? 1 : 0;
    }

    case 'ui':
      return await uiCommand(flags);

    case 'usage': {
      const runtimes = optionalString(flags, 'runtime')
        ? [parseRuntime(requireString(flags, 'runtime'))]
        : RUNTIMES;
      for (const rt of runtimes) {
        const adapter = adapterFor(rt);
        const result = await adapter.readUsage();
        if (result.ok) {
          console.log(`${rt} (${adapter.capabilities.subscriptionId}) via ${result.reading.source}:`);
          for (const w of result.reading.windows) {
            console.log(`  ${w.kind.padEnd(10)} ${String(w.usedPercent).padStart(3)}% used  [${w.vendorLabel}]${w.resetsAt ? `  resets ${w.resetsAt}` : ''}`);
          }
          const acct = result.reading.account;
          console.log(
            acct
              ? `  account    ${acct.id}${acct.plan ? ` (${acct.plan})` : ''}  via ${acct.source}`
              : '  account    not reported by this runtime',
          );
          for (const line of ceilingLines(result.reading)) console.log(line);
        } else {
          console.log(`${rt} (${adapter.capabilities.subscriptionId}): usage UNAVAILABLE`);
          console.log(`  reason: ${result.unavailable.reason}`);
          console.log(`  next:   ${result.unavailable.operatorAction}`);
        }
      }
      return 0;
    }

    case 'readiness': {
      const runtimes = optionalString(flags, 'runtime')
        ? [parseRuntime(requireString(flags, 'runtime'))]
        : RUNTIMES;
      let blocked = 0;
      for (const rt of runtimes) {
        const outcome = await adapterFor(rt).checkReadiness();
        if (outcome) {
          blocked++;
          console.log(`${rt}: NOT READY`);
          console.log(render(outcome).split('\n').map((l) => `  ${l}`).join('\n'));
        } else {
          console.log(`${rt}: ready`);
        }
      }
      return blocked > 0 ? 1 : 0;
    }

    case 'reconcile': {
      const sessionId = sub;
      if (!sessionId) throw new UsageError('Usage: agentsys reconcile <session-id> --runtime <rt>');
      const runtime = parseRuntime(requireString(flags, 'runtime'));
      const storedRun = listRuns().find((run) => run.runtime === runtime && run.sessionId === sessionId);
      const outcome = await adapterFor(runtime).reconcile(sessionId, storedRun?.evidenceDir);
      console.log(render(outcome));
      // Exit 0 only when the session is genuinely settled. Returning 0 for an
      // uncertain or failed reconciliation would tell a calling script that an
      // in-flight session had finished.
      return outcome.kind === 'completed' || outcome.kind === 'checks-failed' ? 0 : 1;
    }

    case 'replay': {
      const sub = command[1] ?? 'suites';

      if (sub === 'suites') {
        const suites = listSuites();
        if (suites.length === 0) {
          console.log('No suite has been frozen. `agentsys replay freeze --version <v>` writes the built-in one.');
          return 0;
        }
        for (const s2 of suites) {
          console.log(`${s2.version}  ${s2.cases.length} case(s)  oracle ${s2.oracleDigest.slice(0, 12)}  frozen ${s2.frozenAt}`);
          for (const c of s2.cases) console.log(`    ${c.kind.padEnd(32)} ${c.id}`);
        }
        return 0;
      }

      if (sub === 'freeze') {
        const suite = freezeBuiltinSuite(requireString(flags, 'version'));
        console.log(`Suite ${suite.version} frozen with ${suite.cases.length} case(s); oracle ${suite.oracleDigest}.`);
        const covered = new Set(suite.cases.map((c) => c.kind));
        const missing = CASE_KINDS.filter((k) => !covered.has(k));
        // A suite that silently covers three of the four classes would still run
        // and still report passes, so the gap is named rather than left implicit.
        if (missing.length > 0) console.log(`  Not covered: ${missing.join(', ')}`);
        return missing.length > 0 ? 1 : 0;
      }

      const version = requireString(flags, 'version');
      const suite = getSuite(version);
      if (!suite) {
        console.log(`No frozen suite "${version}". Freeze one first: \`agentsys replay freeze --version ${version}\`.`);
        return 1;
      }

      if (sub === 'controls') {
        const { baselinePassed, controls, allHeld } = runControls(suite);
        console.log(`Healthy baseline: ${baselinePassed} of ${suite.cases.length} case(s) passed.\n`);
        for (const c of controls) {
          console.log(`${c.held ? 'HELD   ' : 'BROKEN '} ${c.id}`);
          console.log(`         ${c.description}`);
          console.log(`         requires: ${c.requires}`);
          console.log(`         ${c.detail}`);
        }
        console.log(allHeld
          ? '\nEvery control degraded the result, which is what they exist to prove.'
          : '\nA control did not degrade the result. Damaged evidence is scoring as well as clean evidence.');
        return allHeld ? 0 : 1;
      }

      if (sub === 'run' && optionalString(flags, 'results') === undefined) {
        // No results file: run the suite's cases for real, through the stage's prompt on the named tier.
        const config = parseConfiguration(requireString(flags, 'configuration'));
        const repo = new GitRepo(resolve(requireString(flags, 'repo')));
        const slug = await repo.slug();
        const approvalId = optionalString(flags, 'approval');
        const trial = await replaySuite({
          repo,
          dispatch: (input) => commands.dispatch(input),
          scratch: join(stateRoot(), 'replay', newId('replay')),
          ...(approvalId ? { approvalId } : {}),
          pull: async (n) => JSON.parse(await runGh(['pr', 'view', String(n), '--repo', slug, '--json', 'title,body'])) as { title: string; body: string },
        }, suite, config);
        for (const r of trial.runs) console.log(`  ${r.caseId}: run ${r.runId ?? 'none'} — ${r.outcome}; observed ${r.observed}`);
        console.log(`Suite ${trial.suiteVersion} under ${trial.configuration}: ${trial.passed} passed, ${trial.failed} failed, ${trial.total} total.`);
        for (const v of trial.caseVerdicts) console.log(`  ${v.passed ? 'pass' : 'FAIL'}  ${v.caseId}: ${v.reason}`);
        return trial.failed > 0 ? 1 : 0;
      }

      if (sub === 'run') {
        const results = JSON.parse(readFileSync(requireString(flags, 'results'), 'utf8')) as CaseResult[];
        if (!Array.isArray(results)) {
          console.log('The results file must contain an array of case results.');
          return 2;
        }
        const trial = scoreTrial(suite, results, requireString(flags, 'configuration'));
        console.log(`Suite ${trial.suiteVersion} under ${trial.configuration}: ${trial.passed} passed, ${trial.failed} failed, ${trial.total} total.`);
        if (trial.oracleTampered) console.log('  The oracle moved between freezing and running; every case fails.');
        for (const v of trial.caseVerdicts) console.log(`  ${v.passed ? 'pass' : 'FAIL'}  ${v.caseId}: ${v.reason}`);
        return trial.failed > 0 ? 1 : 0;
      }

      if (sub === 'trials') {
        const trials = listTrials().filter((t) => t.suiteVersion === version);
        if (trials.length === 0) {
          console.log(`No retained trial for suite ${version}.`);
          return 0;
        }
        for (const t of trials) {
          console.log(`${t.ranAt}  ${t.configuration.padEnd(28)} ${t.passed}/${t.total} passed${t.oracleTampered ? '  (oracle moved)' : ''}`);
        }
        return 0;
      }

      if (sub === 'compare') {
        // A replay records its configuration with a twelve-character digest; name it however it was typed.
        const canonical = (text: string): string => {
          let c;
          try { c = parseConfiguration(text); } catch { return text; }
          const prefix = `${c.stage}:${c.runtime}/${c.model}/${c.effort}:${c.digest}`;
          return listTrials().find((t) => t.suiteVersion === version && t.configuration.startsWith(prefix))?.configuration ?? renderConfiguration(c);
        };
        const a = canonical(requireString(flags, 'a'));
        const b = canonical(requireString(flags, 'b'));
        const rows = compareConfigurations(listTrials().filter((t) => t.suiteVersion === version), a, b);
        const sampleA = listTrials().filter((t) => t.suiteVersion === version && t.configuration === a).length;
        const sampleB = listTrials().filter((t) => t.suiteVersion === version && t.configuration === b).length;
        console.log(`Suite ${version}: ${a} (${sampleA} trial(s)) vs ${b} (${sampleB} trial(s))`);
        // `not run` is deliberately distinct from `FAIL`: a configuration that
        // never exercised a case has said nothing about it.
        const show = (v: boolean | undefined): string => (v === undefined ? 'not run' : v ? 'pass' : 'FAIL');
        for (const r of rows) console.log(`  ${r.caseId.padEnd(34)} ${show(r.a).padEnd(8)} ${show(r.b)}`);
        if (sampleA === 0 || sampleB === 0) {
          console.log('\nOne side has no trials, so this compares nothing. Run both configurations first.');
          return 1;
        }
        return 0;
      }

      console.log('Usage: agentsys replay suites|freeze|run|controls|trials|compare');
      return 2;
    }

    case 'checks': {
      const checksPath = join(stateRoot(), 'required-checks.json');
      const current = readJson<RequiredCheck[]>(checksPath) ?? [];

      const deferName = optionalString(flags, 'defer');
      const restoreName = optionalString(flags, 'restore');
      if (deferName !== undefined || restoreName !== undefined) {
        // Deferring removes a check from what blocks acceptance, so it is an
        // authority decision and takes the operator flag, exactly like raising the
        // paid-call allowance does.
        const actor = actingOperator(flags);
        assertOperator(actor);
        const name = deferName ?? restoreName!;
        const found = current.find((c) => c.name === name);
        if (!found) {
          console.error(`No required check named "${name}". Run \`agentsys checks\` to see them.`);
          return 1;
        }
        if (deferName !== undefined) {
          found.deferral = {
            reason: requireString(flags, 'reason'),
            deferredBy: actor.id,
            deferredAt: new Date().toISOString(),
          };
        } else {
          delete found.deferral;
        }
        writeJson(checksPath, current);
      }

      const checks = readJson<RequiredCheck[]>(checksPath) ?? [];
      if (checks.length === 0) {
        console.log('No required checks are configured yet.');
        return 0;
      }
      for (const c of checks) {
        const state = c.deferral
          ? `DEFERRED by ${c.deferral.deferredBy} on ${c.deferral.deferredAt} — ${c.deferral.reason}`
          : 'required';
        console.log(`  ${c.name} (${c.requiredClass}) — ${state}`);
      }
      const deferredCount = checks.filter((c) => c.deferral).length;
      if (deferredCount > 0) {
        console.log(
          `\n${deferredCount} check(s) deferred. Deferred means untested and unverified, not passed.`,
        );
      }
      return 0;
    }

    case 'accept': {
      const checks = readJson<RequiredCheck[]>(join(stateRoot(), 'required-checks.json')) ?? [];
      if (checks.length === 0) {
        console.error('No required checks are configured; there is nothing to accept against.');
        return 2;
      }
      const config = readConfig();
      if (config.operator) assertOperatorDeferrals(checks, config.operator);

      const evidencePath = requireString(flags, 'evidence');
      const payload = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
        candidate: Parameters<typeof aggregate>[0];
        evidence: EvidenceItem[];
      };
      const report = aggregate(payload.candidate, checks, payload.evidence, {
        enforceDeferred: list(flags, 'require'),
      });

      for (const v of report.verdicts) {
        const mark = v.satisfied ? 'ok      ' : v.deferred ? 'deferred' : 'BLOCKED ';
        console.log(`${mark} ${v.check} — ${v.detail}`);
      }
      console.log(`\n${report.scopeStatement}`);
      if (report.flaky.length > 0) console.log(`Flaky: ${report.flaky.join(', ')}`);
      console.log(report.accepted ? '\nACCEPTED for the tested scope.' : '\nNOT ACCEPTED.');
      return report.accepted ? 0 : 1;
    }

    case 'ledger': {
      if (sub === 'reserve') {
        const decision = reserveCall({
          taskId: requireString(flags, 'task'),
          runId: requireString(flags, 'run'),
          operation: requireString(flags, 'operation'),
          boundUsd: requireNumber(flags, 'bound-usd'),
          boundBasis: requireString(flags, 'basis'),
        });
        if (!decision.allowed) {
          console.log(render(decision.outcome));
          return 1;
        }
        const { reservation } = decision;
        console.log(`Reserved ${formatUsd(reservation.boundUsd)} for ${reservation.operation} as ${reservation.id}.`);
        console.log(`  basis: ${reservation.boundBasis}`);
        console.log(`  remaining allowance: ${formatUsd(decision.remainingUsd)}`);
        console.log(`  settle it with: agentsys ledger settle ${reservation.id} --actual-usd <n>`);
        return 0;
      }

      if (sub === 'settle') {
        const id = command[2];
        if (!id) throw new UsageError('Usage: agentsys ledger settle <call-id> (--actual-usd <n> | --actual-unknown)');
        const actual = optionalNumber(flags, 'actual-usd');
        // An omitted figure is not the same as a free call. Recording "unknown" has
        // to be deliberate, or a forgotten flag would quietly become the record.
        if (actual === undefined && !flag(flags, 'actual-unknown')) {
          throw new UsageError(
            `What did ${id} cost? Pass --actual-usd <n>, or --actual-unknown if the provider reports no figure. `
            + 'An unknown actual keeps charging the reserved bound.',
          );
        }
        const settled = settleCall(id, actual);
        if (!settled) {
          console.error(`No paid call ${id} in the ledger.`);
          return 1;
        }
        const cost = settled.actualUnknown
          ? `actual unknown, still charging the ${formatUsd(settled.boundUsd)} bound`
          : formatUsd(settled.actualUsd ?? 0);
        console.log(`Settled ${settled.id} (${settled.operation}): ${cost}.`);
        console.log(`  remaining allowance: ${formatUsd(remainingUsd())}`);
        return 0;
      }

      if (sub === 'release') {
        const id = command[2];
        if (!id) throw new UsageError('Usage: agentsys ledger release <call-id>');
        const released = releaseCall(id);
        if (!released) {
          console.error(`No paid call ${id} in the ledger.`);
          return 1;
        }
        if (released.state === 'settled') {
          console.error(`${id} is already settled at ${released.settledAt}; a settled call is not released.`);
          return 1;
        }
        console.log(`Released ${released.id} (${released.operation}); the call did not happen.`);
        console.log(`  remaining allowance: ${formatUsd(remainingUsd())}`);
        return 0;
      }

      if (sub !== undefined && sub !== 'show') {
        throw new UsageError(`Unknown ledger subcommand "${sub}". Use show, reserve, settle or release.`);
      }

      const allowance = optionalNumber(flags, 'set-allowance');
      if (allowance !== undefined) {
        const actor = actingOperator(flags);
        assertOperator(actor);
        setLedgerPolicy({ allowanceUsd: allowance, setBy: actor.id, setAt: new Date().toISOString() });
      }
      const policy = getLedgerPolicy();
      console.log(`Paid-call allowance: ${formatUsd(policy.allowanceUsd)}  remaining: ${formatUsd(remainingUsd())}`);
      if (policy.setBy) console.log(`  last changed by ${policy.setBy} at ${policy.setAt}`);
      for (const c of listCalls()) {
        const cost = c.state === 'settled'
          ? c.actualUnknown ? `bound ${formatUsd(c.boundUsd)} (actual unknown)` : formatUsd(c.actualUsd ?? 0)
          : formatUsd(c.boundUsd);
        console.log(`  ${c.id} ${c.operation} ${c.state} ${cost} — ${c.boundBasis}`);
      }
      return 0;
    }

    default:
      console.error(`Unknown command "${head}".\n`);
      console.log(HELP);
      return 2;
  }
}

function scorecardRecordCommand(sub: string, flags: Map<string, string | true>): number {
  switch (sub) {
    case 'check': {
      const head = requireString(flags, 'head');
      const at = optionalString(flags, 'at');
      const card = commands.checkResultRecord(actingOperator(flags), requireString(flags, 'scorecard'), {
        name: requireString(flags, 'name'), outcome: requireString(flags, 'outcome') as CheckResult['outcome'],
        source: requireString(flags, 'source'), head,
        ...(at !== undefined ? { at } : {}),
      });
      console.log(`Recorded check result on ${card.id}. Earlier results are kept.`);
      return 0;
    }
    case 'review': {
      const findingsPath = optionalString(flags, 'findings');
      if ((findingsPath !== undefined) === flag(flags, 'no-findings')) {
        throw new UsageError('Use exactly one of --findings <file.json> or --no-findings for a completed review.');
      }
      let findings: ReviewInput['findings'] = [];
      if (findingsPath !== undefined) {
        try {
          // The shared writer validates every finding before any state is changed.
          findings = JSON.parse(readFileSync(findingsPath, 'utf8')) as ReviewInput['findings'];
        } catch (err) {
          throw new UsageError(`Cannot read findings JSON at ${findingsPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const at = optionalString(flags, 'at');
      const card = commands.reviewRecord(actingOperator(flags), requireString(flags, 'scorecard'), {
        author: requireString(flags, 'author'),
        reviewer: {
          id: requireString(flags, 'reviewer'),
          relationship: requireString(flags, 'relationship') as ReviewerRelationship,
        },
        source: requireString(flags, 'source'), head: requireString(flags, 'head'), findings,
        ...(at !== undefined ? { at } : {}),
      });
      console.log(`Recorded completed review on ${card.id}: ${findings.length} finding(s).`);
      return 0;
    }
    case 'repair': {
      const head = requireString(flags, 'head');
      const at = optionalString(flags, 'at');
      const card = commands.repairRecord(actingOperator(flags), requireString(flags, 'scorecard'), {
        trigger: requireString(flags, 'trigger') as RepairCycle['trigger'], detail: requireString(flags, 'detail'),
        head, ...(at !== undefined ? { at } : {}),
      });
      console.log(`Recorded repair on ${card.id}. Renewed checks and reviews must be recorded separately.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown scorecards subcommand "${sub}". Use check, review or repair; see agentsys --help.`);
  }
}

interface UiServerHandle {
  url: string;
  close(): Promise<void> | void;
}

interface UiServerModule {
  startUiServer(options: {
    port?: number;
    repoRoots: string[];
    commands: typeof commands;
    console?: ConsoleCommands;
  }): Promise<UiServerHandle>;
}

/**
 * The console over one target store: GitHub through the operator's `gh` login,
 * or, with `--store-file`, a fixture store kept in a JSON file.
 */
async function consoleFor(repoPath: string, storeFile: string | undefined): Promise<ConsoleCommands> {
  const repo = new GitRepo(resolve(repoPath));
  const fileStore = storeFile ? new FileStore(resolve(storeFile)) : undefined;
  const target = await consoleTarget(repo, fileStore);
  const store = fileStore ?? new GhStore(target.slug);
  return createConsoleCommands({
    target, store, git: repo, coordinator: commands,
    mergeStage: (ref) => actOnStageItem({ repo, store, commands: coordinatorCommands(undefined, (line) => console.log(line)), log: (line) => console.log(line) }, 'merge', ref),
  });
}

/** Start the optional loopback operator UI and keep its lifecycle explicit. */
async function uiCommand(flags: Map<string, string | true>): Promise<number> {
  const port = optionalNumber(flags, 'port');
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new UsageError('--port must be an integer from 0 through 65535.');
  }
  const modulePath = '../ui/server.js';
  let ui: UiServerModule;
  try {
    ui = await import(modulePath) as unknown as UiServerModule;
  } catch (err) {
    throw new UsageError(
      `The local UI is not built in this checkout: ${err instanceof Error ? err.message : String(err)}. ` +
      'Build the UI-enabled package, then run `agentsys ui` again.',
    );
  }

  const configured = readConfig().operator;
  if (!configured) {
    console.error('Warning: no operator is configured. Run `agentsys init --operator <id>` before using UI mutations.');
  }
  const repoPath = optionalString(flags, 'repo');
  const storeFile = optionalString(flags, 'store-file');
  if (storeFile && !repoPath) throw new UsageError('--store-file needs --repo: the fixture store stands in for that repository\'s GitHub.');
  const started = await ui.startUiServer({
    ...(port !== undefined ? { port } : {}),
    repoRoots: [process.cwd()],
    commands,
    ...(repoPath ? { console: await consoleFor(repoPath, storeFile) } : {}),
  });
  console.log(`Agent system UI listening at ${started.url}`);
  console.log('The UI is local-only; Ctrl-C stops it. A local process under this OS identity is not a security sandbox.');

  await new Promise<void>((resolve, reject) => {
    let closed = false;
    const stop = (): void => {
      if (closed) return;
      closed = true;
      Promise.resolve(started.close()).then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/**
 * Read `--windows five-hour,weekly` into the set a subscription is metered on.
 *
 * Empty is refused rather than accepted as "no window applies", which would admit
 * work against nothing at all — the most permissive reading of a typo.
 */
function parseWindows(raw: string | undefined): MeteredWindow[] | undefined {
  if (raw === undefined) return undefined;
  const allowed: MeteredWindow[] = ['five-hour', 'weekly'];
  const parsed = raw.split(',').map((w) => w.trim()).filter((w) => w !== '');
  if (parsed.length === 0) {
    throw new UsageError('--windows needs at least one window; a subscription metered on nothing cannot be admitted against.');
  }
  for (const w of parsed) {
    if (!allowed.includes(w as MeteredWindow)) {
      throw new UsageError(`--windows does not accept "${w}". It takes ${allowed.join(' and ')}.`);
    }
  }
  return [...new Set(parsed)] as MeteredWindow[];
}

async function loopCommand(sub: string | undefined, flags: Map<string, string | true>): Promise<number> {
  if (sub === 'arm') {
    const interval = optionalNumber(flags, 'interval') ?? 900;
    if (!Number.isInteger(interval) || interval < 60) throw new UsageError('--interval is whole seconds, at least 60.');
    const policyRef = optionalString(flags, 'policy-ref');
    const lines = await arm({ repoPath: requireString(flags, 'repo'), intervalSeconds: interval, ...(policyRef ? { policyRef } : {}) }, process.argv[1]!);
    for (const line of lines) console.log(line);
    return 0;
  }
  if (sub === 'disarm') {
    for (const line of await disarm()) console.log(line);
    return 0;
  }
  if (sub !== undefined) throw new UsageError(`Unknown loop subcommand "${sub}". Use arm, disarm, or flags alone.`);

  const armed = flag(flags, 'armed') ? readArmed() : undefined;
  if (flag(flags, 'armed') && !armed) throw new UsageError(`--armed needs ${armedConfigPath()}; run \`agentsys loop arm\` first.`);
  const repoPath = armed?.repoPath ?? requireString(flags, 'repo');
  const interval = armed?.intervalSeconds ?? optionalNumber(flags, 'interval') ?? 900;
  const policyRef = armed?.policyRef ?? optionalString(flags, 'policy-ref');
  const stages = list(flags, 'stage');
  const known = [...STAGES.map((s) => s.name), 'improve'];
  const unknown = stages.filter((s) => !known.includes(s));
  if (unknown.length > 0) throw new UsageError(`Unknown stage(s): ${unknown.join(', ')}. Stages: ${known.join(', ')}.`);
  const release = optionalNumber(flags, 'release');
  const e2e = optionalString(flags, 'e2e-worktree');
  const report = await runLoop({
    repoPath,
    once: flag(flags, 'once'),
    dryRun: flag(flags, 'dry-run'),
    intervalSeconds: interval,
    ...(policyRef ? { policyRef } : {}),
    ...(stages.length > 0 ? { stages: stages as PassStage[] } : {}),
    ...(optionalString(flags, 'coordinator-repo') ? { coordinatorRepo: requireString(flags, 'coordinator-repo') } : {}),
    ...(release !== undefined ? { releasePr: release } : {}),
    ...(e2e ? { e2eWorktree: e2e } : {}),
  });
  return report && report.classification !== 'breach' ? 0 : 1;
}

function versionCommand(sub: string | undefined, flags: Map<string, string | true>): number {
  switch (sub ?? 'show') {
    case 'show': {
      const active = activeVersion();
      console.log(active
        ? JSON.stringify(active, null, 2)
        : 'No version has been activated. The system is running from an unactivated build.');
      return 0;
    }
    case 'candidates':
      console.log(JSON.stringify(listCandidates(), null, 2));
      return 0;
    case 'history':
      console.log(JSON.stringify(versionHistory(), null, 2));
      return 0;
    case 'record-candidate': {
      const record = recordCandidate({
        coordinator: requireString(flags, 'coordinator'),
        adapters: {},
        prompts: optionalString(flags, 'prompts') ?? 'unrecorded',
        origin: requireString(flags, 'origin'),
        purpose: requireString(flags, 'purpose'),
      });
      console.log(`Recorded candidate ${record.id}. This is a test subject, not the running system.`);
      return 0;
    }
    case 'activate': {
      const actor = actingOperator(flags);
      const record = activateVersion(actor, {
        coordinator: requireString(flags, 'coordinator'),
        adapters: {},
        prompts: optionalString(flags, 'prompts') ?? 'unrecorded',
        mergedPr: requireString(flags, 'merged-pr'),
        mergeConfirmed: flag(flags, 'merge-confirmed'),
      });
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }
    case 'rollback': {
      const record = rollback(actingOperator(flags));
      console.log(`Rolled back to ${record.coordinator}.`);
      return 0;
    }
    default:
      console.log('agentsys version [show|history|candidates|record-candidate|activate|rollback]');
      return 2;
  }
}

function grantCommand(sub: string | undefined, flags: Map<string, string | true>): number {
  switch (sub) {
    case 'create': {
      const actor = actingOperator(flags);
      const grant = createGrant(actor, {
        repos: list(flags, 'repos'),
        workClasses: list(flags, 'classes'),
        triggerSources: list(flags, 'sources'),
        actions: parseActions(flags),
        runtimes: list(flags, 'runtimes').map(parseRuntime),
        profiles: list(flags, 'profiles'),
        perTask: {
          maxAttempts: optionalNumber(flags, 'max-attempts') ?? 3,
          maxConcurrentRuns: optionalNumber(flags, 'max-concurrent') ?? 1,
          maxPaidCallUsd: optionalNumber(flags, 'max-paid-usd') ?? 1,
        },
        aggregate: {
          maxDispatchesPerWindow: requireNumber(flags, 'max-dispatches'),
          windowHours: optionalNumber(flags, 'window-hours') ?? 24,
          maxConcurrentRuns: optionalNumber(flags, 'max-aggregate-concurrent') ?? 1,
        },
        reason: requireString(flags, 'reason'),
      });
      console.log('Granted standing authority. Scope and limits as approved:');
      console.log(JSON.stringify(grant, null, 2));
      console.log('\nRelevant history at the time of the decision:');
      console.log(summariseHistory(grant.repos, grant.workClasses));
      return 0;
    }
    case 'list':
      console.log(JSON.stringify(listGrants(), null, 2));
      return 0;
    case 'show': {
      const id = requireString(flags, 'id');
      const grant = getGrant(id);
      if (!grant) throw new UsageError(`No grant "${id}".`);
      console.log(JSON.stringify(grant, null, 2));
      return 0;
    }
    case 'narrow': {
      const actor = actingOperator(flags);
      const id = requireString(flags, 'id');
      const input: Parameters<typeof narrowGrant>[2] = { reason: requireString(flags, 'reason') };
      if (list(flags, 'repos').length > 0) input.repos = list(flags, 'repos');
      if (list(flags, 'classes').length > 0) input.workClasses = list(flags, 'classes');
      if (list(flags, 'sources').length > 0) input.triggerSources = list(flags, 'sources');
      if (list(flags, 'actions').length > 0) input.actions = parseActions(flags);
      if (list(flags, 'runtimes').length > 0) input.runtimes = list(flags, 'runtimes').map(parseRuntime);
      if (list(flags, 'profiles').length > 0) input.profiles = list(flags, 'profiles');
      const maxDispatches = optionalNumber(flags, 'max-dispatches');
      if (maxDispatches !== undefined) input.aggregate = { maxDispatchesPerWindow: maxDispatches };
      console.log(JSON.stringify(narrowGrant(actor, id, input), null, 2));
      return 0;
    }
    case 'revoke': {
      const actor = actingOperator(flags);
      const grant = revokeGrant(actor, requireString(flags, 'id'), requireString(flags, 'reason'));
      console.log(`Revoked ${grant.id} at version ${grant.version}.`);
      const affected = activeRuns().filter((r) => r.authority.id === grant.id);
      if (affected.length > 0) {
        console.log(`\n${affected.length} run(s) were authorized by it and are still in flight:`);
        for (const r of affected) {
          console.log(`  ${r.id} (${r.runtime}, session ${r.sessionId ?? 'unknown'}) — checkpoint requested`);
        }
        console.log('Their results cannot be adopted or published under this grant. Cancellation is requested,');
        console.log('not guaranteed: any session the vendor does not confirm stopped keeps its reservation.');
      }
      return 0;
    }
    default:
      console.log(`agentsys grant create|list|show|narrow|revoke

  create --repos a/b --classes ci-repair --sources <src> --actions author-changes,open-pr
         --runtimes pi-local --profiles default --max-dispatches N [--window-hours H]
         [--max-aggregate-concurrent N] --reason <why> --as <operator>
  narrow --id <id> [--repos ...] [--classes ...] --reason <why> --as <operator>
  revoke --id <id> --reason <why> --as <operator>

Narrowing accepts only subsets and smaller numbers. To widen, revoke and issue a new grant.`);
      return sub === undefined ? 0 : 2;
  }
}

/** What the operator should see about comparable past work when granting authority. */
function summariseHistory(repos: string[], classes: string[]): string {
  const runs = listRuns().filter((r) => repos.includes(r.candidate?.repo ?? ''));
  if (runs.length === 0) {
    return `  No prior runs recorded for ${repos.join(', ')} / ${classes.join(', ')}.\n` +
      '  There is no evaluation history behind this decision yet.';
  }
  const byStatus = new Map<string, number>();
  for (const r of runs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  return (
    `  ${runs.length} prior run(s): ` +
    [...byStatus].map(([s, n]) => `${s}=${n}`).join(', ') +
    '\n  These counts are outcomes, not a reliability claim; the decision is yours.'
  );
}

/** One line an operator can check at a glance, ahead of the record itself. */
function renderApprovedTier(approval: { runtime: RuntimeId; model?: string; effort?: string }): string {
  if (approval.model === undefined && approval.effort === undefined) {
    return `  tier: none named — ${approval.runtime} runs at whatever the dispatch or the runtime default picks.`;
  }
  return `  tier: model ${approval.model ?? 'not named'}, effort ${approval.effort ?? 'not named'} on ${approval.runtime}.`;
}

async function dispatchCommand(flags: Map<string, string | true>): Promise<number> {
  const taskId = requireString(flags, 'task');
  const runtime = parseRuntime(requireString(flags, 'runtime'));
  const repo = requireString(flags, 'repo');
  const workClass = requireString(flags, 'class');
  const profile = requireString(flags, 'profile');
  const prompt = requireString(flags, 'prompt');
  const actions = parseActions(flags);
  const approvalId = optionalString(flags, 'approval');
  const triggerSource = optionalString(flags, 'trigger-source');
  const prBase = optionalString(flags, 'pr-base');
  const targetProject = optionalString(flags, 'target-project');
  const repoPath = optionalString(flags, 'repo-path');
  const jobId = optionalString(flags, 'job');
  const model = optionalString(flags, 'model');
  const effort = optionalString(flags, 'effort');
  const timeoutMs = optionalNumber(flags, 'timeout-ms');
  const entry = optionalString(flags, 'entry');
  if (entry !== undefined && entry !== 'prompt' && entry !== 'skill') {
    throw new UsageError(`--entry takes prompt or skill; got "${entry}".`);
  }
  const estimate: UsageEstimate = {
    fiveHourPercent: optionalNumber(flags, 'estimate-five-hour') ?? 0,
    weeklyPercent: optionalNumber(flags, 'estimate-weekly') ?? 0,
    basis: parseEstimateBasis(flags),
    uncertaintyPercent: optionalNumber(flags, 'estimate-uncertainty') ?? 1,
    detail: optionalString(flags, 'estimate-detail') ?? 'no comparable history recorded',
  };

  const result = await dispatchTask({
    taskId,
    repo,
    workClass,
    runtime,
    profile,
    actions,
    prompt,
    settings: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(flag(flags, 'accept-vendor-default') ? { acceptVendorDefault: true } : {}),
    },
    estimate,
    ...(approvalId ? { approvalId } : {}),
    ...(triggerSource ? { triggerSource } : {}),
    ...(prBase ? { prBase } : {}),
    ...(targetProject ? { targetProject } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(jobId ? { jobId } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(entry ? { entry } : {}),
  });

  if (result.recovered.length > 0) {
    console.log(`Reconciled ${result.recovered.length} unsettled run(s) before dispatching.`);
    for (const recovered of result.recovered.filter((entry) => entry.blocksNewAttempt)) {
      console.log(`  ${recovered.runId}: ${recovered.outcome.summary}`);
    }
  }

  const admission = result.admission;
  if (admission !== undefined) {
    console.log(`Subscription: ${admission.subscriptionId}`);
    for (const window of admission.windows) {
      console.log(
        `  ${window.kind.padEnd(10)} used ${window.usedPercent}%  reserved ${window.reservedPercent.toFixed(1)}%  ` +
          `margin ${window.marginPercent}%  need ${window.estimatePercent.toFixed(1)}%  available ${window.availablePercent.toFixed(1)}%  ` +
          `${window.fits ? 'fits' : 'DOES NOT FIT'}` +
          `${window.undeclared ? '  [UNDECLARED — this account reports it; widen --windows]' : ''}`,
      );
    }
    console.log(`  estimate basis: ${admission.estimate.basis} — ${admission.estimate.detail}`);
  }

  console.log(`\n${render(result.outcome)}`);
  if (result.run?.skill) {
    console.log(`\nSkill evidence:`);
    console.log(`  distribution: ${result.run.skill.distributionPath} (${result.run.skill.distributionVersion})`);
    console.log(`  invocation:   ${result.run.skill.invocation}`);
    console.log(`  manifest:     ${result.run.skill.manifestPath ?? 'not reported'}`);
    console.log(`  continuation: ${result.run.skill.continuation}`);
  }
  return result.outcome.kind === 'completed' ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof UsageError || err instanceof AuthorityError ||
        err instanceof CommandInputError || err instanceof ScorecardEvidenceError || err instanceof LoopBusyError ||
        err instanceof PolicyError) {
      console.error(`${err.name}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });

export { main };
