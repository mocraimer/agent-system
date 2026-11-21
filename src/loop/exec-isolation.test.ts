import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { coordinatorCommands } from './pass.js';

/**
 * A stage runs project checks and recipes in a worktree on a ticket's behalf. Those
 * are workers too: they must not be handed the coordinator's own state.
 */
describe('a command a stage runs on a ticket\'s behalf', () => {
  let box: Sandbox;
  let cwd: string;
  beforeEach(() => { box = sandbox(); cwd = mkdtempSync(join(tmpdir(), 'exec-isolation-')); });
  afterEach(() => { box.cleanup(); rmSync(cwd, { recursive: true, force: true }); });

  const printState = ['-e', 'process.stdout.write(process.env.AGENTSYS_STATE ?? "")'];

  it('gets a state directory of its own, outside the coordinator\'s, removed when it ends', async () => {
    const result = await coordinatorCommands().exec(process.execPath, printState, { cwd, timeoutMs: 15_000 });
    assert.equal(result.code, 0);
    const given = resolve(result.stdout);
    assert.ok(given.length > 0, 'a state directory is always given, so the CLI never falls back to a default path');
    assert.notEqual(given, resolve(box.root));
    assert.ok(!given.startsWith(resolve(box.root) + sep));
    assert.equal(existsSync(given), false);
  });

  it('keeps the environment the caller asked for', async () => {
    const result = await coordinatorCommands().exec(process.execPath,
      ['-e', 'process.stdout.write(process.env.GITHUB_OUTPUT ?? "")'], { cwd, timeoutMs: 15_000, env: { GITHUB_OUTPUT: '/tmp/outputs' } });
    assert.equal(result.stdout, '/tmp/outputs');
  });

  it('removes the state directory when the command could not start', async () => {
    const before = process.env['TMPDIR'];
    const tmp = mkdtempSync(join(tmpdir(), 'exec-tmp-'));
    process.env['TMPDIR'] = tmp;
    try {
      const result = await coordinatorCommands().exec(join(cwd, 'missing-binary'), [], { cwd, timeoutMs: 15_000 });
      assert.equal(result.code, null);
      assert.deepEqual(readdirSync(tmp), []);
    } finally {
      if (before === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = before;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

