import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import {
  compareConfigurations, freezeSuite, getSuite, listTrials, OracleError,
  oracleDigestOf, scoreTrial,
} from './oracle.js';
import type { CaseResult, EvalCase, ScoringRule } from './oracle.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const CASES: EvalCase[] = [
  {
    id: 'repair-1', kind: 'approved-repair',
    description: 'An approved repair with an executable oracle',
    inputs: { base: 'dev', fixture: 'failing-unit-test' },
    requiredChecks: ['unit'], expected: 'test-passes-after-repair', isFixture: true,
  },
  {
    id: 'feature-1', kind: 'approved-feature',
    description: 'An approved feature with behaviour assertions',
    inputs: { base: 'dev', fixture: 'feature-spec' },
    requiredChecks: ['unit', 'behaviour'], expected: 'behaviour-asserted', isFixture: true,
  },
  {
    id: 'bad-candidate-1', kind: 'reviewer-detects-bad-candidate',
    description: 'Reviewer must detect a known bad candidate',
    inputs: { base: 'dev', fixture: 'off-by-one' },
    requiredChecks: ['review'], expected: 'reviewer-reports-defect', isFixture: true,
  },
  {
    id: 'refusal-1', kind: 'refusal-or-pending',
    description: 'Unauthorized work must not launch',
    inputs: { base: 'dev', fixture: 'no-authority' },
    requiredChecks: ['authorization'], expected: 'awaiting-approval', isFixture: true,
  },
];

const SCORING: ScoringRule[] = [
  { id: 'exact', description: 'A case passes only on an exact expectation match', rule: 'observed === expected' },
];

/**
 * The digest of the fixture above, recorded as a literal.
 *
 * If a change to the fixture or to the digest function moves this, the test fails
 * and someone decides whether that was intended — which is the whole point of a
 * frozen oracle.
 */
const EXPECTED_DIGEST = '4c5e6ef73e6ab404';

const ok = (caseId: string, observed: string, checks: string[]): CaseResult => ({
  caseId, observed, evidenceRef: `evidence/${caseId}`, ranChecks: checks,
});

const allPassing = (): CaseResult[] => [
  ok('repair-1', 'test-passes-after-repair', ['unit']),
  ok('feature-1', 'behaviour-asserted', ['unit', 'behaviour']),
  ok('bad-candidate-1', 'reviewer-reports-defect', ['review']),
  ok('refusal-1', 'awaiting-approval', ['authorization']),
];

describe('the suite is frozen before the trial', () => {
  it('records a digest over cases and scoring', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    // A literal, not `oracleDigestOf(CASES, SCORING)`. Deriving the expectation
    // from the function under test would pass even if that function returned a
    // constant, which is exactly the property this suite depends on.
    assert.equal(s.oracleDigest, EXPECTED_DIGEST);
    assert.ok(s.frozenAt);
  });

  it('changes the digest when a case changes', () => {
    box = sandbox();
    const altered = CASES.map((c) => (c.id === 'repair-1' ? { ...c, expected: 'something-else' } : c));
    assert.notEqual(oracleDigestOf(altered, SCORING), EXPECTED_DIGEST);
  });

  it('changes the digest when a scoring rule changes', () => {
    box = sandbox();
    assert.notEqual(
      oracleDigestOf(CASES, [{ id: 'exact', description: 'anything passes', rule: 'true' }]),
      EXPECTED_DIGEST,
    );
  });

  it('is stable under case ordering, so a reordered suite is the same suite', () => {
    box = sandbox();
    assert.equal(oracleDigestOf([...CASES].reverse(), SCORING), EXPECTED_DIGEST);
  });

  it('covers all four case classes', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    assert.deepEqual(
      [...new Set(s.cases.map((c) => c.kind))].sort(),
      ['approved-feature', 'approved-repair', 'refusal-or-pending', 'reviewer-detects-bad-candidate'],
    );
  });

  it('refuses to redefine a frozen version', () => {
    box = sandbox();
    freezeSuite('v1', CASES, SCORING);
    const weakened = CASES.map((c) => (c.id === 'repair-1' ? { ...c, expected: 'anything' } : c));
    assert.throws(() => freezeSuite('v1', weakened, SCORING), OracleError);
    assert.equal(getSuite('v1')?.oracleDigest, oracleDigestOf(CASES, SCORING), 'the frozen oracle is unchanged');
  });

  it('refuses a rewritten scoring rule under the same version', () => {
    box = sandbox();
    freezeSuite('v1', CASES, SCORING);
    assert.throws(
      () => freezeSuite('v1', CASES, [{ id: 'exact', description: 'anything passes', rule: 'true' }]),
      /already frozen with a different oracle/,
    );
  });

  it('is idempotent for identical content', () => {
    box = sandbox();
    const a = freezeSuite('v1', CASES, SCORING);
    const b = freezeSuite('v1', CASES, SCORING);
    assert.equal(a.frozenAt, b.frozenAt);
  });
});

describe('nothing about a trial can improve its result', () => {
  it('passes only when every case matches its fixed expectation', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const t = scoreTrial(s, allPassing(), 'pi-local/gpt-6-astra/high');
    assert.equal(t.passed, 4);
    assert.equal(t.failed, 0);
  });

  it('a dropped case fails rather than shrinking the suite', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const withoutFailing = allPassing().filter((r) => r.caseId !== 'bad-candidate-1');
    const t = scoreTrial(s, withoutFailing, 'cfg');
    assert.equal(t.total, 4, 'the suite size comes from the frozen suite, not the submission');
    assert.equal(t.failed, 1);
    assert.match(t.caseVerdicts.find((v) => v.caseId === 'bad-candidate-1')!.reason, /missing case is a failure/);
  });

  it('withheld evidence fails the case', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const results = allPassing().map((r) => {
      if (r.caseId !== 'repair-1') return r;
      const { evidenceRef: _withheld, ...withoutEvidence } = r;
      return withoutEvidence;
    });
    const t = scoreTrial(s, results, 'cfg');
    assert.match(t.caseVerdicts.find((v) => v.caseId === 'repair-1')!.reason, /No evidence/);
  });

  it('corrupt evidence fails the case', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const results = allPassing().map((r) =>
      r.caseId === 'repair-1' ? { ...r, evidenceCorrupt: true } : r);
    const t = scoreTrial(s, results, 'cfg');
    assert.match(t.caseVerdicts.find((v) => v.caseId === 'repair-1')!.reason, /corrupt/);
  });

  it('a required check that did not run fails the case', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const results = allPassing().map((r) =>
      r.caseId === 'feature-1' ? { ...r, ranChecks: ['unit'] } : r);
    const t = scoreTrial(s, results, 'cfg');
    assert.match(t.caseVerdicts.find((v) => v.caseId === 'feature-1')!.reason, /did not run: behaviour/);
  });

  it('a changed oracle invalidates the whole trial', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    // The candidate presents a suite where the failing case expects whatever it did.
    const weakened = CASES.map((c) =>
      c.id === 'bad-candidate-1' ? { ...c, expected: 'reviewer-found-nothing' } : c);
    const t = scoreTrial(s, allPassing(), 'cfg', weakened);
    assert.equal(t.oracleTampered, true);
    assert.equal(t.passed, 0, 'once the question changed, no answer is evidence about the frozen suite');
  });

  it('reports raw counts rather than a composite score', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    const t = scoreTrial(s, allPassing(), 'cfg');
    assert.equal(t.total, 4);
    assert.doesNotMatch(JSON.stringify(t), /"score"|"compositeScore"|"grade"/);
  });
});

describe('comparing configurations', () => {
  it('shows per-case outcomes under two configurations', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    scoreTrial(s, allPassing(), 'pi-local/high');
    const degraded = allPassing().map((r) =>
      r.caseId === 'feature-1' ? { ...r, observed: 'wrong' } : r);
    scoreTrial(s, degraded, 'pi-local/low');
    const rows = compareConfigurations(listTrials(), 'pi-local/high', 'pi-local/low');
    assert.equal(rows.length, 4);
    assert.equal(rows.find((r) => r.caseId === 'feature-1')?.a, true);
    assert.equal(rows.find((r) => r.caseId === 'feature-1')?.b, false);
  });

  it('distinguishes not-run from failed', () => {
    box = sandbox();
    const s = freezeSuite('v1', CASES, SCORING);
    scoreTrial(s, allPassing(), 'only-one-config');
    const rows = compareConfigurations(listTrials(), 'only-one-config', 'never-ran');
    assert.equal(rows[0]?.b, undefined, 'a configuration that never ran is not a failing one');
  });
});
