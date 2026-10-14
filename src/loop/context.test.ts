import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { card } from '../console/testkit.js';
import { sandbox } from '../core/testkit.js';
import { saveScorecard } from '../eval/scorecard.js';
import { outputPath, readOutput, worktreeDir } from './context.js';
import { GitRepo } from './git.js';
import { runPass } from './pass.js';
import { promptDigest, promptTemplate } from './prompts.js';
import type { PassContext } from './types.js';
import { completed, FakeCommands, FakeRepo, FakeStore, fixtureRules, fixtureStoreConfig, outputFileIn } from './testkit.js';

it('real target worktrees cannot inherit controller tooling, across every worktree role', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-isolation-'));
  const target = join(root, 'target');
  const controller = join(root, 'controller');
  const stateDir = join(controller, '.state', 'loop', 'target');
  mkdirSync(target, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(controller, 'node_modules', 'controller-only-tool'), { recursive: true });
  writeFileSync(join(controller, 'node_modules', 'controller-only-tool', 'index.js'), 'module.exports = true;');
  writeFileSync(join(controller, 'eslint.config.mjs'), 'export default [{rules:{"no-unused-vars":"error"}}];');
  // A legacy target intentionally has no flat config. ESLint must report its own
  // missing configuration, not run with the controller's unrelated flat config.
  writeFileSync(join(target, '.eslintrc.json'), '{"root":true}');
  writeFileSync(join(target, 'sample.js'), 'const unused = 1;\n');
  writeFileSync(join(target, 'tooling.test.cjs'), `const assert = require('node:assert/strict');\nassert.throws(() => require.resolve('controller-only-tool'), /Cannot find module/);\nassert.equal(require('node:fs').readFileSync('test_assets/data.txt','utf8'), 'kept');\n`);
  mkdirSync(join(target, 'test_assets'));
  writeFileSync(join(target, 'test_assets', 'data.txt'), 'kept');
  const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'target');
  const repo = new GitRepo(target);
  const ctx = { stateDir } as PassContext;
  const eslint = fileURLToPath(new URL('../../node_modules/eslint/bin/eslint.js', import.meta.url));
  const check = (cwd: string) => {
    const test = spawnSync(process.execPath, ['--test', 'tooling.test.cjs'], { cwd, encoding: 'utf8' });
    const lint = spawnSync(process.execPath, [eslint, 'sample.js'], { cwd, encoding: 'utf8' });
    return { test: test.status, lint: lint.status, ownConfigMissing: /couldn't find an eslint.config/.test(lint.stderr) };
  };
  const expected = check(target);
  assert.deepEqual(expected, { test: 0, lint: 2, ownConfigMissing: true });
  const contaminated = join(stateDir, 'worktrees', 'old-review');
  await repo.addWorktree(contaminated, 'HEAD');
  assert.notDeepEqual(check(contaminated), expected, 'the conflicting ancestor really changes target commands');
  writeFileSync(join(contaminated, 'retained-output.txt'), 'old evidence');
  const dirs: string[] = [];
  try {
    for (const name of ['shape-1', 'assess-1', 'sweep-1', 'review-1', 'fix-1', 'merge-1', 'verify-tools', 'proposal-1']) {
      const dir = worktreeDir(ctx, name); dirs.push(dir);
      assert.ok(!resolve(dir).startsWith(resolve(controller) + '/'));
      await repo.addWorktree(dir, 'HEAD');
      assert.deepEqual(check(dir), expected, name);
      assert.ok(existsSync(join(dir, '.eslintrc.json')));
      assert.equal(readFileSync(join(dir, 'test_assets', 'data.txt'), 'utf8'), 'kept');
    }
    // Also exercise a target with its own supported flat config: real lint and
    // tests pass both standalone and through the same production worktree path.
    writeFileSync(join(target, 'eslint.config.mjs'), 'export default [{rules:{"no-unused-vars":"off"}}];');
    git('add', 'eslint.config.mjs');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'target-owned flat configuration');
    const supported = check(target);
    assert.deepEqual(supported, { test: 0, lint: 0, ownConfigMissing: false });
    for (const dir of dirs) {
      await repo.addWorktree(dir, 'HEAD');
      assert.deepEqual(check(dir), supported);
    }
    assert.equal(readFileSync(join(contaminated, 'retained-output.txt'), 'utf8'), 'old evidence');
  } finally {
    for (const dir of dirs) await repo.removeWorktree(dir);
    await repo.removeWorktree(contaminated);
    if (dirs[0]) rmSync(dirname(dirs[0]), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ['prompt', 'tier'] as const) {
  it(`the improve stage proposes a ${kind} change without inheriting controller tooling`, async () => {
    const box = sandbox();
    const controller = box.root;
    const scratch = mkdtempSync(join(tmpdir(), 'improve-isolation-'));
    mkdirSync(join(controller, 'node_modules', 'controller-only-tool'), { recursive: true });
    writeFileSync(join(controller, 'node_modules', 'controller-only-tool', 'index.js'), 'module.exports = true;');
    writeFileSync(join(controller, 'eslint.config.mjs'), 'export default [{rules:{"no-unused-vars":"error"}}];');
    const config = fixtureStoreConfig()
      .replace('| status home | effort:home |', '| status home | effort:home |\n| improve minimum sample | 1 |\n| improve interval hours | 24 |\n| improve rank by | explicit-not-accepted |')
      .replace('| check | claude-local | model-check | low | 1 | 1 |', '| check | claude-local | model-check | low | 1 | 1 |\n| improve | claude-local | model-improve | low | 1 | 1 |');
    const worktrees: string[] = [];
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    class CheckedGit extends GitRepo {
      override async commitFile(dir: string, file: string, message: string): Promise<string> {
        worktrees.push(dir);
        assert.ok(!resolve(dir).startsWith(resolve(controller) + '/'), 'proposal checkout is outside controller ancestors');
        const node = spawnSync(process.execPath, ['-e', "require.resolve('controller-only-tool')"], { cwd: dir, encoding: 'utf8' });
        assert.notEqual(node.status, 0, 'the controller-only Node package is not visible at commit time');
        assert.match(node.stderr, /Cannot find module/);
        const eslint = fileURLToPath(new URL('../../node_modules/eslint/bin/eslint.js', import.meta.url));
        const lint = spawnSync(process.execPath, [eslint, 'sample.js'], { cwd: dir, encoding: 'utf8' });
        assert.equal(lint.status, 2, 'the checkout does not inherit the controller ESLint config');
        assert.match(lint.stderr, /couldn't find an eslint.config/);
        return super.commitFile(dir, file, message);
      }
    }
    const makeRepo = (name: string, files: Record<string, string>) => {
      const path = join(scratch, name);
      const origin = join(scratch, `${name}.git`);
      mkdirSync(path, { recursive: true });
      git(scratch, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
      git(path, 'init', '--quiet', '--initial-branch=main');
      git(path, 'config', 'user.name', 'Fixture');
      git(path, 'config', 'user.email', 'fixture@example.test');
      git(path, 'config', 'commit.gpgsign', 'false');
      git(path, 'remote', 'add', 'origin', origin);
      for (const [file, contents] of Object.entries(files)) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), contents);
      }
      writeFileSync(join(path, '.eslintrc.json'), '{"root":true}');
      writeFileSync(join(path, 'sample.js'), 'const unused = 1;\n');
      git(path, 'add', '.');
      git(path, 'commit', '--quiet', '-m', 'fixture');
      git(path, 'push', '--quiet', 'origin', 'main');
      return { path, origin, repo: new CheckedGit(path) };
    };
    try {
      const target = makeRepo('target', { 'tickets/store-config.md': config });
      git(target.path, 'branch', 'dev');
      git(target.path, 'push', '--quiet', 'origin', 'dev');
      const coordinator = makeRepo('coordinator', { 'src/loop/prompts/review.md': promptTemplate('review') });
      const stage = kind === 'prompt' ? 'review' : 'fix';
      saveScorecard(card(`card_loop-${stage}-fixture`, { stage, item: 'PR #12', workType: 'bug' }, {
        runtime: 'pi-local',
        settings: { requested: { model: 'm', effort: 'high' }, resolved: { model: 'm', effort: 'high' }, observed: { model: 'm', effort: 'high' }, prompt: { template: stage, digest: promptDigest(stage) } },
        feedback: { verdict: 'rejected', by: 'fixture', reason: 'needs improvement', at: 't' },
      }));
      const commands = new FakeCommands((input) => {
        const out = outputFileIn(input.prompt)!;
        writeFileSync(out, JSON.stringify(kind === 'prompt'
          ? { kind, template: `${promptTemplate('review')}\nClarify the review.`, rationale: 'Missing details.' }
          : { kind, tier: { runtime: 'pi-local', model: 'replacement', effort: 'high', fiveHourPercent: 1, weeklyPercent: 2 }, rationale: 'Too many rejected runs.' }));
        return completed(input);
      });
      const store = new FakeStore();
      const coordinatorStore = new FakeStore();
      const report = await runPass({
        repo: new FakeRepo(config), store, commands, rules: fixtureRules(),
        improve: {
          targetGit: target.repo, command: 'fixture improve',
          coordinator: { git: coordinator.repo, store: coordinatorStore, slug: 'fixture/coordinator', base: 'main', path: coordinator.path, commit: git(coordinator.path, 'rev-parse', 'main') },
          pull: () => Promise.resolve({ title: 'fixture', body: '' }),
        },
      }, { dryRun: false, stages: ['improve'] });
      const item = report.stages.find((s) => s.stage === 'improve')?.items[0];
      assert.equal(item?.produced, true, JSON.stringify(item));
      assert.match(item?.result ?? '', /opened https:/, JSON.stringify(item));
      assert.equal(worktrees.length, 1, 'the proposal reached the real git commit path');
      assert.equal((kind === 'prompt' ? coordinatorStore : store).pulls.length, 1);
      const branch = (kind === 'prompt' ? coordinatorStore : store).pulls[0]!.headRefName;
      assert.ok(git(kind === 'prompt' ? coordinator.origin : target.origin, 'rev-parse', branch));
      assert.equal(git(target.origin, 'rev-parse', 'main'), git(target.path, 'rev-parse', 'main'), 'the target base was not edited');
      assert.equal(existsSync(worktrees[0]!), false, 'the proposal worktree is removed after the commit');
    } finally {
      // Remove only this test's isolated namespace, never the legacy state/worktrees tree.
      for (const dir of worktrees) rmSync(dirname(dir), { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
      box.cleanup();
    }
  });
}

it('retry output paths never unlink earlier drafts and interrupted output is not adopted', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'attempt-output-'));
  try {
    const ctx = { stateDir } as PassContext;
    const first = outputPath(ctx, 'same-task-head');
    writeFileSync(first, 'partial review');
    const second = outputPath(ctx, 'same-task-head');
    assert.notEqual(second, first);
    assert.equal(readFileSync(first, 'utf8'), 'partial review');
    const result = completed({ taskId: 'same-task-head', runtime: 'pi-local', settings: {}, actions: ['review'] } as Parameters<typeof completed>[0]);
    result.outcome.kind = 'checks-failed';
    assert.equal(readOutput(first, result), undefined);
    result.outcome.kind = 'completed';
    assert.equal(readOutput(first, result), 'partial review', 'a settled runtime is necessary, not itself proof of delivery');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
