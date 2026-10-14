import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const hash = createHash('sha256');
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name !== 'build-identity.json') {
      hash.update(relative(dist.pathname, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  }
}
walk(dist.pathname);
let revision = null;
let dirty = true;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
} catch { /* Source archives have no revision; their content digest still identifies the build. */ }
writeFileSync(new URL('build-identity.json', dist), JSON.stringify({ digest: hash.digest('hex'), revision, dirty, builtAt: new Date().toISOString() }, null, 2) + '\n');
