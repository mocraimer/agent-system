import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getSuite } from './oracle.js';
import { BUILTIN_CASES, CASE_KINDS, freezeBuiltinSuite, runControls } from './replay.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

describe('the built-in suite', () => {
  it('covers every case class the contract names', () => {
    const covered = new Set(BUILTIN_CASES.map((c) => c.kind));
    for (const kind of CASE_KINDS) {
      assert.ok(covered.has(kind), `no case exercises ${kind}`);
    }
  });

  it('labels every case as fixture data rather than a real incident', () => {
    for (const c of BUILTIN_CASES) {
      assert.equal(c.isFixture, true, `${c.id} is not labelled as fixture data`);
    }
  });

  it('fixes an expectation and required checks for every case', () => {
    for (const c of BUILTIN_CASES) {
      assert.notEqual(c.expected.trim(), '', `${c.id} has no expected outcome`);
      assert.ok(c.requiredChecks.length > 0, `${c.id} requires no checks, so a zero-check run would pass it`);
    }
  });

  it('freezes to a stable version and reuses it rather than refreezing', () => {
    box = sandbox();
    const first = freezeBuiltinSuite('v1');
    const second = freezeBuiltinSuite('v1');
    assert.equal(second.oracleDigest, first.oracleDigest);
    assert.equal(second.frozenAt, first.frozenAt, 'refreezing would move the oracle under a running trial');
    assert.equal(getSuite('v1')?.oracleDigest, first.oracleDigest);
  });
});

/**
 * The controls exist to prove the scorer's refusals actually fire. A control
 * that cannot fail proves nothing, so each one is checked against the specific
 * damage it represents rather than only in aggregate.
 */
describe('the negative controls', () => {
  it('all degrade a healthy run', () => {
    box = sandbox();
    const suite = freezeBuiltinSuite('v1');
    const { baselinePassed, controls, allHeld } = runControls(suite);

    assert.equal(baselinePassed, suite.cases.length, 'the healthy baseline must pass every case');
    assert.ok(allHeld, `a control did not degrade: ${controls.filter((c) => !c.held).map((c) => c.id).join(', ')}`);
  });

  it('covers each way a run can look better than it was', () => {
    box = sandbox();
    const { controls } = runControls(freezeBuiltinSuite('v1'));
    const ids = controls.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      'corrupt-evidence', 'missing-case', 'stale-oracle',
      'weakened-checks', 'withheld-evidence', 'wrong-outcome',
    ]);
  });

  /**
   * The others cost one case each. A moved oracle is different in kind: once the
   * question changed, no answer to it is evidence about the frozen suite.
   */
  it('fails the whole trial on a moved oracle, not one case of it', () => {
    box = sandbox();
    const suite = freezeBuiltinSuite('v1');
    const { controls } = runControls(suite);
    const stale = controls.find((c) => c.id === 'stale-oracle');
    assert.ok(stale?.held);
    assert.match(stale.detail, new RegExp(`Passed 0 of ${suite.cases.length}`));
  });

  it('reports which control broke rather than only that something did', () => {
    box = sandbox();
    const { controls } = runControls(freezeBuiltinSuite('v1'));
    for (const c of controls) {
      assert.notEqual(c.description.trim(), '', `${c.id} does not say what it damages`);
      assert.notEqual(c.requires.trim(), '', `${c.id} does not say what it proves`);
      assert.match(c.detail, /Passed \d+ of \d+/);
    }
  });
});
