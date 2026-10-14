import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson, stateRoot, writeJson } from '../core/store.js';
import { GitRepo } from './git.js';
import { GhSnapshotSource } from '../console/snapshot.js';
import { GhStore, ReadOnlyStore, runGh } from './github.js';
import { telegramFromEnv } from './notify.js';
import { acquireLoopLock, coordinatorCommands, runPass } from './pass.js';
import type { NotifyDeps } from './pass.js';
import type { ImproveDeps } from './stages/improve.js';
import type { PassReport } from './supervisor.js';
import type { PassOptions } from './types.js';

const run = promisify(execFile);

export interface LoopRun extends PassOptions {
  repoPath: string;
  once: boolean;
  intervalSeconds: number;
  /** The coordinator's own checkout, where the improve stage proposes prompt changes; defaults to the one running. */
  coordinatorRepo?: string;
}

/**
 * Run passes against one repository until stopped, or once.
 *
 * A real loop holds the repository's loop lock for as long as it runs, so a
 * second one — a hand-run `--once` beside the armed service, say — is refused
 * rather than dispatching the same review twice. A dry run takes no lock: it
 * writes nothing, so it cannot collide with anything.
 */
export async function runLoop(opts: LoopRun, print: (line: string) => void = console.log): Promise<PassReport | undefined> {
  const repo = new GitRepo(resolve(opts.repoPath));
  const slug = await repo.slug();
  const gh = new GhStore(slug);
  const store = opts.dryRun ? new ReadOnlyStore(gh) : gh;
  const release = opts.dryRun ? () => {} : acquireLoopLock(slug);
  const notify = opts.dryRun ? undefined : await notifyDeps(slug, print);
  const improve = await improveDeps(repo, slug, opts.coordinatorRepo, print);
  const stopping = new AbortController();
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopping.abort();
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    let last: PassReport | undefined;
    for (;;) {
      last = await runPass({ repo, store, commands: coordinatorCommands(undefined, print), log: print, signal: stopping.signal, improve, ...(notify ? { notify } : {}) }, opts);
      if (opts.once || stopping.signal.aborted) return last;
      print(`next pass in ${opts.intervalSeconds}s`);
      // A stop wakes the sleep and cancels its timer. A timer left pending keeps the process alive
      // until it fires, and systemd kills a loop that outlasts its stop timeout.
      await new Promise<void>((done) => {
        const timer = setTimeout(done, opts.intervalSeconds * 1000);
        wake = () => { clearTimeout(timer); done(); };
      });
      if (stopping.signal.aborted) return last;
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    release();
  }
}

/**
 * Who to mention and how to message: the operator's own GitHub login, read
 * through `gh`, and Telegram when its token and chat id are in the environment.
 */
async function notifyDeps(slug: string, print: (line: string) => void): Promise<NotifyDeps> {
  const mention = await runGh(['api', 'user', '--jq', '.login']).then((out) => out.trim()).catch((err: unknown) => {
    print(`notify: could not read the GitHub login, so the status comment will mention nobody: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  });
  const messenger = telegramFromEnv(process.env);
  if ('skipped' in messenger) print(`notify: Telegram off (${messenger.skipped}); set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to send.`);
  return { snapshots: new GhSnapshotSource(slug), messenger, ...(mention ? { mention } : {}) };
}

/**
 * What the improve stage proposes through: the target's git for a tier, and the
 * coordinator's own checkout — the one this code runs from unless named — for a
 * prompt. A checkout that is not a GitHub clone leaves prompt proposals off.
 */
async function improveDeps(repo: GitRepo, slug: string, coordinatorPath: string | undefined, print: (line: string) => void): Promise<ImproveDeps> {
  const path = resolve(coordinatorPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const deps: ImproveDeps = {
    snapshots: new GhSnapshotSource(slug),
    targetGit: repo,
    command: `agentsys ${process.argv.slice(2).join(' ')} (in ${process.cwd()})`,
    pull: async (n) => JSON.parse(await runGh(['pr', 'view', String(n), '--repo', slug, '--json', 'title,body'])) as { title: string; body: string },
  };
  try {
    const git = new GitRepo(path);
    const coordinatorSlug = await git.slug();
    deps.coordinator = { git, store: new GhStore(coordinatorSlug), slug: coordinatorSlug, base: 'main', path, commit: await git.revParse('HEAD') };
  } catch (err) {
    print(`improve: ${path} is not a GitHub checkout of the coordinator, so prompt changes cannot be proposed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return deps;
}

/* --------------------------------------------------------------- arming */

/** What an armed loop runs against. Written by `agentsys loop arm`, read by `agentsys loop --armed`. */
export interface ArmedConfig {
  repoPath: string;
  intervalSeconds: number;
  policyRef?: string;
}

export const armedConfigPath = (): string => join(stateRoot(), 'loop', 'armed.json');
export const UNIT_NAME = 'agentsys-loop.service';
const unitPath = (): string => join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);

export function readArmed(): ArmedConfig | undefined {
  return readJson<ArmedConfig>(armedConfigPath());
}

/** The user unit that keeps the loop running and starts it when the machine does. */
export function renderUnit(config: { cliPath: string; nodePath: string; state: string; path: string; repoPath: string }): string {
  return [
    '[Unit]',
    `Description=agentsys loop for ${config.repoPath}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=AGENTSYS_STATE=${config.state}`,
    `Environment=PATH=${config.path}`,
    // The loop reads nothing from its working directory; its state comes from AGENTSYS_STATE.
    `WorkingDirectory=${config.state}`,
    `ExecStart=${config.nodePath} ${config.cliPath} loop --armed`,
    'Restart=on-failure',
    'RestartSec=60',
    // A stop ends the pass after the item in hand. A model run in flight is not
    // waited for: it is stopped with the service, and the next start's recovery
    // reads what it left.
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Arm the loop: record what it runs against, install the user unit, and start it.
 *
 * The unit captures this shell's PATH, because the loop spawns `claude`, `pi`,
 * `gh` and `git`, and a user service starts with systemd's minimal PATH.
 */
export async function arm(config: ArmedConfig, cliPath: string): Promise<string[]> {
  const state = resolve(stateRoot());
  writeJson(armedConfigPath(), { ...config, repoPath: resolve(config.repoPath) });
  mkdirSync(dirname(unitPath()), { recursive: true });
  writeFileSync(unitPath(), renderUnit({
    cliPath: resolve(cliPath), nodePath: process.execPath, state, path: process.env['PATH'] ?? '/usr/bin:/bin', repoPath: resolve(config.repoPath),
  }), 'utf8');
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  return [
    `Armed: ${armedConfigPath()} names ${resolve(config.repoPath)}, every ${config.intervalSeconds}s${config.policyRef ? `, policy from ${config.policyRef}` : ''}.`,
    `Installed ${unitPath()} and started it. Follow it with: journalctl --user -u ${UNIT_NAME} -f`,
  ];
}

export async function disarm(): Promise<string[]> {
  await run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  return [`Stopped and disabled ${UNIT_NAME}. ${armedConfigPath()} is kept; \`agentsys loop arm\` rewrites it.`];
}
