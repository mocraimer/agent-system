import type { CandidateIdentity, SettingsSnapshot } from './run.js';

/**
 * How a piece of evidence was produced.
 *
 * Kept separate rather than collapsed into pass/fail because the contract requires
 * real-provider, native, emulator/mocked and judgment results to be reported apart
 * from each other: a mocked pass and a real pass are not interchangeable, however
 * green they both look.
 */
export type EvidenceClass = 'real-provider' | 'native' | 'emulator' | 'mocked' | 'judgment';

/** Why a piece of evidence cannot satisfy the check it claims to. */
export type Disqualifier =
  | 'missing'
  | 'skipped'
  | 'failed'
  | 'stale'
  | 'superseded'
  | 'inaccessible'
  | 'configuration-mismatch'
  | 'wrong-class';

export interface EvidenceItem {
  /** The required check this claims to satisfy. */
  check: string;
  class: EvidenceClass;
  /** What the producer said happened. Not itself acceptance. */
  reportedOutcome: 'passed' | 'failed' | 'skipped' | 'errored';
  /** Candidate this ran against. Compared with the candidate under judgement. */
  candidate: CandidateIdentity;
  /** Runtime settings in force, where the check depends on them. */
  settings?: SettingsSnapshot;
  /** Version of the fixtures or oracle used, fixed before the trial. */
  fixtureVersion?: string;
  observedAt: string;
  /** Attempt number, where the producer retried. First failure is retained. */
  attempt?: number;
  /** True when the producer could not be read at all. */
  inaccessible?: boolean;
  /** Free-text source, e.g. a workflow run URL. */
  source: string;
}

/**
 * The operator has put a check's scope out of the current phase.
 *
 * A deferral is a scope decision, so it carries who made it. Nothing an agent or an
 * evaluation produces can construct one: `assertOperatorDeferrals` rejects any
 * deferral whose author is not the configured operator, which is what stops a run
 * from quietly widening its own definition of done.
 */
export interface CheckDeferral {
  reason: string;
  /** The operator who deferred it. An agent identity here is refused. */
  deferredBy: string;
  deferredAt: string;
}

/** What the approved configuration says must hold before a candidate is accepted. */
export interface RequiredCheck {
  name: string;
  /** The evidence class that can satisfy this check. A mock cannot satisfy a real one. */
  requiredClass: EvidenceClass;
  /** Fixture/oracle version this check must have run against, when it has one. */
  fixtureVersion?: string;
  /**
   * Set when the operator has deferred this check's scope. A deferred check does not
   * block acceptance and is never reported as passed — it reports as deferred, so a
   * reader sees an absence of coverage rather than a green tick or nothing at all.
   */
  deferral?: CheckDeferral;
}

export interface Verdict {
  check: string;
  satisfied: boolean;
  /**
   * The operator deferred this check's scope, so its absence does not block. Never
   * true at the same time as `satisfied`: deferred means untested, not passed.
   */
  deferred?: boolean;
  /** Present when not satisfied. */
  disqualifier?: Disqualifier;
  detail: string;
  /** The item considered, when one was found. */
  item?: EvidenceItem;
}

export interface AggregateReport {
  candidate: CandidateIdentity;
  verdicts: Verdict[];
  /** Per-class counts, so a reader cannot mistake mocked coverage for real coverage. */
  byClass: Record<EvidenceClass, { satisfied: number; required: number }>;
  /** Checks that failed at least once before later passing. */
  flaky: string[];
  /** Deferred check names, so a reader can see what the result does not cover. */
  deferred: string[];
  accepted: boolean;
  /** What was actually tested, in the reader's terms. Never implies untested scope. */
  scopeStatement: string;
}

/** A reading is too old to stand for the candidate under judgement. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface AggregateOptions {
  maxEvidenceAgeMs?: number;
  now?: number;
  /**
   * Check names this particular configuration requires despite their deferral.
   *
   * A deferral is a decision about the current phase, not about every run inside it.
   * A configuration that asks for a deferred check back gets it enforced, and the
   * missing evidence blocks exactly as it would have before the deferral.
   */
  enforceDeferred?: readonly string[];
}

/**
 * Decide whether a candidate is accepted, from the required checks and the
 * evidence offered for them.
 *
 * The whole point is that offering evidence is not the same as satisfying a check.
 * Every disqualifier below was chosen because it is a way real evidence looks green
 * while establishing nothing.
 */
export function aggregate(
  candidate: CandidateIdentity,
  required: RequiredCheck[],
  evidence: EvidenceItem[],
  options: AggregateOptions = {},
): AggregateReport {
  const now = options.now ?? Date.now();
  const maxAge = options.maxEvidenceAgeMs ?? DEFAULT_MAX_AGE_MS;

  const verdicts: Verdict[] = [];
  const flaky: string[] = [];
  const enforced = new Set(options.enforceDeferred ?? []);

  for (const req of required) {
    const forCheck = evidence.filter((e) => e.check === req.name);
    // A deferral only holds while this configuration accepts it. Asking for the
    // check back puts it straight back to blocking.
    const isDeferred = req.deferral !== undefined && !enforced.has(req.name);

    if (forCheck.length === 0) {
      if (isDeferred) {
        verdicts.push({
          check: req.name,
          satisfied: false,
          deferred: true,
          detail: `Deferred by ${req.deferral!.deferredBy} on ${req.deferral!.deferredAt}: ${req.deferral!.reason}. Not tested, not passed.`,
        });
        continue;
      }
      verdicts.push({
        check: req.name,
        satisfied: false,
        disqualifier: 'missing',
        detail: `No evidence was offered for "${req.name}". A required check absent from the report is unmet, not passed.`
          + (req.deferral ? ' This check is deferred, but this configuration requires it anyway.' : ''),
      });
      continue;
    }

    // Retries: keep the first failure visible rather than letting the last success bury it.
    const ordered = [...forCheck].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
    const anyFailed = ordered.some((e) => e.reportedOutcome === 'failed' || e.reportedOutcome === 'errored');
    const anyPassed = ordered.some((e) => e.reportedOutcome === 'passed');
    if (anyFailed && anyPassed) flaky.push(req.name);

    // Judge the newest attempt, but a superseded earlier failure still marks it flaky.
    const item = ordered[ordered.length - 1]!;
    const disqualifier = disqualify(item, req, candidate, now, maxAge, ordered.length > 1);
    if (disqualifier) {
      verdicts.push({ check: req.name, satisfied: false, disqualifier: disqualifier.kind, detail: disqualifier.detail, item });
    } else {
      verdicts.push({
        check: req.name,
        satisfied: true,
        detail: `${req.requiredClass} evidence from ${item.source}`,
        item,
      });
    }
  }

  const byClass = countByClass(required, verdicts);
  const deferred = verdicts.filter((v) => v.deferred).map((v) => v.check);
  // A deferred check does not block. Everything else must actually be satisfied,
  // so a failed or missing web/backend check still fails the whole report.
  const accepted = verdicts.every((v) => v.satisfied || v.deferred);

  return {
    candidate,
    verdicts,
    byClass,
    flaky,
    deferred,
    accepted,
    scopeStatement: describeScope(candidate, byClass, accepted, deferred),
  };
}

function disqualify(
  item: EvidenceItem,
  req: RequiredCheck,
  candidate: CandidateIdentity,
  now: number,
  maxAge: number,
  hadEarlierAttempts: boolean,
): { kind: Disqualifier; detail: string } | undefined {
  if (item.inaccessible) {
    return { kind: 'inaccessible', detail: `Evidence at ${item.source} could not be read; unreadable evidence is not a pass.` };
  }
  if (item.reportedOutcome === 'skipped') {
    return { kind: 'skipped', detail: `"${req.name}" was skipped. A skipped check has not run.` };
  }
  if (item.reportedOutcome === 'failed' || item.reportedOutcome === 'errored') {
    return { kind: 'failed', detail: `"${req.name}" reported ${item.reportedOutcome}.` };
  }
  if (item.class !== req.requiredClass) {
    return {
      kind: 'wrong-class',
      detail: `"${req.name}" requires ${req.requiredClass} evidence but was offered ${item.class}. ${item.class === 'mocked' ? 'A mock cannot stand in for a real call.' : 'The classes are not interchangeable.'}`,
    };
  }
  if (item.candidate.head !== candidate.head) {
    return {
      kind: 'superseded',
      detail: `Evidence ran against head ${item.candidate.head.slice(0, 7)}, but the candidate is ${candidate.head.slice(0, 7)}. ${hadEarlierAttempts ? 'A later attempt on a different candidate does not retroactively cover this one.' : ''}`.trim(),
    };
  }
  if (item.candidate.repo !== candidate.repo || item.candidate.base !== candidate.base) {
    return {
      kind: 'configuration-mismatch',
      detail: `Evidence is for ${item.candidate.repo}@${item.candidate.base}, the candidate is ${candidate.repo}@${candidate.base}.`,
    };
  }
  if (req.fixtureVersion !== undefined && item.fixtureVersion !== req.fixtureVersion) {
    return {
      kind: 'configuration-mismatch',
      detail: `"${req.name}" requires fixture version ${req.fixtureVersion}; the evidence used ${item.fixtureVersion ?? 'none'}.`,
    };
  }
  if (backendMismatch(item.candidate, candidate)) {
    return {
      kind: 'configuration-mismatch',
      detail: 'The deployed backend revisions the evidence ran against differ from the candidate\'s. A matching frontend SHA is not sufficient backend identity.',
    };
  }
  if (now - Date.parse(item.observedAt) > maxAge) {
    return {
      kind: 'stale',
      detail: `Evidence is older than the acceptable window for "${req.name}".`,
    };
  }
  return undefined;
}

function backendMismatch(a: CandidateIdentity, b: CandidateIdentity): boolean {
  const want = b.backendRevisions;
  if (!want || Object.keys(want).length === 0) return false;
  const got = a.backendRevisions ?? {};
  return Object.entries(want).some(([k, v]) => got[k] !== v);
}

function countByClass(
  required: RequiredCheck[],
  verdicts: Verdict[],
): AggregateReport['byClass'] {
  const empty = (): { satisfied: number; required: number } => ({ satisfied: 0, required: 0 });
  const out: AggregateReport['byClass'] = {
    'real-provider': empty(), native: empty(), emulator: empty(), mocked: empty(), judgment: empty(),
  };
  for (const req of required) {
    const v = verdicts.find((x) => x.check === req.name);
    // A deferred check is out of scope for this phase, so counting it as required
    // would report coverage the phase never claimed. It appears in `deferred`.
    if (v?.deferred) continue;
    out[req.requiredClass].required++;
    if (v?.satisfied) out[req.requiredClass].satisfied++;
  }
  return out;
}

/**
 * State what was tested, in terms a reader cannot over-read.
 *
 * Names the candidate and the classes actually covered. It never says "ready" in a
 * way that could be taken to mean untested platforms or a production deployment.
 */
function describeScope(
  candidate: CandidateIdentity,
  byClass: AggregateReport['byClass'],
  accepted: boolean,
  deferred: readonly string[],
): string {
  const covered = Object.entries(byClass)
    .filter(([, c]) => c.required > 0)
    .map(([k, c]) => `${k} ${c.satisfied}/${c.required}`)
    .join(', ');
  const head = candidate.head.slice(0, 7);
  // Deferred scope is named in the same breath as the result. A reader who sees
  // only "satisfied every required check" would otherwise read coverage the phase
  // never had, which is the failure this sentence exists to prevent.
  const notCovered = deferred.length > 0
    ? ` Deferred and therefore untested, not passed: ${deferred.join(', ')}.`
    : '';
  return (accepted
    ? `Candidate ${candidate.repo}@${head} satisfied every required check for the tested scope (${covered}). This covers only those checks on this candidate; it says nothing about untested platforms and does not mean the change is deployed.`
    : `Candidate ${candidate.repo}@${head} did not satisfy every required check (${covered}).`) + notCovered;
}

/**
 * Refuse deferrals that did not come from the operator.
 *
 * A deferral removes a check from what blocks acceptance, so it is an authority
 * decision wearing configuration's clothes. Without this, anything that can write
 * the check list — an agent's proposed configuration, an evaluation result — could
 * retire the checks it was about to fail. The operator identity is compared against
 * the configured one rather than merely being present.
 */
export function assertOperatorDeferrals(required: readonly RequiredCheck[], operatorId: string): void {
  for (const req of required) {
    if (!req.deferral) continue;
    if (req.deferral.deferredBy !== operatorId) {
      throw new Error(
        `"${req.name}" is deferred by ${req.deferral.deferredBy}, who is not the configured operator `
        + `(${operatorId}). A check can only be deferred by the operator; agent output and evaluation `
        + 'results cannot retire a required check.',
      );
    }
  }
}
