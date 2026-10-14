import { join } from 'node:path';
import { readJson, stateRoot, writeJson } from './store.js';

/**
 * The operator's per-installation floor: settings no approval or grant can relax.
 *
 * They live in the state directory rather than in a target repository's
 * store-config because the loop reads store-config *from* the base branch, so
 * that file cannot be what names the base. Nothing here has a default: a fresh
 * install constrains no base and treats no cloud project as read-only until the
 * operator says so.
 */
export interface FloorSettings {
  /** Base branch each repository's integration pull requests must target, by `owner/name`. */
  prBases: Record<string, string>;
  /** Cloud projects no writing action may target, whatever the repository. */
  readOnlyProjects: string[];
  /**
   * The repository, by `owner/name`, the improve stage may open prompt-change pull
   * requests in. Their bodies quote the target's slug, paths and run evidence, so
   * the coordinator's own origin — often a public upstream — gets none unless named.
   */
  promptProposals?: string;
}

export const floorPath = (): string => join(stateRoot(), 'floor.json');

export function readFloor(): FloorSettings {
  const stored = readJson<Partial<FloorSettings>>(floorPath()) ?? {};
  return {
    prBases: stored.prBases ?? {}, readOnlyProjects: stored.readOnlyProjects ?? [],
    ...(stored.promptProposals ? { promptProposals: stored.promptProposals } : {}),
  };
}

export function writeFloor(settings: FloorSettings): void {
  writeJson(floorPath(), settings);
}

/** The base a repository's integration pull requests must target, if the operator set one. */
export function requiredPrBase(repo: string): string | undefined {
  return readFloor().prBases[repo];
}

/** The branch the loop, console and CLI treat as a repository's integration base. */
export function integrationBase(repo: string): string {
  return requiredPrBase(repo) ?? 'main';
}

/** Whether the improve stage may open a prompt-change pull request in this repository. */
export function mayProposePromptsTo(repo: string): boolean {
  return readFloor().promptProposals === repo;
}
