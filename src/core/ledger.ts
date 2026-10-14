import { join } from 'node:path';
import type { Outcome } from './outcome.js';
import { listRecords, newId, readJson, readRecord, stateRoot, withLock, writeJson } from './store.js';

/**
 * The paid provider-call ledger.
 *
 * Deliberately a separate ledger from subscription admission: one counts dollars
 * billed per call, the other counts percent of an account allowance. Mixing them
 * would let a healthy subscription percentage look like room for a paid call, or
 * a dollar figure look like subscription headroom. Neither is true.
 */
export interface LedgerPolicy {
  /** Total paid spend this bootstrap may reach, in USD. */
  allowanceUsd: number;
  /** Set when the operator has explicitly changed it, for the audit trail. */
  setBy?: string;
  setAt?: string;
}

export const BOOTSTRAP_ALLOWANCE_USD = 10;

/**
 * Money, printed at the precision it actually has.
 *
 * Two decimals is the wrong default for this ledger. A real translation call came
 * back at $0.0018, which `toFixed(2)` renders as `$0.00` and a remaining balance of
 * `$10.00` — spend that happened, reported as spend that did not. Over many small
 * calls the allowance would drain while the display insisted nothing had been used.
 * Whole-cent amounts still print as two decimals, because most do.
 */
export function formatUsd(usd: number): string {
  const cents = usd * 100;
  const wholeCents = Math.abs(Math.round(cents * 1e6) / 1e6 - Math.round(cents)) < 1e-9;
  return `$${usd.toFixed(wholeCents ? 2 : 4)}`;
}

export interface CallReservation {
  id: string;
  taskId: string;
  runId: string;
  /** Provider and operation, e.g. `openai:embeddings`. */
  operation: string;
  /** Conservative upper bound reserved before the call. */
  boundUsd: number;
  /** How the bound was derived. A call with no defensible bound is refused. */
  boundBasis: string;
  createdAt: string;
  state: 'reserved' | 'settled' | 'released';
  /** Reconciled actual cost, when the provider reports one. */
  actualUsd?: number;
  /** Set when the provider exposes no usable actual figure. */
  actualUnknown?: boolean;
  settledAt?: string;
}

const ledgerDir = (): string => join(stateRoot(), 'paid-calls');
const policyPath = (): string => join(stateRoot(), 'paid-call-policy.json');

export function getLedgerPolicy(): LedgerPolicy {
  return readJson<LedgerPolicy>(policyPath()) ?? { allowanceUsd: BOOTSTRAP_ALLOWANCE_USD };
}

/** Only an operator path reaches this; the CLI gates it with assertOperator. */
export function setLedgerPolicy(policy: LedgerPolicy): void {
  writeJson(policyPath(), policy);
}

export function listCalls(): CallReservation[] {
  return listRecords<CallReservation>('paid-call', ledgerDir());
}

/**
 * Committed spend: settled actuals where known, otherwise the reserved bound.
 *
 * An unknown actual keeps charging its bound rather than dropping to zero — a
 * provider that reports nothing must not become free.
 */
export function committedUsd(): number {
  return listCalls().reduce((sum, c) => {
    if (c.state === 'released') return sum;
    if (c.state === 'settled') return sum + (c.actualUsd ?? c.boundUsd);
    return sum + c.boundUsd;
  }, 0);
}

export function remainingUsd(): number {
  return getLedgerPolicy().allowanceUsd - committedUsd();
}

export interface CallRequest {
  taskId: string;
  runId: string;
  operation: string;
  /** Conservative upper bound. Must be > 0 and defensible. */
  boundUsd: number;
  boundBasis: string;
}

export type CallDecision =
  | { allowed: true; reservation: CallReservation; remainingUsd: number }
  | { allowed: false; outcome: Outcome };

/** Reserve budget for one paid call, or refuse with a reason the operator can act on. */
export function reserveCall(req: CallRequest): CallDecision {
  return withLock('paid-call-ledger', () => {
    if (!(req.boundUsd > 0) || !Number.isFinite(req.boundUsd) || req.boundBasis.trim() === '') {
      return {
        allowed: false as const,
        outcome: {
          kind: 'refused' as const,
          taskId: req.taskId,
          runId: req.runId,
          summary: `No defensible cost bound for ${req.operation}.`,
          nextAction:
            'Supply a positive upper bound and how it was derived (provider pricing times a bounded quantity: tokens, minutes, requests), then retry.',
        },
      };
    }

    const policy = getLedgerPolicy();
    const committed = committedUsd();
    const remaining = policy.allowanceUsd - committed;

    if (req.boundUsd > remaining) {
      return {
        allowed: false as const,
        outcome: {
          kind: 'refused' as const,
          taskId: req.taskId,
          runId: req.runId,
          summary: `${req.operation} would reserve ${formatUsd(req.boundUsd)}, leaving only ${formatUsd(remaining)} of the ${formatUsd(policy.allowanceUsd)} paid-call allowance.`,
          nextAction:
            'Reduce the call (smaller input, fewer retries), or have the operator raise the allowance explicitly with `agentsys ledger --set-allowance`. The system never raises it on its own.',
          details: { committedUsd: committed, remainingUsd: remaining },
        },
      };
    }

    const reservation: CallReservation = {
      id: newId('call'),
      taskId: req.taskId,
      runId: req.runId,
      operation: req.operation,
      boundUsd: req.boundUsd,
      boundBasis: req.boundBasis,
      createdAt: new Date().toISOString(),
      state: 'reserved',
    };
    writeJson(join(ledgerDir(), `${reservation.id}.json`), reservation);
    return {
      allowed: true as const,
      reservation,
      remainingUsd: remaining - req.boundUsd,
    };
  });
}

/**
 * Reconcile a call against what it actually cost.
 *
 * `actualUsd` of `undefined` records the cost as unknown rather than zero, and the
 * bound keeps being charged. Retries settle as their own reservations, so a
 * retried call consumes the allowance twice — which is the point.
 */
export function settleCall(id: string, actualUsd?: number): CallReservation | undefined {
  return withLock('paid-call-ledger', () => {
    const path = join(ledgerDir(), `${id}.json`);
    const c = readRecord<CallReservation>('paid-call', path);
    if (!c) return undefined;
    // The two fields are exclusive. Spreading one over a record that already holds
    // the other left `actualUsd` in place beside `actualUnknown`, and `committedUsd`
    // prefers `actualUsd` — so correcting a figure to "unknown" went on charging the
    // superseded number instead of the bound.
    const { actualUsd: _prior, actualUnknown: _priorUnknown, ...rest } = c;
    const next: CallReservation = {
      ...rest,
      state: 'settled',
      settledAt: new Date().toISOString(),
      ...(actualUsd === undefined ? { actualUnknown: true } : { actualUsd }),
    };
    writeJson(path, next);
    return next;
  });
}

/** Release a reservation for a call that never happened. */
export function releaseCall(id: string): CallReservation | undefined {
  return withLock('paid-call-ledger', () => {
    const path = join(ledgerDir(), `${id}.json`);
    const c = readRecord<CallReservation>('paid-call', path);
    if (!c || c.state === 'settled') return c;
    const next: CallReservation = { ...c, state: 'released', settledAt: new Date().toISOString() };
    writeJson(path, next);
    return next;
  });
}
