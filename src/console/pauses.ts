import { join } from 'node:path';
import { readJson, stateRoot, withLock, writeJson } from '../core/store.js';
import { slugDir } from '../loop/context.js';

/**
 * Stages the operator has paused, per target repository.
 *
 * Operational state, not policy: a pause says "not now" about a stage, and says
 * nothing about how far any work may go. It lives with the loop's own state, and
 * the next pass reads it.
 */
export type Pauses = Record<string, { by: string; at: string }>;

// Beside the loop's state.json; `loopDir` is not imported so the pass can read this without a cycle.
const path = (slug: string): string => join(stateRoot(), 'loop', slugDir(slug), 'paused.json');

export function readPauses(slug: string): Pauses {
  return readJson<Pauses>(path(slug)) ?? {};
}

export function setPaused(slug: string, stage: string, paused: boolean, by: string, at = new Date().toISOString()): Pauses {
  return withLock(`loop-pauses-${slugDir(slug)}`, () => {
    const current = readPauses(slug);
    const next: Pauses = { ...current };
    if (paused) next[stage] = { by, at };
    else delete next[stage];
    writeJson(path(slug), next);
    return next;
  });
}
