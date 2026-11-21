import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment a worker starts in.
 *
 * A worker is a process the coordinator starts on this machine to do a task. It
 * inherits the coordinator's environment, and `AGENTSYS_STATE` is in it, so a
 * worker that runs `agentsys` or a recipe on a ticket for this very repository
 * would read and write the coordinator's own ledger, authority and runs. A
 * worker therefore gets a state directory of its own, outside the coordinator's
 * and removed when the run ends. It is always set: left unset, the CLI falls back
 * to a `.state` under the worker's working directory.
 *
 * Credentials, `PATH` and `HOME` stay as they are, so the runtimes' sign-ins work.
 */
export interface WorkerEnvironment {
  env: NodeJS.ProcessEnv;
  /** The state directory the worker was given. */
  stateDir: string;
  dispose(): void;
}

export function workerEnvironment(base: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentsys-worker-state-'));
  return {
    env: { ...base, AGENTSYS_STATE: stateDir },
    stateDir,
    dispose: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

/** Keep, with the run's evidence, which state directory its worker was given. */
export function recordWorkerState(evidenceDir: string, worker: WorkerEnvironment): string {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'worker-state.json');
  writeFileSync(path, JSON.stringify({ agentsysState: worker.stateDir }), 'utf8');
  return path;
}
