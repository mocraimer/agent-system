import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mayProposePromptsTo, readFloor } from '../core/floor.js';
import { readJson, stateRoot, writeJson } from '../core/store.js';
import { GitRepo } from './git.js';
import { GhSnapshotSource } from '../console/snapshot.js';
import { GhStore, ReadOnlyStore, runGh } from './github.js';
import { telegramFromEnv } from './notify.js';
import { slugDir } from './context.js';
import { acquireLoopLock, coordinatorCommands, lastPass, loopDir, runPass } from './pass.js';
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
 * prompt. Prompt pull requests open only when the checkout's origin is the
 * repository the floor names for them; otherwise, or when the checkout is not a
 * GitHub clone, the stage saves its draft in the state directory instead.
 */
export async function improveDeps(repo: GitRepo, slug: string, coordinatorPath: string | undefined, print: (line: string) => void): Promise<ImproveDeps> {
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
    if (!mayProposePromptsTo(coordinatorSlug)) {
      print(`improve: prompt changes are saved as drafts, not proposed in ${coordinatorSlug}: the floor names ${readFloor().promptProposals ?? 'no repository'} for prompt proposals (agentsys floor --prompt-proposals <owner/name>)`);
      return deps;
    }
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

/** One armed loop as the operator sees it: which repository, which service, and whether it predates per-repository arming. */
export interface ArmedLoop extends ArmedConfig {
  slug: string;
  unit: string;
  legacy: boolean;
}

/**
 * The one loop an older build armed: a single `loop/armed.json` and one fixed unit.
 * It keeps running after a deploy and is replaced when its repository is armed again.
 */
export const LEGACY_UNIT = 'agentsys-loop.service';
export const legacyArmedPath = (): string => join(stateRoot(), 'loop', 'armed.json');

/** One armed record and one user service per repository, so arming a second repository leaves the first alone. */
export const armedPathFor = (slug: string): string => join(loopDir(slug), 'armed.json');
export const unitNameFor = (slug: string): string => `agentsys-loop-${slugDir(slug)}.service`;
const unitPath = (unit: string): string => join(homedir(), '.config', 'systemd', 'user', unit);

type StoredArmed = ArmedConfig & { slug?: string };

/** Something the operator can act on: which step failed, why, and what is in place. */
export class ArmingError extends Error {
  override readonly name = 'ArmingError';
}

export function readArmed(slug?: string): ArmedConfig | undefined {
  return readJson<ArmedConfig>(slug === undefined ? legacyArmedPath() : armedPathFor(slug));
}

async function slugOfPath(repoPath: string): Promise<string | undefined> {
  return new GitRepo(repoPath).slug().catch(() => undefined);
}

/** Every repository armed on this installation, the legacy one included. */
export async function listArmed(): Promise<ArmedLoop[]> {
  const loops: ArmedLoop[] = [];
  const legacy = readJson<ArmedConfig>(legacyArmedPath());
  if (legacy) {
    const slug = await slugOfPath(legacy.repoPath) ?? legacy.repoPath;
    loops.push({ ...legacy, slug, unit: LEGACY_UNIT, legacy: true });
  }
  const root = join(stateRoot(), 'loop');
  const repoDirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  for (const name of repoDirs) {
    const record = readJson<StoredArmed>(join(root, name, 'armed.json'));
    if (record?.slug) loops.push({ repoPath: record.repoPath, intervalSeconds: record.intervalSeconds, ...(record.policyRef ? { policyRef: record.policyRef } : {}), slug: record.slug, unit: unitNameFor(record.slug), legacy: false });
  }
  return loops;
}

/** The user unit that keeps one repository's loop running and starts it when the machine does. */
export function renderUnit(config: { cliPath: string; nodePath: string; state: string; path: string; repoPath: string; slug?: string }): string {
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
    `ExecStart=${config.nodePath} ${config.cliPath} loop --armed${config.slug ? ` --slug ${config.slug}` : ''}`,
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

/** Run systemctl for the user; a refusal names the step, the cause and what is already in place. */
async function systemctl(args: string[], step: string, state: string): Promise<string> {
  try {
    return (await run('systemctl', ['--user', ...args])).stdout;
  } catch (err) {
    const cause = ((err as { stderr?: string }).stderr || (err instanceof Error ? err.message : String(err))).trim();
    throw new ArmingError(`${step} failed: ${cause}\n${state}`);
  }
}

/**
 * Arm the loop for one repository: record what it runs against, install its user
 * unit, and start it. Other armed repositories are left running, and all of them
 * share the one state directory and ledger.
 *
 * The unit captures this shell's PATH, because the loop spawns `claude`, `pi`,
 * `gh` and `git`, and a user service starts with systemd's minimal PATH.
 *
 * The old single-repository service is retired only when the repository being
 * armed is the one it ran, so there is never a second loop on that repository.
 */
export async function arm(config: ArmedConfig, cliPath: string): Promise<string[]> {
  const state = resolve(stateRoot());
  const repoPath = resolve(config.repoPath);
  const slug = await new GitRepo(repoPath).slug();
  const unit = unitNameFor(slug);
  const record: StoredArmed = { ...config, repoPath, slug };
  writeJson(armedPathFor(slug), record);
  mkdirSync(dirname(unitPath(unit)), { recursive: true });
  writeFileSync(unitPath(unit), renderUnit({
    cliPath: resolve(cliPath), nodePath: process.execPath, state, path: process.env['PATH'] ?? '/usr/bin:/bin', repoPath, slug,
  }), 'utf8');
  const written = `${armedPathFor(slug)} and ${unitPath(unit)} are written; ${slug} is not running yet. Fix the cause and run the same \`agentsys loop arm\` command again.`;
  await systemctl(['daemon-reload'], 'systemctl --user daemon-reload', written);

  const lines: string[] = [];
  const legacy = readJson<ArmedConfig>(legacyArmedPath());
  if (legacy && await slugOfPath(legacy.repoPath) === slug) {
    await systemctl(['disable', '--now', LEGACY_UNIT], `Stopping the old service ${LEGACY_UNIT}, which ran ${slug}`, `${written} The old service is still running ${slug}.`);
    rmSync(legacyArmedPath(), { force: true });
    rmSync(unitPath(LEGACY_UNIT), { force: true });
    lines.push(`Replaced the old service ${LEGACY_UNIT}, which ran ${slug}.`);
  }
  await systemctl(['enable', '--now', unit], `Starting ${unit}`, written);
  lines.unshift(
    `Armed ${slug}: ${armedPathFor(slug)} names ${repoPath}, every ${config.intervalSeconds}s${config.policyRef ? `, policy from ${config.policyRef}` : ''}.`,
    `Installed ${unitPath(unit)} and started it. Follow it with: journalctl --user -u ${unit} -f`,
  );
  return lines;
}

/** Which armed loop an operator meant: `target` is a checkout path or `owner/name`; without one, the only armed loop. */
async function pick(target: string | undefined, armed: ArmedLoop[]): Promise<ArmedLoop> {
  const names = (): string => armed.map((a) => a.slug).join(', ');
  if (target === undefined) {
    if (armed.length === 0) throw new ArmingError('No loop is armed.');
    if (armed.length > 1) throw new ArmingError(`${armed.length} loops are armed (${names()}); name one with --repo <checkout or owner/name>.`);
    return armed[0]!;
  }
  const slug = existsSync(target) ? await slugOfPath(resolve(target)) : /^[^/\s]+\/[^/\s]+$/.test(target) ? target : undefined;
  const found = armed.find((a) => a.slug === slug);
  if (!found) throw new ArmingError(`${target} is not armed. ${armed.length === 0 ? 'No loop is armed.' : `Armed: ${names()}.`}`);
  return found;
}

/** Stop and disable one repository's loop; the others keep running. */
export async function disarm(target?: string): Promise<string[]> {
  const loop = await pick(target, await listArmed());
  const record = loop.legacy ? legacyArmedPath() : armedPathFor(loop.slug);
  await systemctl(['disable', '--now', loop.unit], `Stopping ${loop.unit}`, `${loop.slug} is still armed and running.`);
  return [`Stopped and disabled ${loop.unit} for ${loop.slug}. ${record} is kept; \`agentsys loop arm\` rewrites it.`];
}

/** One line per armed repository: its service, whether it is running, and its last pass. */
export async function armedStatus(): Promise<string[]> {
  const armed = await listArmed();
  if (armed.length === 0) return ['No loop is armed. Arm one with `agentsys loop arm --repo <checkout>`.'];
  const lines: string[] = [];
  for (const loop of armed) {
    const active = (await run('systemctl', ['--user', 'is-active', loop.unit]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '')).trim() || 'unknown';
    const last = lastPass(loop.slug);
    lines.push(`${loop.slug}: ${loop.unit} ${active}, every ${loop.intervalSeconds}s${loop.legacy ? ' (armed by an older build; arm it again to move it to its own record)' : ''}`);
    lines.push(`  ${last ? `last pass ${last.passId} ended ${last.endedAt} — ${last.classification}: ${last.because}` : 'no pass recorded yet'}`);
  }
  return lines;
}
