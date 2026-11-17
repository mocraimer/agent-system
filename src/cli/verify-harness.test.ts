import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
// dist/cli -> dist -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The verification harness's recipes name commands and paths in this repository. When a file
 * they name moves or a recipe stops parsing, this fails, so the harness cannot drift unnoticed
 * by contributors who never read a recipe.
 */
describe('the verification harness', () => {
  it('has recipes that parse and name only paths that exist', async () => {
    const { stdout } = await run(join(repoRoot, 'scripts', 'verify'), ['check'], { cwd: repoRoot });
    assert.match(stdout, /^check: ok$/m);
  });

  describe('while a scenario of its own runs', () => {
    const scratch: string[] = [];
    after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

    /** A one-recipe project whose only evidence file is empty: a run that has reserved its file and not yet written it. */
    function projectWithReservedEvidence(): { root: string; reserved: string } {
      const root = mkdtempSync(join(tmpdir(), 'verify-reserved-'));
      scratch.push(root);
      mkdirSync(join(root, 'verification', 'recipes'), { recursive: true });
      mkdirSync(join(root, 'verification', 'evidence', 'thing'), { recursive: true });
      writeFileSync(join(root, 'thing.txt'), 'covered');
      writeFileSync(join(root, 'verification', 'harness.md'), '# Verification harness\n\n- ask-first: ask\n');
      writeFileSync(join(root, 'verification', 'recipes', 'thing.md'), [
        '---', 'kind: feature', 'covers: thing.txt', '---', '# Thing', '', 'It is a thing.', '', '## How a user reaches it', '', '- A command.', '',
        '## Scenarios', '', '### only', 'Run: `true`', 'Proves: nothing.', '',
      ].join('\n'));
      const reserved = join(root, 'verification', 'evidence', 'thing', '20261117T080000Z.md');
      writeFileSync(reserved, '');
      return { root, reserved };
    }
    const check = (root: string, env: Record<string, string> = {}) => run(join(repoRoot, 'scripts', 'verify'), ['check'], { cwd: root, env: { ...process.env, VERIFY_ROOT: root, ...env } });

    // The project's own suite runs `verify check` from a scenario that `verify drive` is running,
    // so the file that run has reserved is not yet written and must not fail it.
    it('does not fail on the evidence file the running scenario has reserved', async () => {
      const { root, reserved } = projectWithReservedEvidence();
      const { stdout } = await check(root, { VERIFY_RUN_EVIDENCE: reserved });
      assert.match(stdout, /^check: ok$/m);
    });

    it('still fails on an empty evidence file no run has reserved', async () => {
      const { root } = projectWithReservedEvidence();
      await assert.rejects(check(root), (err: { stdout?: string; stderr?: string }) => /empty — a run that never finished/.test(`${err.stdout}${err.stderr}`));
    });
  });
});
