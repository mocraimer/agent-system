import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GhStore } from './github.js';

/** Exercise the production gh subprocess boundary without a network or login. */
describe('complete workflow history for an exact branch and commit', () => {
  let dir: string;
  let originalPath: string | undefined;
  const sha = 'a'.repeat(40);
  const run = (id: number, name = 'Claude Code', conclusion: string | null = 'skipped') => ({
    id, status: conclusion === null ? 'in_progress' : 'completed', conclusion, head_sha: sha, name,
    run_attempt: 1, run_started_at: new Date(Date.UTC(2026, 8, 22, 0, 0, id)).toISOString(),
  });
  const respond = (workflow_runs: ReturnType<typeof run>[], total_count = workflow_runs.length, error = '') => {
    writeFileSync(join(dir, 'response.json'), JSON.stringify({ workflow_runs, total_count, error }));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-gh-history-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'response.json'))}, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(dir, 'arguments.jsonl'))}, JSON.stringify(args) + '\\n');
if (data.error) { console.error(data.error); process.exit(1); }
if (args[0] !== 'api' || !args.includes('--paginate') || !args.includes('--jq')) {
  console.error('unexpected gh command'); process.exit(2);
}
const jq = args[args.indexOf('--jq') + 1];
if (!jq) { console.error('missing jq expression'); process.exit(2); }
const pages = Math.max(1, Math.ceil(data.workflow_runs.length / 100));
for (let p=0; p<pages; p++) {
  const raw = {total_count: data.total_count, workflow_runs: data.workflow_runs.slice(p*100, (p+1)*100)};
  const result = spawnSync('/usr/bin/jq', ['-c', jq], {input: JSON.stringify(raw), encoding: 'utf8'});
  if (result.error || result.status !== 0) {
    console.error(result.error || result.stderr); process.exit(result.status || 2);
  }
  process.stdout.write(result.stdout);
}
`, { mode: 0o700 });
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${join(dir, 'bin')}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the deployment beyond a page of unrelated skipped runs', async () => {
    respond([...Array.from({ length: 175 }, (_, i) => run(300 - i)), run(12, 'Deploy', 'success')]);
    const rows = await new GhStore('owner/repo').runsForCommit('main', sha);
    assert.equal(rows.length, 176);
    assert.deepEqual(rows.find((r) => r.workflow === 'Deploy'), {
      id: 12, status: 'completed', conclusion: 'success', headSha: sha,
      workflow: 'Deploy', runAttempt: 1,
      attemptStartedAt: run(12).run_started_at,
    });
    const args = JSON.parse(readFileSync(join(dir, 'arguments.jsonl'), 'utf8').trim()) as string[];
    assert.equal(args[0], 'api');
    assert.ok(args.includes('--paginate'));
    assert.match(args[1] ?? '', new RegExp(`head_sha=${sha}`));
    assert.match(args[1] ?? '', /branch=main/);
  });

  it('keeps ordered attempts and conclusions rather than selecting an older success', async () => {
    respond([run(20, 'Deploy', 'failure'), run(19, 'Deploy', 'success'), run(18, 'Deploy', null)]);
    const rows = await new GhStore('owner/repo').runsForCommit('release/next', sha);
    assert.deepEqual(rows.map((r) => [r.id, r.workflow, r.status, r.conclusion, r.runAttempt]), [
      [20, 'Deploy', 'completed', 'failure', 1],
      [19, 'Deploy', 'completed', 'success', 1],
      [18, 'Deploy', 'in_progress', null, 1],
    ]);
    const args = JSON.parse(readFileSync(join(dir, 'arguments.jsonl'), 'utf8').trim()) as string[];
    assert.match(args[1] ?? '', /branch=release%2Fnext/);
  });

  it('orders a rerun of an older id by its new attempt start, not by id or page position', async () => {
    const rerun = { ...run(10, 'Deploy', 'failure'), run_attempt: 2, run_started_at: '2026-09-23T10:00:00Z' };
    respond([run(21, 'Deploy', 'success'), rerun]);
    const rows = await new GhStore('owner/repo').runsForCommit('main', sha);
    assert.deepEqual(rows.map((r) => [r.id, r.runAttempt, r.conclusion]), [[10, 2, 'failure'], [21, 1, 'success']]);
  });

  it('does not accept another commit or a run missing attempt identity as a complete observation', async () => {
    respond([{ ...run(10, 'Deploy', 'success'), head_sha: 'b'.repeat(40) }]);
    await assert.rejects(new GhStore('owner/repo').runsForCommit('main', sha), /invalid run identity/);
    respond([{ ...run(10), run_attempt: 0 }]);
    await assert.rejects(new GhStore('owner/repo').runsForCommit('main', sha), /invalid run identity/);
  });

  it('distinguishes an empty complete result from an incomplete result or unavailable read', async () => {
    const store = new GhStore('owner/repo');
    respond([]);
    assert.deepEqual(await store.runsForCommit('main', sha), []);
    respond([run(1)], 101);
    await assert.rejects(store.runsForCommit('main', sha), /incomplete|partial/i);
    respond([], 0, 'HTTP 503: unavailable');
    await assert.rejects(store.runsForCommit('main', sha), /503/);
  });
});

describe('the commits of a pull request', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-gh-commits-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'pr' || args[1] !== 'view' || !args.includes('commits')) { console.error('unexpected gh command'); process.exit(2); }
process.stdout.write(JSON.stringify({ commits: [
  { oid: 'a'.repeat(40), messageHeadline: 'feat: first', messageBody: '', committedDate: '2026-10-01T12:00:00Z' },
  { oid: 'b'.repeat(40), messageHeadline: 'fix: second', messageBody: 'Co-Authored-By: Claude', committedDate: '2026-10-01T12:30:00Z' },
  { oid: 'c'.repeat(40), messageHeadline: 'chore: no date', messageBody: '' },
] }));
`, { mode: 0o700 });
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${join(dir, 'bin')}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the time GitHub says each commit was committed, which the quiet period reads', async () => {
    const commits = await new GhStore('owner/repo').pullCommits(7);
    assert.deepEqual(commits.map((c) => [c.oid.slice(0, 1), c.committedDate]), [['a', '2026-10-01T12:00:00Z'], ['b', '2026-10-01T12:30:00Z'], ['c', undefined]]);
    assert.match(commits[1]!.message, /Co-Authored-By: Claude/);
    assert.equal('committedDate' in commits[2]!, false, 'a commit GitHub gave no date is not given an empty one');
  });
});

describe('who applied a label', () => {
  let dir: string;
  let originalPath: string | undefined;
  const event = (name: string, label: string, actor: string | null) => ({ event: name, label: { name: label }, actor: actor === null ? null : { login: actor } });
  /** gh pages its events; the fake runs the caller's jq over each page, as `gh api --paginate --jq` does. */
  const respond = (pages: unknown[][], error = '') => writeFileSync(join(dir, 'response.json'), JSON.stringify({ pages, error }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-gh-label-actor-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'response.json'))}, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(dir, 'arguments.jsonl'))}, JSON.stringify(args) + '\\n');
if (data.error) { console.error(data.error); process.exit(1); }
if (args[0] !== 'api' || !args.includes('--paginate') || !args.includes('--jq')) { console.error('unexpected gh command'); process.exit(2); }
const jq = args[args.indexOf('--jq') + 1];
for (const page of data.pages) {
  const result = spawnSync('/usr/bin/jq', ['-c', jq], { input: JSON.stringify(page), encoding: 'utf8' });
  if (result.error || result.status !== 0) { console.error(result.stderr || String(result.error)); process.exit(2); }
  process.stdout.write(result.stdout);
}
`, { mode: 0o700 });
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${join(dir, 'bin')}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the actor of the newest labeled event for that label, across pages, past other labels and removals', async () => {
    respond([
      [event('labeled', 'apply-comment', 'first-person'), event('labeled', 'auto', 'someone-else'), event('commented', 'apply-comment', 'noise')],
      [event('unlabeled', 'apply-comment', 'first-person'), event('labeled', 'apply-comment', 'octocat'), event('labeled', 'loop:stopped', 'octocat')],
    ]);
    assert.equal(await new GhStore('owner/repo').labelActor(750, 'apply-comment'), 'octocat');
    const [call] = readFileSync(join(dir, 'arguments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.equal(call![1], 'repos/owner/repo/issues/750/events');
  });

  it('is undefined where no event applied the label, or its actor is gone', async () => {
    respond([[event('labeled', 'auto', 'octocat'), event('unlabeled', 'apply-comment', 'octocat')]]);
    assert.equal(await new GhStore('owner/repo').labelActor(750, 'apply-comment'), undefined);
    respond([[event('labeled', 'apply-comment', null)]]);
    assert.equal(await new GhStore('owner/repo').labelActor(750, 'apply-comment'), undefined);
  });

  it('is undefined where the actor is not a login string', async () => {
    respond([[{ event: 'labeled', label: { name: 'apply-comment' }, actor: { login: 42 } }]]);
    assert.equal(await new GhStore('owner/repo').labelActor(750, 'apply-comment'), undefined);
  });

  it('throws where the history cannot be read, which is not the same as nobody having applied it', async () => {
    respond([], 'HTTP 502: Bad Gateway');
    await assert.rejects(() => new GhStore('owner/repo').labelActor(750, 'apply-comment'), /HTTP 502/);
  });
});
