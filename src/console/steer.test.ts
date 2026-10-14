import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { FIXTURE_FLOOR } from '../loop/testkit.js';
import { createCoordinatorCommands } from '../commands.js';
import { OPERATOR, sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { GitRepo } from '../loop/git.js';
import { fixtureStoreConfig } from '../loop/testkit.js';
import { createConsoleCommands } from './commands.js';
import { FileStore } from './file-store.js';
import { consoleTarget } from './service.js';
import { applyChange, editTableRow, ProposalRefused } from './steer.js';
import { fixtureTargetRepo, snapshot, writeStoreFile } from './testkit.js';

const CONFIG = fixtureStoreConfig({
  typeRows: ['| `type:bug` | 4 |', '| `type:chore` | 4 |'], defaultRung: 4,
  // Shape lists both families, as the loop's policy does; the other stages keep one row.
  stageRows: [
    '| shape | claude-local | model-shape | low | 1 | 1 |',
    '| shape | pi-local | model-gpt | high | 0 | 1 |',
    '| assess | claude-local | model-assess | low | 1 | 1 |',
    '| sweep | claude-local | model-sweep | low | 1 | 1 |',
    '| fix | claude-local | model-fix | low | 1 | 1 |',
    '| check | claude-local | model-check | low | 1 | 1 |',
  ],
});

let box: Sandbox;
let dir: string;
let origin: string;
let target: string;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  box = sandbox(); writeFloor(FIXTURE_FLOOR);
  dir = mkdtempSync(join(tmpdir(), 'console-steer-'));
  ({ path: target, origin } = fixtureTargetRepo(dir, CONFIG));
});
afterEach(() => {
  box.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function consoleOver() {
  const storePath = join(dir, 'store.json');
  writeStoreFile(storePath, snapshot());
  const store = new FileStore(storePath);
  const repo = new GitRepo(target);
  const worktreePaths: string[] = [];
  const addWorktree = repo.addWorktree.bind(repo);
  repo.addWorktree = async (path, ref, branch) => { worktreePaths.push(path); await addWorktree(path, ref, branch); };
  const commands = createConsoleCommands({
    target: await consoleTarget(repo, store), store, git: repo, coordinator: createCoordinatorCommands(),
    mergeStage: () => Promise.reject(new Error('not in this test')),
  });
  return { commands, store, storePath, worktreePaths };
}

const branches = (): string[] => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

describe('a stop-line change becomes a pull request to dev, shown as proposed until merged', () => {
  it('commits only the table row on one branch, opens one PR against dev with old, new and who, and leaves dev alone', async () => {
    const devBefore = git(origin, 'rev-parse', 'dev');
    const { commands, store, worktreePaths } = await consoleOver();

    const result = await commands.propose(OPERATOR, { kind: 'stop-line', label: 'type:chore', value: 5 });
    assert.equal(result.branch, 'console/stop-line-type-chore');
    assert.equal(worktreePaths.length, 1);
    assert.match(worktreePaths[0]!, /^\/var\/tmp\/agentsys-workers-[^/]+\/[a-f0-9]{20}\/console-stop-line-type-chore$/);
    assert.ok(!worktreePaths[0]!.startsWith(target), 'a target checkout is not nested below the controller');
    assert.equal(result.opened, true);
    assert.deepEqual([result.live, result.proposed], ['4', '5']);

    assert.equal(git(origin, 'rev-parse', 'dev'), devBefore, 'dev is untouched');
    assert.deepEqual(branches(), ['console/stop-line-type-chore', 'dev', 'main'], 'exactly one PR-shaped branch exists for the change');
    assert.equal(git(origin, 'rev-list', '--count', 'dev..console/stop-line-type-chore'), '1', 'one commit');
    const diff = git(origin, 'diff', '-U0', 'dev', 'console/stop-line-type-chore');
    const changed = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(changed, ['-| `type:chore` | 4 |', '+| `type:chore` | 5 |'], 'the diff touches only that row of the Stop-lines table');
    assert.deepEqual(git(origin, 'diff', '--name-only', 'dev', 'console/stop-line-type-chore').split('\n'), ['tickets/store-config.md']);

    const pulls = await store.listOpenPulls();
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]!.baseRefName, 'dev');
    assert.equal(pulls[0]!.headRefName, 'console/stop-line-type-chore');
    const file = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as { writes: Array<{ kind: string; detail?: string }> };
    assert.deepEqual(file.writes.map((w) => w.kind), ['pull']);

    const view = await commands.view();
    const chore = view.policy.stopLines.find((r) => r.key === 'type:chore')!;
    assert.equal(chore.live, '4');
    assert.deepEqual(chore.proposed, { value: '5', pr: result.pr, branch: 'console/stop-line-type-chore' });
  });

  it('a second change to the same row updates the same pull request rather than opening another', async () => {
    const { commands, store } = await consoleOver();
    const first = await commands.propose(OPERATOR, { kind: 'stop-line', label: 'type:chore', value: 5 });
    const second = await commands.propose(OPERATOR, { kind: 'stop-line', label: 'type:chore', value: 6 });
    assert.equal(second.pr, first.pr);
    assert.equal(second.opened, false);
    assert.equal((await store.listOpenPulls()).length, 1);
    assert.deepEqual(branches(), ['console/stop-line-type-chore', 'dev', 'main']);
    assert.equal(git(origin, 'show', 'console/stop-line-type-chore:tickets/store-config.md').includes('| `type:chore` | 6 |'), true);
    const changed = git(origin, 'diff', '-U0', 'dev', 'console/stop-line-type-chore').split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(changed, ['-| `type:chore` | 4 |', '+| `type:chore` | 6 |']);
  });

  it('shows the value live once the pull request is merged', async () => {
    const { commands, store, storePath } = await consoleOver();
    const result = await commands.propose(OPERATOR, { kind: 'stop-line', label: 'type:chore', value: 5 });
    // A person merges it on GitHub: the branch lands on dev and the pull request closes.
    git(target, 'fetch', '--quiet', 'origin');
    git(target, 'push', '--quiet', 'origin', 'origin/console/stop-line-type-chore:refs/heads/dev');
    const file = JSON.parse(readFileSync(storePath, 'utf8')) as { pulls: unknown[]; referencedPulls: unknown[] };
    file.referencedPulls.push({ ...(file.pulls[0] as object), state: 'MERGED' });
    file.pulls = [];
    writeFileSync(storePath, JSON.stringify(file));
    assert.equal((await store.listOpenPulls()).length, 0);
    const chore = (await commands.view()).policy.stopLines.find((r) => r.key === 'type:chore')!;
    assert.equal(chore.live, '5');
    assert.equal(chore.proposed, undefined, `PR #${result.pr} is no longer a proposal`);
  });

  it('refuses a change to what the file already says, leaving no branch', async () => {
    const { commands } = await consoleOver();
    await assert.rejects(commands.propose(OPERATOR, { kind: 'stop-line', label: 'type:chore', value: 4 }), ProposalRefused);
    assert.deepEqual(branches(), ['dev', 'main'], 'a refused proposal leaves no branch behind');
  });

  it('refuses anyone but the configured operator', async () => {
    const { commands } = await consoleOver();
    await assert.rejects(commands.propose({ kind: 'agent', id: 'run_x' }, { kind: 'stop-line', label: 'type:chore', value: 5 }), /cannot issue or change authority/);
    assert.deepEqual(branches(), ['dev', 'main']);
  });

  it('a tier change edits only the row for its stage and runtime, on a branch of its own', async () => {
    const { commands } = await consoleOver();
    const result = await commands.propose(OPERATOR, { kind: 'tier', stage: 'shape', runtime: 'claude-local', model: 'model-x', effort: 'high', fiveHourPercent: 0, weeklyPercent: 2 });
    assert.equal(result.branch, 'console/tier-shape-claude-local');
    const changed = git(origin, 'diff', '-U0', 'dev', 'console/tier-shape-claude-local').split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(changed, ['-| shape | claude-local | model-shape | low | 1 | 1 |', '+| shape | claude-local | model-x | high | 0 | 2 |']);
  });

  it('a change to the same stage on its other runtime edits that row and leaves the first proposal alone', async () => {
    const { commands } = await consoleOver();
    await commands.propose(OPERATOR, { kind: 'tier', stage: 'shape', runtime: 'claude-local', model: 'model-x', effort: 'high', fiveHourPercent: 0, weeklyPercent: 2 });
    const second = await commands.propose(OPERATOR, { kind: 'tier', stage: 'shape', runtime: 'pi-local', model: 'model-y', effort: 'max', fiveHourPercent: 0, weeklyPercent: 3 });
    assert.equal(second.branch, 'console/tier-shape-pi-local');
    const changed = git(origin, 'diff', '-U0', 'dev', 'console/tier-shape-pi-local').split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(changed, ['-| shape | pi-local | model-gpt | high | 0 | 1 |', '+| shape | pi-local | model-y | max | 0 | 3 |']);
    assert.ok(branches().includes('console/tier-shape-claude-local'), 'the first proposal is still open');
  });

  it('a change naming a runtime the stage has no row for adds that row after the stage\'s last row', async () => {
    const { commands } = await consoleOver();
    await commands.propose(OPERATOR, { kind: 'tier', stage: 'assess', runtime: 'pi-local', model: 'model-gpt', effort: 'high', fiveHourPercent: 0, weeklyPercent: 1 });
    const diff = git(origin, 'diff', '-U1', 'dev', 'console/tier-assess-pi-local').split('\n').filter((l) => /^[ +-][^+-]/.test(l));
    assert.deepEqual(diff, [' | assess | claude-local | model-assess | low | 1 | 1 |', '+| assess | pi-local | model-gpt | high | 0 | 1 |', ' | sweep | claude-local | model-sweep | low | 1 | 1 |']);
  });

  it('lists every row of every stage, one per runtime, with the row\'s live value', async () => {
    const { commands } = await consoleOver();
    const { tiers } = (await commands.view()).policy;
    assert.deepEqual(tiers.map((t) => [t.key, t.stage, t.live]), [
      ['shape · claude-local', 'shape', 'claude-local · model-shape · low · 1% · 1%'],
      ['shape · pi-local', 'shape', 'pi-local · model-gpt · high · 0% · 1%'],
      ['assess · claude-local', 'assess', 'claude-local · model-assess · low · 1% · 1%'],
      ['sweep · claude-local', 'sweep', 'claude-local · model-sweep · low · 1% · 1%'],
      ['fix · claude-local', 'fix', 'claude-local · model-fix · low · 1% · 1%'],
      ['check · claude-local', 'check', 'claude-local · model-check · low · 1% · 1%'],
    ]);
  });

  it('shows an open tier proposal against its own row only', async () => {
    const { commands } = await consoleOver();
    const result = await commands.propose(OPERATOR, { kind: 'tier', stage: 'shape', runtime: 'pi-local', model: 'model-y', effort: 'max', fiveHourPercent: 0, weeklyPercent: 3 });
    const rows = Object.fromEntries((await commands.view()).policy.tiers.map((t) => [t.key, t.proposed]));
    assert.equal(rows['shape · claude-local'], undefined);
    assert.deepEqual(rows['shape · pi-local'], { value: 'pi-local · model-y · max · 0% · 3%', pr: result.pr, branch: 'console/tier-shape-pi-local' });
  });
});

describe('table edits', () => {
  it('adds a type row above the default, keeps CRLF files CRLF, and refuses a missing heading', () => {
    const added = applyChange(CONFIG, { kind: 'stop-line', label: 'type:docs', value: 2 });
    assert.match(added, /\| `type:chore` \| 4 \|\n\| `type:docs` \| 2 \|\n\| default — anything else \| 4 \|/);
    assert.match(applyChange(CONFIG, { kind: 'stop-line', label: 'default', value: 3 }), /\| default — anything else \| 3 \|/);
    const crlf = applyChange(CONFIG.replace(/\n/g, '\r\n'), { kind: 'limit', setting: 'improve minimum sample', value: '10' });
    assert.match(crlf, /\| status home \| effort:home \|\r\n\| close merged tickets labelled \| auto \|\r\n\| improve minimum sample \| 10 \|\r\n/);
    assert.throws(() => editTableRow('# nothing', 'Stage tiers', () => true, '| x |'), ProposalRefused);
  });
});
