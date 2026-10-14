import { join } from 'node:path';
import { integrationBase } from '../core/floor.js';
import { listRuns } from '../core/run.js';
import { listScorecards } from '../eval/scorecard.js';
import type { Repo } from '../loop/git.js';
import { loopDir, readState } from '../loop/pass.js';
import type { LoopPolicy } from '../loop/policy.js';
import { parseStoreConfig, STORE_CONFIG_PATH } from '../loop/policy.js';
import { useMarkerPrefix } from '../loop/markers.js';
import { loadQueueRules } from '../loop/queues.js';
import type { QueueRules } from '../loop/queues.js';
import type { Board, CoordinatorFacts } from './facts.js';
import { buildBoard, referencedNumbers } from './facts.js';
import { readPauses } from './pauses.js';
import type { SnapshotSource, StoreSnapshot } from './snapshot.js';
import { GhSnapshotSource, LastGoodSnapshot } from './snapshot.js';

/** Where the console reads one target repository from. */
export interface ConsoleTarget {
  repo: Repo;
  slug: string;
  /** The branch policy and queue rules are read from: the store's pull-request base. */
  base: string;
  snapshots: LastGoodSnapshot;
}

export async function consoleTarget(repo: Repo, source?: SnapshotSource): Promise<ConsoleTarget> {
  const slug = await repo.slug();
  return {
    repo,
    slug,
    base: integrationBase(slug),
    snapshots: new LastGoodSnapshot(source ?? new GhSnapshotSource(slug), join(loopDir(slug), 'console-snapshot.json')),
  };
}

export function coordinatorFacts(slug: string): CoordinatorFacts {
  const lastPass = readState(slug).lastPass;
  const scorecards = listScorecards().filter((c) => c.repo === slug);
  const linked = new Set(scorecards.flatMap((c) => c.runIds));
  return {
    runsInFlight: listRuns().filter((r) => r.status === 'running' && (r.repo === slug || (r.repo === undefined && linked.has(r.id))))
      .map((r) => ({ runId: r.id, taskId: r.taskId, runtime: r.runtime, startedAt: r.startedAt })),
    scorecards,
    ...(lastPass ? { lastPass } : {}),
    paused: readPauses(slug),
  };
}

/** The live policy: the store configuration on the fetched base branch, as the loop reads it. */
export async function livePolicy(target: ConsoleTarget, requireFresh = false): Promise<LoopPolicy> {
  const ref = `origin/${target.base}`;
  // Reading the board offline can use the last fetched policy; an action cannot.
  if (requireFresh) await target.repo.fetch([target.base]);
  else await target.repo.fetch([target.base]).catch(() => undefined);
  const commit = await target.repo.revParse(ref);
  const policy = parseStoreConfig(await target.repo.show(ref, STORE_CONFIG_PATH), `${STORE_CONFIG_PATH} at ${ref} ${commit}`);
  useMarkerPrefix(policy.protocol.markerPrefix.value);
  return policy;
}

export interface BoardRead {
  board: Board;
  policy: LoopPolicy;
  rules: QueueRules;
  /** Commit whose queue rules were loaded; a later base move invalidates their decision. */
  baseSha: string;
  /** The snapshot the board was built from, fresh or last good. */
  snapshot?: StoreSnapshot;
}

/** One refresh: policy and rules from the base branch, the store from GitHub (or its last good read), and the coordinator's records. */
export async function readBoard(target: ConsoleTarget, extra: { issues: number[]; pulls: number[] } = { issues: [], pulls: [] }, requireFresh = false): Promise<BoardRead> {
  const policy = await livePolicy(target, requireFresh);
  const baseSha = await target.repo.revParse(`origin/${target.base}`);
  const rules = await loadQueueRules(target.repo, baseSha, policy.protocol.markerPrefix.value);
  const coordinator = coordinatorFacts(target.slug);
  const referenced = referencedNumbers(coordinator.scorecards);
  const read = await target.snapshots.refresh({ issues: [...referenced.issues, ...extra.issues], pulls: [...referenced.pulls, ...extra.pulls] });
  return { board: buildBoard({ read, coordinator, rules, policy }), policy, rules, baseSha, ...(read.snapshot ? { snapshot: read.snapshot } : {}) };
}
