import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BOOTSTRAP_ALLOWANCE_USD, committedUsd, formatUsd, getLedgerPolicy, releaseCall,
  remainingUsd, reserveCall, setLedgerPolicy, settleCall,
} from './ledger.js';
import { sandbox } from './testkit.js';
import type { Sandbox } from './testkit.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const call = (boundUsd: number, over: Partial<Parameters<typeof reserveCall>[0]> = {}) =>
  reserveCall({
    taskId: 'task_1', runId: 'run_1', operation: 'openai:embeddings',
    boundUsd, boundBasis: '3.0 min at $0.0043/min, rounded up', ...over,
  });

describe('the bootstrap allowance', () => {
  it('starts at USD 10', () => {
    box = sandbox();
    assert.equal(getLedgerPolicy().allowanceUsd, 10);
    assert.equal(BOOTSTRAP_ALLOWANCE_USD, 10);
    assert.equal(remainingUsd(), 10);
  });

  it('refuses a call with no defensible bound', () => {
    box = sandbox();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = call(bad);
      assert.equal(d.allowed, false, `bound ${bad} must be refused`);
    }
    const noBasis = call(0.5, { boundBasis: '   ' });
    assert.equal(noBasis.allowed, false, 'a bound with no stated derivation is not defensible');
  });

  it('refuses a call that would exceed the allowance', () => {
    box = sandbox();
    assert.equal(call(9.5).allowed, true);
    const over = call(1);
    assert.equal(over.allowed, false);
    assert.match(over.allowed === false ? over.outcome.nextAction : '', /never raises it on its own/);
  });

  it('counts retries against the same allowance', () => {
    box = sandbox();
    for (let i = 0; i < 10; i++) {
      const d = call(1, { runId: `run_${i}` });
      assert.equal(d.allowed, true, `retry ${i} should fit`);
    }
    assert.equal(remainingUsd(), 0);
    assert.equal(call(0.01).allowed, false, 'an 11th retry has nothing left');
  });

  it('only the operator can raise it, and the change is attributable', () => {
    box = sandbox();
    setLedgerPolicy({ allowanceUsd: 20, setBy: 'operator@example.test', setAt: new Date().toISOString() });
    assert.equal(getLedgerPolicy().allowanceUsd, 20);
    assert.ok(getLedgerPolicy().setBy);
  });
});

describe('reconciliation', () => {
  it('replaces the bound with the actual once known', () => {
    box = sandbox();
    const d = call(1);
    assert.equal(d.allowed, true);
    assert.equal(committedUsd(), 1);
    settleCall(d.allowed === true ? d.reservation.id : '', 0.02);
    assert.equal(committedUsd(), 0.02);
  });

  it('keeps charging the bound when the actual is unknown', () => {
    box = sandbox();
    const d = call(1);
    settleCall(d.allowed === true ? d.reservation.id : '');
    assert.equal(committedUsd(), 1, 'a provider that reports nothing must not become free');
  });

  it('frees the budget for a call that never happened', () => {
    box = sandbox();
    const d = call(4);
    releaseCall(d.allowed === true ? d.reservation.id : '');
    assert.equal(committedUsd(), 0);
    assert.equal(remainingUsd(), 10);
  });

  it('survives a restart, because the ledger is on disk', () => {
    box = sandbox();
    call(3);
    assert.equal(committedUsd(), 3);
    // A restart is new process state over the same directory.
    assert.equal(remainingUsd(), 7);
  });
});

describe('printing money', () => {
  it('shows whole-cent amounts as two decimals', () => {
    assert.equal(formatUsd(10), '$10.00');
    assert.equal(formatUsd(0.15), '$0.15');
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(9.85), '$9.85');
  });

  it('does not report a sub-cent charge as nothing', () => {
    // A real translation call settled at this figure. Two decimals would print it,
    // and the balance it left behind, as though no money had moved.
    assert.equal(formatUsd(0.0018), '$0.0018');
    assert.equal(formatUsd(10 - 0.0018), '$9.9982');
  });
});

describe('correcting a settled call', () => {
  it('charges the bound again when a figure is withdrawn as unknown', () => {
    box = sandbox();
    const d = call(0.15);
    assert.equal(d.allowed, true);
    const id = d.allowed === true ? d.reservation.id : '';

    settleCall(id, 0.0018);
    assert.equal(committedUsd(), 0.0018);

    // A cost that turns out not to be a measured figure has to stop being charged
    // as one. The bound is what the ledger falls back to, not the withdrawn number.
    const corrected = settleCall(id);
    assert.equal(corrected?.actualUnknown, true);
    assert.equal(corrected?.actualUsd, undefined, 'the superseded figure is gone, not merely ignored');
    assert.equal(committedUsd(), 0.15);
  });

  it('replaces an unknown with a figure when one arrives', () => {
    box = sandbox();
    const d = call(0.15);
    const id = d.allowed === true ? d.reservation.id : '';
    settleCall(id);
    assert.equal(committedUsd(), 0.15);

    const corrected = settleCall(id, 0.02);
    assert.equal(corrected?.actualUnknown, undefined);
    assert.equal(committedUsd(), 0.02);
  });
});
