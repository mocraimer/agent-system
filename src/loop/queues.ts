import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateRoot } from '../core/store.js';
import { defaultQueueRules } from './default-queue-rules.js';
import type { Repo } from './git.js';
import type { Issue } from './github.js';

/**
 * The rules that decide which tickets need shaping, which await a verdict, which
 * are ready, what a claim is, and when an assessment is current.
 *
 * A target repository may ship its own in
 * `scripts/agent-system/{shape-candidates,auto-candidates}.mjs` on its base
 * branch; the loop imports them as they stand there, so the repository changes its
 * rules without a coordinator release. A repository that ships neither gets
 * `defaultQueueRules`, the manifest-dev ticket convention.
 */
export interface QueueRules {
  SHAPE_MARKER: string;
  shapeable(issues: Issue[], effortLabel: string | null): Issue[];
  issueBodyHash(body: string): string;
  readShapeFingerprint(commentBody: string): string | null;
  renderShapeFingerprint(hex: string): string;

  MARKER: string;
  CLAIM_MARKER: string;
  LOOP_CLAIM_LINE: string;
  ALL_EFFORTS: symbol;
  isClaim(commentBody: string): boolean;
  trackingIssue(issues: Issue[], effortLabel: string): Issue;
  dependsOn(body: string): number[];
  candidates(issues: Issue[], effortLabel: string | symbol): Issue[];
  eligible(issues: Issue[], effortLabel: string | symbol, dependencyStates: Record<number, string>, claimed: number[]): Issue[];
  decide(input: {
    issues: Issue[]; effortLabel: string; dependencyStates: Record<number, string>; devHead: string; priorComment: string | null;
  }): { shouldRun: boolean; reason: string; fingerprint: string; trackingNumber: number; candidateNumbers: number[] };
  renderFingerprint(hex: string): string;
}

const MODULES = ['shape-candidates.mjs', 'auto-candidates.mjs'] as const;
const DIR = 'scripts/agent-system';

const REQUIRED: ReadonlyArray<keyof QueueRules> = [
  'SHAPE_MARKER', 'shapeable', 'issueBodyHash', 'readShapeFingerprint', 'renderShapeFingerprint',
  'MARKER', 'CLAIM_MARKER', 'LOOP_CLAIM_LINE', 'ALL_EFFORTS', 'isClaim', 'trackingIssue', 'dependsOn',
  'candidates', 'eligible', 'decide', 'renderFingerprint',
];

/**
 * The target's queue modules as they are at `ref` (a fetched base branch), cached
 * by commit, or the built-in rules when it ships neither module.
 */
export async function loadQueueRules(repo: Repo, ref: string, markerPrefix: string): Promise<QueueRules> {
  const shipped = await Promise.all(MODULES.map((name) => repo.has(ref, `${DIR}/${name}`)));
  if (shipped.every((s) => !s)) return defaultQueueRules(markerPrefix);
  const sha = await repo.revParse(ref);
  const absent = MODULES.filter((_, i) => !shipped[i]);
  if (absent.length > 0) {
    throw new Error(`${DIR} at ${ref} (${sha.slice(0, 8)}) has ${MODULES.find((_, i) => shipped[i])} but not ${absent.join(', ')}; ship both modules or neither.`);
  }
  const dir = join(stateRoot(), 'loop', 'modules', sha);
  mkdirSync(dir, { recursive: true });
  for (const name of MODULES) {
    writeFileSync(join(dir, name), await repo.show(ref, `${DIR}/${name}`), 'utf8');
  }
  const loaded = {
    ...(await import(pathToFileURL(join(dir, 'shape-candidates.mjs')).href) as object),
    ...(await import(pathToFileURL(join(dir, 'auto-candidates.mjs')).href) as object),
  } as Partial<QueueRules>;
  const missing = REQUIRED.filter((k) => loaded[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`${DIR} at ${ref} (${sha.slice(0, 8)}) does not export ${missing.join(', ')}; the loop cannot read its queues.`);
  }
  return loaded as QueueRules;
}
