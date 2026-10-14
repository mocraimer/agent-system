import { join } from 'node:path';
import { digest, listJson, listRecords, readJson, readRecord, stateRoot, withLock, writeJson } from '../core/store.js';

/**
 * One evaluation case, with the expectation fixed before the trial.
 *
 * `expected` is written down in advance precisely so that a disappointing result
 * cannot be reinterpreted afterwards as the expected one.
 */
export interface EvalCase {
  id: string;
  /** Which of the four classes this exercises. */
  kind: 'approved-repair' | 'approved-feature' | 'reviewer-detects-bad-candidate' | 'refusal-or-pending';
  description: string;
  /** Fixed inputs: base ref, fixture ids, event payloads. */
  inputs: Record<string, string>;
  /** Checks that must run for this case to count. */
  requiredChecks: string[];
  /** The outcome recorded before the trial. */
  expected: string;
  /** True when the inputs are deliberately mutated test data, not a real incident. */
  isFixture: boolean;
}

export interface ScoringRule {
  id: string;
  description: string;
  /** How a case contributes. Recorded so a later change is visible. */
  rule: string;
}

/** A whole suite, versioned by the digest of its own content. */
export interface EvalSuite {
  version: string;
  cases: EvalCase[];
  scoring: ScoringRule[];
  /** Digest over cases + scoring, computed when the suite is frozen. */
  oracleDigest: string;
  frozenAt: string;
}

const suitesDir = (): string => join(stateRoot(), 'eval-suites');
const trialsDir = (): string => join(stateRoot(), 'eval-trials');

/** Compute the digest that identifies a suite's oracle. */
export function oracleDigestOf(cases: EvalCase[], scoring: ScoringRule[]): string {
  return digest({
    cases: [...cases].sort((a, b) => a.id.localeCompare(b.id)),
    scoring: [...scoring].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export class OracleError extends Error {
  override readonly name = 'OracleError';
}

/**
 * Freeze a suite.
 *
 * Freezing is what makes "the expectation was fixed before the trial" checkable
 * rather than asserted. Re-freezing the same version with different content is
 * refused: that is the move a candidate would make to pass under an old label.
 */
export function freezeSuite(version: string, cases: EvalCase[], scoring: ScoringRule[]): EvalSuite {
  return withLock(`eval-suite-${version}`, () => {
    const path = join(suitesDir(), `${version}.json`);
    const oracleDigest = oracleDigestOf(cases, scoring);
    const existing = readJson<EvalSuite>(path);
    if (existing && existing.oracleDigest !== oracleDigest) {
      throw new OracleError(
        `Suite version "${version}" is already frozen with a different oracle (${existing.oracleDigest} vs ${oracleDigest}). ` +
          'Publish a new version instead of redefining a frozen one.',
      );
    }
    if (existing) return existing;
    const suite: EvalSuite = {
      version, cases, scoring, oracleDigest, frozenAt: new Date().toISOString(),
    };
    writeJson(path, suite);
    return suite;
  });
}

export function getSuite(version: string): EvalSuite | undefined {
  return readRecord<EvalSuite>('eval-suite', join(suitesDir(), `${version}.json`));
}
export function listSuites(): EvalSuite[] {
  return listRecords<EvalSuite>('eval-suite', suitesDir());
}

export interface CaseResult {
  caseId: string;
  /** What actually happened. */
  observed: string;
  /** Evidence backing the observation. Absent or corrupt evidence fails the case. */
  evidenceRef?: string;
  evidenceCorrupt?: boolean;
  /** Checks that actually ran for this case. */
  ranChecks: string[];
}

export interface TrialResult {
  suiteVersion: string;
  /** The oracle the trial ran against, compared with the frozen one. */
  oracleDigestAtRun: string;
  /** Configuration the trial exercised, so like can be compared with like. */
  configuration: string;
  caseVerdicts: Array<{
    caseId: string;
    passed: boolean;
    reason: string;
  }>;
  /** Raw counts. Deliberately not a composite score. */
  passed: number;
  failed: number;
  total: number;
  /** Set when the oracle moved between freezing and running. */
  oracleTampered?: boolean;
  ranAt: string;
}

/**
 * Score a trial against its frozen suite.
 *
 * Every failure mode below is a way a run could look better than it was: a moved
 * oracle, a case quietly dropped, a check that did not run, evidence that was
 * withheld or corrupted. None of them can improve a result.
 */
export function scoreTrial(
  suite: EvalSuite,
  results: CaseResult[],
  configuration: string,
  presentedCases?: EvalCase[],
): TrialResult {
  const digestAtRun = presentedCases
    ? oracleDigestOf(presentedCases, suite.scoring)
    : suite.oracleDigest;
  const tampered = digestAtRun !== suite.oracleDigest;

  const verdicts = suite.cases.map((c) => {
    const r = results.find((x) => x.caseId === c.id);
    if (!r) {
      return { caseId: c.id, passed: false, reason: 'No result was submitted for this case. A missing case is a failure, not an absence.' };
    }
    if (r.evidenceCorrupt) {
      return { caseId: c.id, passed: false, reason: 'The evidence for this case was corrupt.' };
    }
    if (!r.evidenceRef) {
      return { caseId: c.id, passed: false, reason: 'No evidence was offered for this case.' };
    }
    const missingChecks = c.requiredChecks.filter((k) => !r.ranChecks.includes(k));
    if (missingChecks.length > 0) {
      return { caseId: c.id, passed: false, reason: `Required check(s) did not run: ${missingChecks.join(', ')}.` };
    }
    if (r.observed !== c.expected) {
      return { caseId: c.id, passed: false, reason: `Expected "${c.expected}", observed "${r.observed}".` };
    }
    return { caseId: c.id, passed: true, reason: 'Matched the expectation fixed before the trial.' };
  });

  const trial: TrialResult = {
    suiteVersion: suite.version,
    oracleDigestAtRun: digestAtRun,
    configuration,
    caseVerdicts: tampered
      // A moved oracle invalidates the whole trial rather than some of it: once the
      // question changed, no answer to it is evidence about the frozen suite.
      ? verdicts.map((v) => ({ ...v, passed: false, reason: `Oracle changed since freezing; ${v.reason}` }))
      : verdicts,
    passed: 0, failed: 0, total: suite.cases.length,
    ...(tampered ? { oracleTampered: true } : {}),
    ranAt: new Date().toISOString(),
  };
  trial.passed = trial.caseVerdicts.filter((v) => v.passed).length;
  trial.failed = trial.total - trial.passed;
  writeJson(join(trialsDir(), `${suite.version}-${configuration.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`), trial);
  return trial;
}

export function listTrials(): TrialResult[] {
  return listJson<TrialResult>(trialsDir());
}

/**
 * One case's outcome under two configurations.
 *
 * `undefined` means that configuration did not run the case — distinct from
 * running it and failing, which is why this is not a boolean.
 */
export interface CaseComparison {
  caseId: string;
  a: boolean | undefined;
  b: boolean | undefined;
}

/** Compare matching cases across two configurations, showing raw outcomes. */
export function compareConfigurations(
  trials: TrialResult[],
  a: string,
  b: string,
): CaseComparison[] {
  const pick = (cfg: string): TrialResult | undefined =>
    trials.filter((t) => t.configuration === cfg).sort((x, y) => Date.parse(y.ranAt) - Date.parse(x.ranAt))[0];
  const ta = pick(a);
  const tb = pick(b);
  const ids = new Set([...(ta?.caseVerdicts ?? []), ...(tb?.caseVerdicts ?? [])].map((v) => v.caseId));
  return [...ids].sort().map((caseId) => ({
    caseId,
    a: ta?.caseVerdicts.find((v) => v.caseId === caseId)?.passed,
    b: tb?.caseVerdicts.find((v) => v.caseId === caseId)?.passed,
  }));
}
