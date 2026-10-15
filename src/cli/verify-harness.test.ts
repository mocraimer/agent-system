import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
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
});
