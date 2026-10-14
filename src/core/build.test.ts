import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

it('a loaded process keeps its build while on-disk and selected metadata change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loaded-build-'));
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  copyFileSync(new URL('./build.js', import.meta.url), join(root, 'core', 'build.js'));
  const stamp = (digest: string) => ({ digest: digest.repeat(64), revision: digest.repeat(40), dirty: false, builtAt: new Date().toISOString() });
  writeFileSync(join(root, 'build-identity.json'), JSON.stringify(stamp('a')));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {buildIdentityView} from './core/build.js'; process.send(buildIdentityView()); process.on('message', selected => process.send(buildIdentityView(selected)));`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const [first] = await once(child, 'message');
    assert.equal(first.loaded.digest, 'a'.repeat(64));
    writeFileSync(join(root, 'build-identity.json'), JSON.stringify(stamp('b')));
    child.send('b'.repeat(40));
    const [after] = await once(child, 'message');
    assert.equal(after.loaded.digest, first.loaded.digest);
    assert.equal(after.onDisk.digest, 'b'.repeat(64));
    assert.equal(after.loadedMatchesDisk, false);
    assert.equal(after.loadedMatchesSelected, false);
    const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {buildIdentityView} from './core/build.js'; console.log(JSON.stringify(buildIdentityView()))`], { cwd: root, encoding: 'utf8' }));
    assert.equal(fresh.loaded.digest, 'b'.repeat(64));
    rmSync(join(root, 'build-identity.json'));
    const unknown = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {buildIdentityView} from './core/build.js'; console.log(JSON.stringify(buildIdentityView('selected')))`], { cwd: root, encoding: 'utf8' }));
    assert.equal(unknown.loaded, null);
    assert.equal(unknown.loadedMatchesSelected, null);
  } finally { child.kill(); await once(child, 'exit'); rmSync(root, { recursive: true, force: true }); }
});

it('the build stamp identifies actual compiled contents, including a dirty build', () => {
  const root = mkdtempSync(join(tmpdir(), 'stamp-build-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'dist'));
    copyFileSync(new URL('../../scripts/stamp-build.mjs', import.meta.url), join(root, 'scripts', 'stamp-build.mjs'));
    writeFileSync(join(root, 'dist', 'main.js'), 'export const revision = 1;');
    const stamp = () => {
      execFileSync(process.execPath, [join(root, 'scripts', 'stamp-build.mjs')], { stdio: 'pipe' });
      return JSON.parse(readFileSync(join(root, 'dist', 'build-identity.json'), 'utf8'));
    };
    const first = stamp();
    assert.equal(first.revision, null);
    assert.equal(first.dirty, true);
    assert.equal(stamp().digest, first.digest, 'the timestamp does not change the content identity');
    writeFileSync(join(root, 'dist', 'main.js'), 'export const revision = 2;');
    assert.notEqual(stamp().digest, first.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
