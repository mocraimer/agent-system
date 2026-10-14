import { join } from 'node:path';
import type { Actor } from './authority.js';
import { assertOperator } from './authority.js';
import type { Outcome } from './outcome.js';
import { listJson, listRecords, readRecord, stateRoot, withLock, writeJson } from './store.js';

/** What produced a run, recorded so a result can be attributed to a build. */
export interface SystemVersion {
  /** Coordinator build identity — a commit SHA or a released version. */
  coordinator: string;
  /** Per-runtime adapter identities. */
  adapters: Record<string, string>;
  /** Identity of the prompt/skill configuration in force. */
  prompts: string;
}

export interface ActiveVersionRecord extends SystemVersion {
  activatedAt: string;
  activatedBy: string;
  /** The reviewed, merged change that authorized this. */
  mergedPr: string;
  /** What was active before, so a rollback has somewhere to go. */
  previous?: SystemVersion;
}

/**
 * An unmerged build, exercised deliberately as a subject rather than a runner.
 *
 * The bootstrap build is one of these. Recording it separately is what keeps
 * "we tested this candidate" from drifting into "this candidate is now the system".
 */
export interface CandidateRecord extends SystemVersion {
  id: string;
  exercisedAt: string;
  /** Where the candidate came from — a branch, a PR, a local build. */
  origin: string;
  /** Free text: what was exercised. Never an activation. */
  purpose: string;
}

const activePath = (): string => join(stateRoot(), 'active-version.json');
const candidatesDir = (): string => join(stateRoot(), 'candidates');
const historyDir = (): string => join(stateRoot(), 'version-history');

export function activeVersion(): ActiveVersionRecord | undefined {
  return readRecord<ActiveVersionRecord>('active-version', activePath());
}

export function versionHistory(): ActiveVersionRecord[] {
  return listRecords<ActiveVersionRecord>('active-version', historyDir());
}

export function listCandidates(): CandidateRecord[] {
  return listJson<CandidateRecord>(candidatesDir());
}

export class UpdateError extends Error {
  override readonly name = 'UpdateError';
}

export interface ActivateInput extends SystemVersion {
  /** URL of the merged, human-reviewed pull request that introduced this build. */
  mergedPr: string;
  /** Evidence the merge actually happened, checked by the caller against the forge. */
  mergeConfirmed: boolean;
}

/**
 * Make a build the ongoing runner.
 *
 * Requires the configured operator *and* a confirmed reviewed merge. Two separate
 * conditions on purpose: an operator changing a threshold or issuing a grant is a
 * configuration action, and must not be a path by which control code is replaced.
 */
export function activateVersion(actor: Actor, input: ActivateInput): ActiveVersionRecord {
  assertOperator(actor);
  if (!input.mergeConfirmed) {
    throw new UpdateError(
      'An update to the running system needs a confirmed reviewed merge. An unmerged build may be exercised as a candidate, but it cannot become the runner.',
    );
  }
  if (!input.mergedPr || !/^https?:\/\//.test(input.mergedPr)) {
    throw new UpdateError('An update must name the merged pull request it came from.');
  }
  return withLock('active-version', () => {
    const current = activeVersion();
    const record: ActiveVersionRecord = {
      coordinator: input.coordinator,
      adapters: input.adapters,
      prompts: input.prompts,
      activatedAt: new Date().toISOString(),
      activatedBy: actor.id,
      mergedPr: input.mergedPr,
      ...(current
        ? { previous: { coordinator: current.coordinator, adapters: current.adapters, prompts: current.prompts } }
        : {}),
    };
    if (current) {
      writeJson(join(historyDir(), `${current.activatedAt.replace(/[:.]/g, '-')}.json`), current);
    }
    writeJson(activePath(), record);
    return record;
  });
}

/** Roll back to the version that was active before the current one. */
export function rollback(actor: Actor): ActiveVersionRecord {
  assertOperator(actor);
  return withLock('active-version', () => {
    const current = activeVersion();
    if (!current?.previous) {
      throw new UpdateError('There is no previous version to roll back to.');
    }
    const record: ActiveVersionRecord = {
      ...current.previous,
      activatedAt: new Date().toISOString(),
      activatedBy: actor.id,
      mergedPr: current.mergedPr,
    };
    writeJson(join(historyDir(), `${current.activatedAt.replace(/[:.]/g, '-')}.json`), current);
    writeJson(activePath(), record);
    return record;
  });
}

/**
 * Record that an unmerged build was exercised.
 *
 * Deliberately not gated on the operator: exercising a candidate is ordinary
 * testing. It is also deliberately unable to touch the active version — the two
 * live in different files and only `activateVersion` writes the active one.
 */
export function recordCandidate(input: Omit<CandidateRecord, 'id' | 'exercisedAt'>): CandidateRecord {
  const record: CandidateRecord = {
    ...input,
    id: `cand_${input.coordinator.slice(0, 12)}_${Date.now()}`,
    exercisedAt: new Date().toISOString(),
  };
  writeJson(join(candidatesDir(), `${record.id}.json`), record);
  return record;
}

/**
 * Refuse a mid-run swap of the thing doing the running.
 *
 * A run records the version that started it; if the active version has moved on,
 * the run keeps its own rather than picking up new control code halfway.
 */
export function versionForRun(runStartedWith: SystemVersion): SystemVersion {
  return runStartedWith;
}

/** Reject an attempt to make a candidate live without the operator and a merge. */
export function denyLiveUpdate(actor: Actor, candidate: CandidateRecord): Outcome {
  return {
    kind: 'refused',
    summary:
      actor.kind === 'operator'
        ? `Candidate ${candidate.id} has no confirmed reviewed merge, so it cannot become the running system.`
        : `A ${actor.kind} cannot replace the running system. Candidate ${candidate.id} stays a test subject.`,
    nextAction:
      'Land the change through a reviewed human merge, then activate it explicitly with `agentsys version activate --merged-pr <url>`.',
    details: { candidateOrigin: candidate.origin },
  };
}
