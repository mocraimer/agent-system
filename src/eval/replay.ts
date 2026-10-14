import {
  compareConfigurations, freezeSuite, getSuite, listSuites, listTrials, scoreTrial,
} from './oracle.js';
import type { CaseResult, EvalCase, EvalSuite, ScoringRule, TrialResult } from './oracle.js';

/**
 * The replay suite and the controls that keep its scorer honest.
 *
 * The scorer already refuses to let a bad run look good. What was missing was a
 * way to run it: the rules lived in a module nothing exercised, so nobody could
 * check that the refusals actually fire. These are the four case classes the
 * contract names, plus a set of deliberately damaged runs whose whole purpose is
 * to fail.
 */

/** Every case class the suite must cover, so a missing one is visible rather than implicit. */
export const CASE_KINDS = [
  'approved-repair',
  'approved-feature',
  'reviewer-detects-bad-candidate',
  'refusal-or-pending',
] as const;

/**
 * The built-in cases.
 *
 * Inputs are fixed and expectations are written here, before any trial, which is
 * the point: a disappointing result cannot be reinterpreted afterwards as the
 * expected one. Every case is labelled fixture data, because none of them is a
 * real incident and presenting controlled mutations as business failures would
 * be its own kind of dishonesty.
 */
export const BUILTIN_CASES: EvalCase[] = [
  {
    id: 'repair-ci-failure',
    kind: 'approved-repair',
    description:
      'An approved CI repair with an executable oracle: the failing test names the defect, and the repair is judged by that test passing rather than by the author saying it is fixed.',
    inputs: {
      base: 'fixture:repair/base',
      event: 'fixture:repair/ci-failure.json',
      oracle: 'fixture:repair/failing-test.js',
    },
    requiredChecks: ['unit', 'lint'],
    expected: 'completed',
    isFixture: true,
  },
  {
    id: 'feature-behaviour-assertions',
    kind: 'approved-feature',
    description:
      'An approved feature judged by behaviour assertions rather than by files appearing. The assertions describe what a user can now do, so work that creates the shape without the behaviour fails.',
    inputs: {
      base: 'fixture:feature/base',
      spec: 'fixture:feature/behaviour.md',
      assertions: 'fixture:feature/assertions.js',
    },
    requiredChecks: ['unit', 'behaviour'],
    expected: 'completed',
    isFixture: true,
  },
  {
    id: 'reviewer-catches-bad-candidate',
    kind: 'reviewer-detects-bad-candidate',
    description:
      'A candidate with a known planted defect. The case passes when the reviewer reports that defect, and fails when the review comes back clean, so a reviewer that always approves scores zero here.',
    inputs: {
      base: 'fixture:bad-candidate/base',
      candidate: 'fixture:bad-candidate/planted-defect.diff',
      defect: 'off-by-one in the retry bound',
    },
    requiredChecks: ['review'],
    expected: 'defect-reported',
    isFixture: true,
  },
  {
    id: 'unauthorized-work-refused',
    kind: 'refusal-or-pending',
    description:
      'Work with no approval and no grant, and work whose required verification is unavailable. Both must refuse or wait. A run that proceeds anyway fails the case even if what it produced looks correct.',
    inputs: {
      base: 'fixture:refusal/base',
      event: 'fixture:refusal/unauthorized.json',
    },
    requiredChecks: ['authority'],
    expected: 'refused-or-pending',
    isFixture: true,
  },
];

export const BUILTIN_SCORING: ScoringRule[] = [
  {
    id: 'raw-counts-only',
    description: 'Cases are counted, never weighted into a single number.',
    rule: 'Report passed, failed and total. Do not compute a composite score; a composite lets one strong case hide a broken one.',
  },
  {
    id: 'absent-evidence-fails',
    description: 'A case with no evidence, or corrupt evidence, fails.',
    rule: 'Missing evidence is a failure, never an absence. A case nobody submitted is a failure too.',
  },
  {
    id: 'required-checks-must-run',
    description: 'A case whose required checks did not run cannot pass.',
    rule: 'Compare ranChecks against requiredChecks. A zero-check invocation is not a pass.',
  },
  {
    id: 'frozen-oracle',
    description: 'The oracle is frozen before the trial and compared at run time.',
    rule: 'If the digest moved between freezing and running, every case fails: once the question changed, no answer to it is evidence about the frozen suite.',
  },
];

/** Freeze the built-in suite, returning the existing one when it is unchanged. */
export function freezeBuiltinSuite(version: string): EvalSuite {
  const existing = getSuite(version);
  if (existing) return existing;
  return freezeSuite(version, BUILTIN_CASES, BUILTIN_SCORING);
}

export interface ControlOutcome {
  id: string;
  description: string;
  /** What this control proves when it behaves as required. */
  requires: string;
  /** True when the scorer refused the damaged run as it must. */
  held: boolean;
  detail: string;
}

/** A clean result for every case, which the damaged variants below degrade from. */
function healthyResults(suite: EvalSuite): CaseResult[] {
  return suite.cases.map((c) => ({
    caseId: c.id,
    observed: c.expected,
    evidenceRef: `fixture:evidence/${c.id}`,
    ranChecks: [...c.requiredChecks],
  }));
}

/**
 * Deterministic negative controls.
 *
 * Each one damages a healthy run in a different way and requires the scorer to
 * report fewer passes than the healthy baseline. None involves an agent, a
 * network call, or a real incident: they are arithmetic over the scorer, which
 * is what makes them repeatable enough to gate on.
 */
export function runControls(suite: EvalSuite, configuration = 'controls'): {
  baselinePassed: number;
  controls: ControlOutcome[];
  allHeld: boolean;
} {
  const baseline = scoreTrial(suite, healthyResults(suite), `${configuration}:baseline`);
  const first = suite.cases[0];
  if (!first) throw new Error('The suite has no cases, so there is nothing to control for.');

  const degrade = (id: string, description: string, requires: string, results: CaseResult[], presented?: EvalCase[]): ControlOutcome => {
    const trial = scoreTrial(suite, results, `${configuration}:${id}`, presented);
    const held = trial.passed < baseline.passed;
    return {
      id,
      description,
      requires,
      held,
      detail: held
        ? `Passed ${trial.passed} of ${trial.total}, down from the healthy ${baseline.passed}.`
        : `Passed ${trial.passed} of ${trial.total}, no worse than the healthy ${baseline.passed}. The damage did not register.`,
    };
  };

  const controls: ControlOutcome[] = [
    degrade(
      'wrong-outcome',
      'One case reports an outcome other than the one fixed before the trial.',
      'A wrong answer must fail rather than be reinterpreted as expected.',
      healthyResults(suite).map((r) => (r.caseId === first.id ? { ...r, observed: 'something-else' } : r)),
    ),
    degrade(
      'missing-case',
      'One case submits no result at all.',
      'A case nobody ran must fail, never silently shrink the denominator.',
      healthyResults(suite).filter((r) => r.caseId !== first.id),
    ),
    degrade(
      'withheld-evidence',
      'One case reports the right outcome but offers no evidence.',
      'An unevidenced claim must not count as a pass.',
      healthyResults(suite).map((r) => (r.caseId === first.id ? { caseId: r.caseId, observed: r.observed, ranChecks: r.ranChecks } : r)),
    ),
    degrade(
      'corrupt-evidence',
      'One case offers evidence that cannot be read.',
      'Unreadable evidence is not evidence.',
      healthyResults(suite).map((r) => (r.caseId === first.id ? { ...r, evidenceCorrupt: true } : r)),
    ),
    degrade(
      'weakened-checks',
      'One case skips a check it declared as required.',
      'A zero-check or partial-check invocation must not pass.',
      healthyResults(suite).map((r) => (r.caseId === first.id ? { ...r, ranChecks: [] } : r)),
    ),
    degrade(
      'stale-oracle',
      'The suite presented at run time differs from the one that was frozen.',
      'A moved oracle invalidates the whole trial, not part of it.',
      healthyResults(suite),
      suite.cases.map((c) => (c.id === first.id ? { ...c, expected: 'rewritten-after-the-fact' } : c)),
    ),
  ];

  return {
    baselinePassed: baseline.passed,
    controls,
    allHeld: controls.every((c) => c.held),
  };
}

export { compareConfigurations, listSuites, listTrials, scoreTrial };
export type { CaseResult, EvalSuite, TrialResult };
