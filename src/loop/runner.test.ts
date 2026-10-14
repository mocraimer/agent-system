import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');

describe('stopping the loop', () => {
  let dir: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill('SIGKILL');
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    child = undefined;
  });

  /** A dry-run loop against a throwaway clone whose `gh` always fails, so a pass ends at once and the loop sleeps. */
  function startLoop(): { child: ChildProcess; output: () => string } {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-runner-'));
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };
    git('init', '--quiet', 'repo');
    git('init', '--quiet', '--bare', 'empty.git');
    git('-C', 'repo', 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    git('-C', 'repo', 'config', `url.file://${join(dir, 'empty.git')}.insteadOf`, 'https://github.com/acme/widgets.git');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    mkdirSync(join(dir, 'state'));
    const proc = spawn(process.execPath, [MAIN, 'loop', '--dry-run', '--repo', join(dir, 'repo'), '--interval', '900'], {
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir, AGENTSYS_STATE: join(dir, 'state'), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    proc.stdout.on('data', (d: Buffer) => { text += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { text += d.toString('utf8'); });
    child = proc;
    return { child: proc, output: () => text };
  }

  const until = async (what: string, ready: () => boolean, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('ends the process within seconds when SIGTERM arrives during the sleep between passes', async () => {
    const { child: proc, output } = startLoop();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await until('the loop to start sleeping', () => output().includes('next pass in 900s'), 30_000);

    const stoppedAt = Date.now();
    proc.kill('SIGTERM');
    let giveUp: NodeJS.Timeout | undefined;
    const result = await Promise.race([exited, new Promise<undefined>((r) => { giveUp = setTimeout(() => r(undefined), 5_000); })]);
    clearTimeout(giveUp);

    assert.ok(result, `the loop was still running 5 s after SIGTERM (a pending sleep timer holds the process open); output:\n${output()}`);
    assert.equal(result.signal, null, 'the loop exited by itself, not killed by a signal');
    assert.ok(Date.now() - stoppedAt < 5_000);
  });
});
