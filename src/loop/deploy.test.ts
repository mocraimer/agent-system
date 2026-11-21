import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * `scripts/deploy.sh --restart` against a scratch checkout with its own origin, a
 * stand-in build and a stubbed `systemctl --user`. Every armed loop is a unit named
 * `agentsys-loop*.service`; one with a model run in flight (a child of its main
 * process) is left alone and the exit code says so.
 */

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'deploy.sh');

describe('deploy.sh --restart', () => {
  let dir: string;
  let checkout: string;
  let busy: ChildProcess | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-deploy-'));
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(dir, 'origin.git')]);
    checkout = join(dir, 'checkout');
    execFileSync('git', ['clone', '--quiet', join(dir, 'origin.git'), checkout], { stdio: 'ignore' });
    git(checkout, 'config', 'user.email', 'test@example.test');
    git(checkout, 'config', 'user.name', 'test');
    git(checkout, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(checkout, '.gitignore'), 'dist\n');
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'scratch', scripts: { build: 'node build.js' } }));
    // The stand-in build records what dist was built from, as scripts/stamp-build.mjs does.
    writeFileSync(join(checkout, 'build.js'), [
      "const { execFileSync } = require('node:child_process'); const { mkdirSync, writeFileSync } = require('node:fs');",
      "mkdirSync('dist', { recursive: true });",
      "writeFileSync('dist/build-identity.json', JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: false }));",
    ].join('\n'));
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '--quiet', '-m', 'one');
    git(checkout, 'push', '--quiet', 'origin', 'main');
    execFileSync('npm', ['run', '--silent', 'build'], { cwd: checkout });
    // A later change lands on origin/main.
    const other = join(dir, 'other');
    execFileSync('git', ['clone', '--quiet', join(dir, 'origin.git'), other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'test@example.test');
    git(other, 'config', 'user.name', 'test');
    writeFileSync(join(other, 'change.txt'), 'two');
    git(other, 'add', '-A');
    git(other, 'commit', '--quiet', '-m', 'two');
    git(other, 'push', '--quiet', 'origin', 'main');

    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'units'));
    writeFileSync(join(dir, 'bin', 'systemctl'), [
      '#!/bin/sh',
      'shift',
      `D=${JSON.stringify(join(dir, 'units'))}`,
      'case "$1" in',
      '  list-unit-files) grep " enabled$" "$D/enabled" 2>/dev/null; true ;;',
      '  show) cat "$D/pid-$2" 2>/dev/null || echo 0 ;;',
      '  restart) echo "$2" >> "$D/restarted" ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(dir, 'bin', 'systemctl'), 0o755);
  });
  afterEach(() => {
    busy?.kill('SIGKILL');
    busy = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const armed = (...units: string[]): void => writeFileSync(join(dir, 'units', 'enabled'), units.map((u) => `${u} enabled`).join('\n') + '\n');
  const unitFiles = (lines: string[]): void => writeFileSync(join(dir, 'units', 'enabled'), lines.join('\n') + '\n');
  const restarted = (): string[] => (existsSync(join(dir, 'units', 'restarted')) ? readFileSync(join(dir, 'units', 'restarted'), 'utf8').trim().split('\n') : []);
  const deploy = () => {
    const done = spawnSync('bash', [DEPLOY, '--restart'], {
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, AGENTSYS_DEPLOY_DIR: checkout, XDG_RUNTIME_DIR: dir },
    });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };
  const identity = (): { revision: string } => JSON.parse(readFileSync(join(checkout, 'dist', 'build-identity.json'), 'utf8')) as { revision: string };
  const head = (): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const backups = (): string[] => readdirSync(dir).filter((n) => n.startsWith('checkout-dist-backup-'));
  /** A loop with a model run in flight: its main process has a child. */
  const runningModel = (unit: string): void => {
    busy = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'units', `pid-${unit}`), String(busy.pid));
  };

  it('restarts the loop an older build armed and one for each repository armed since', () => {
    armed('agentsys-loop.service', 'agentsys-loop-acme_widgets.service', 'agentsys-loop-acme_gadgets.service');
    const done = deploy();
    assert.equal(done.code, 0, done.out + done.err);
    assert.deepEqual(restarted().sort(), ['agentsys-loop-acme_gadgets.service', 'agentsys-loop-acme_widgets.service', 'agentsys-loop.service']);
    assert.equal(identity().revision, head(), 'dist was built from the new head');
    assert.equal(backups().length, 1);
  });

  it('restarts the loops that are idle and leaves the one with a model run in flight, saying which', () => {
    armed('agentsys-loop.service', 'agentsys-loop-acme_widgets.service');
    runningModel('agentsys-loop-acme_widgets.service');
    const done = deploy();
    assert.equal(done.code, 3, done.out + done.err);
    assert.deepEqual(restarted(), ['agentsys-loop.service']);
    assert.match(done.out, /agentsys-loop-acme_widgets\.service has a child run; not restarting/);
    assert.match(done.out, /not restarted: agentsys-loop-acme_widgets\.service; re-run once they sleep/);
    // Once it sleeps, the same command finishes the job.
    busy?.kill('SIGKILL');
    writeFileSync(join(dir, 'units', 'pid-agentsys-loop-acme_widgets.service'), '0');
    assert.equal(deploy().code, 0);
    assert.ok(restarted().includes('agentsys-loop-acme_widgets.service'));
  });

  it('leaves a loop that was disarmed alone', () => {
    unitFiles(['agentsys-loop-acme_widgets.service enabled', 'agentsys-loop-acme_gadgets.service disabled']);
    assert.equal(deploy().code, 0);
    assert.deepEqual(restarted(), ['agentsys-loop-acme_widgets.service']);
  });

  it('says so, and succeeds, when no loop is armed', () => {
    armed();
    const done = deploy();
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /no armed loop to restart/);
    assert.equal(identity().revision, head());
  });

  it('rolls back by restoring the dist it backed up and restarting every armed loop', () => {
    armed('agentsys-loop.service', 'agentsys-loop-acme_widgets.service');
    const before = identity().revision;
    assert.equal(deploy().code, 0);
    assert.notEqual(identity().revision, before);
    const [backup] = backups();
    assert.ok(backup);
    // The operator's rollback, as docs/OPERATING.md gives it.
    rmSync(join(checkout, 'dist'), { recursive: true });
    cpSync(join(dir, backup!), join(checkout, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'units', 'restarted'), '');
    for (const unit of ['agentsys-loop.service', 'agentsys-loop-acme_widgets.service']) {
      assert.equal(spawnSync('systemctl', ['--user', 'restart', unit], { env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` } }).status, 0);
    }
    assert.equal(identity().revision, before, 'the previous build is back');
    assert.deepEqual(restarted().sort(), ['agentsys-loop-acme_widgets.service', 'agentsys-loop.service']);
  });
});
