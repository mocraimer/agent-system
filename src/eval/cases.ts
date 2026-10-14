import { createHash } from 'node:crypto';
import type { EvalCase, EvalSuite } from './oracle.js';
import { freezeSuite, listSuites, OracleError } from './oracle.js';
import { BUILTIN_SCORING } from './replay.js';

/**
 * Turning an incident into a case.
 *
 * A review that missed something, a fix that went wrong, a fault: the operator
 * names what should have happened, before any trial, and the incident's inputs
 * are pinned so the case can be run again against another prompt or tier. Each
 * case goes into a new suite version — a frozen version is never changed — so a
 * trial always names the exact oracle it was scored against.
 */

/** What a case of each kind can observe, the expected one first. */
export const OUTCOMES: Record<EvalCase['kind'], readonly string[]> = {
  'reviewer-detects-bad-candidate': ['defect-reported', 'defect-missed'],
  'approved-repair': ['completed', 'not-completed'],
  'approved-feature': ['completed', 'not-completed'],
  'refusal-or-pending': ['refused-or-pending', 'proceeded'],
};

const REQUIRED_CHECKS: Record<EvalCase['kind'], string[]> = {
  'reviewer-detects-bad-candidate': ['review'],
  'approved-repair': ['unit'],
  'approved-feature': ['unit', 'behaviour'],
  'refusal-or-pending': ['authority'],
};

export const INCIDENT_SUITE = /^incidents-(\d+)$/;

export interface IncidentCaseInput {
  kind: EvalCase['kind'];
  /** One of `OUTCOMES[kind]`: what should happen, stated before any trial. */
  expected: string;
  /** The expectation in the operator's own words. */
  words: string;
  /** `PR #120`, `#118`: what the incident was about. */
  subject: string;
  /** The incident's pinned inputs: head, base, issue body hash, prompt digest, tier, review marker. */
  pins: Record<string, string>;
  /** Who froze it. */
  by: string;
}

export class CaseError extends Error {
  override readonly name = 'CaseError';
}

export function latestIncidentSuite(): EvalSuite | undefined {
  return listSuites()
    .filter((s) => INCIDENT_SUITE.test(s.version))
    .sort((a, b) => Number(INCIDENT_SUITE.exec(b.version)![1]) - Number(INCIDENT_SUITE.exec(a.version)![1]))[0];
}

/** Write the case into the next incident suite version and freeze it. */
export function freezeIncidentCase(input: IncidentCaseInput): { suite: EvalSuite; caseId: string } {
  if (!OUTCOMES[input.kind]) throw new CaseError(`"${input.kind}" is not one of the oracle's case kinds.`);
  if (!OUTCOMES[input.kind].includes(input.expected)) {
    throw new CaseError(`A ${input.kind} case expects one of ${OUTCOMES[input.kind].join(', ')}, not "${input.expected}".`);
  }
  if (input.words.trim() === '') throw new CaseError('State the expected outcome in your own words; it is fixed before any trial.');
  if (input.kind === 'reviewer-detects-bad-candidate' && !input.pins['defectPattern']?.trim()) {
    throw new CaseError('A reviewer case needs the words a finding must contain to count as reporting the defect.');
  }
  const pinned = createHash('sha256').update(JSON.stringify(input.pins)).digest('hex').slice(0, 8);
  const id = `incident-${input.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${(input.pins['head'] ?? pinned).slice(0, 8)}`;
  const latest = latestIncidentSuite();
  if (latest?.cases.some((c) => c.id === id)) throw new CaseError(`${id} is already frozen in suite ${latest.version}.`);
  const next = `incidents-${latest ? Number(INCIDENT_SUITE.exec(latest.version)![1]) + 1 : 1}`;
  const entry: EvalCase = {
    id,
    kind: input.kind,
    description: `${input.subject}: ${input.words.trim()} (frozen by ${input.by})`,
    inputs: { ...input.pins, subject: input.subject, expectedInWords: input.words.trim(), frozenBy: input.by },
    requiredChecks: REQUIRED_CHECKS[input.kind],
    expected: input.expected,
    isFixture: false,
  };
  try {
    return { suite: freezeSuite(next, [...(latest?.cases ?? []), entry], BUILTIN_SCORING), caseId: id };
  } catch (err) {
    if (err instanceof OracleError) throw new CaseError(err.message);
    throw err;
  }
}
