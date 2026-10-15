import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DispatchTaskInput } from '../commands.js';
import { card } from '../console/testkit.js';
import { verdictsFor } from '../console/verdicts.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { freezeIncidentCase } from '../eval/cases.js';
import { listTrials } from '../eval/oracle.js';
import type { Scorecard } from '../eval/scorecard.js';
import { saveScorecard } from '../eval/scorecard.js';
import { writeFloor } from '../core/floor.js';
import { GitRepo } from './git.js';
import { runPass } from './pass.js';
import { improveDeps } from './runner.js';
import { parseStoreConfig } from './policy.js';
import { promptDigest, promptDigestOf, promptTemplate } from './prompts.js';
import { improveBranch, improveSettings, knobRows, parseDraft, rankKnobs, renderRanking } from './stages/improve.js';
import { completed, FakeCommands, FakeRepo, FakeStore, fixtureRules, fixtureStoreConfig, outputFileIn, SHA } from './testkit.js';

let box: Sandbox;
let dir: string;
beforeEach(() => { box = sandbox(); dir = mkdtempSync(join(tmpdir(), 'improve-')); });
afterEach(() => { box.cleanup(); rmSync(dir, { recursive: true, force: true }); });

/** The fixture store configuration with the improve stage's rows: a sample of 10, and a tier to draft on. */
function config(sample = 10): string {
  return fixtureStoreConfig()
    .replace('| status home | effort:home |', `| status home | effort:home |\n| improve minimum sample | ${sample} |\n| improve interval hours | 24 |\n| improve rank by | explicit-not-accepted, derived-not-accepted, escalations, findings, weekly-bound |`)
    .replace('| check | claude-local | model-check | low | 1 | 1 |', '| check | claude-local | model-check | low | 1 | 1 |\n| improve | claude-local | model-improve | low | 1 | 1 |');
}

function reviewCards(n: number, digest: string, rejected: number): Scorecard[] {
  return Array.from({ length: n }, (_, i) => card(`card_loop-review-pr${100 + i}-aa`, { stage: 'review', item: `PR #${100 + i}`, workType: 'bug', head: SHA(`h${i}`), findings: 0, independent: true }, {
    runtime: 'pi-local',
    settings: { requested: { model: 'model-other-1', effort: 'high' }, resolved: { model: 'model-other-1', effort: 'high' }, observed: { model: 'model-other-1', effort: 'high' }, prompt: { template: 'review', digest } },
    reviews: [{ author: 'a', reviewer: { id: 'r', relationship: 'independent', independent: true }, source: 's', head: SHA(`h${i}`), at: 't', findingCount: 1 }],
    ...(i < rejected ? { feedback: { verdict: 'rejected' as const, by: 'octocat', reason: 'missed the unbounded retry', at: 't' } } : {}),
  }));
}

describe('the improve stage names the worst knob, the rule that picked it, and the sample behind it', () => {
  it('reads its rule from the store configuration, and says so when the rows are missing', () => {
    const settings = improveSettings(parseStoreConfig(config()));
    assert.ok(!('missing' in settings));
    assert.equal(settings.minimumSample.value, 10);
    assert.deepEqual(settings.rankBy.value, ['explicit-not-accepted', 'derived-not-accepted', 'escalations', 'findings', 'weekly-bound']);
    assert.match(settings.minimumSample.line, /^tickets\/store-config\.md:\d+: \| improve minimum sample \| 10 \|$/);
    assert.deepEqual(improveSettings(parseStoreConfig(fixtureStoreConfig())), { missing: 'tickets/store-config.md "Loop limits" has no "improve minimum sample", "improve interval hours", "improve rank by" row' });
    assert.throws(() => improveSettings(parseStoreConfig(config().replace('explicit-not-accepted,', 'success-rate,'))), /unknown criteria success-rate/);
  });

  it('with every knob below the sample, a dry run proposes nothing and names N', async () => {
    for (const c of reviewCards(3, promptDigest('review'), 1)) saveScorecard(c);
    const lines: string[] = [];
    const store = new FakeStore();
    const report = await runPass({ repo: new FakeRepo(config()), store, commands: new FakeCommands(), rules: fixtureRules(), log: (l) => lines.push(l) }, { dryRun: true, stages: ['improve'] });
    const text = lines.join('\n');
    assert.match(text, /no proposal: sample below N for every knob \(N = 10, tickets\/store-config\.md:\d+: \| improve minimum sample \| 10 \|\)/);
    assert.match(text, /review · pi-local\/model-other-1\/high · [0-9a-f]{12}\s+3\s+0\/0\/0\s+0\/0\/1/);
    assert.match(text, /\| improve rank by \| explicit-not-accepted, derived-not-accepted/);
    assert.equal(report.stages.find((s) => s.stage === 'improve')?.counts.queue, 0);
    assert.deepEqual(store.writes, []);
  });

  it('ranks by the rule with derived and explicit counts apart, and a prompt edit starts a new knob with no migration', () => {
    const policy = parseStoreConfig(config(2));
    const edited = promptDigestOf(`${promptTemplate('review')}\nOne more line.`);
    const cards = [...reviewCards(3, promptDigest('review'), 2), ...reviewCards(3, edited, 0).map((c) => ({ ...c, id: `${c.id}-b` }))];
    const rows = knobRows(cards, verdictsFor(cards, undefined), policy);
    assert.equal(rows.length, 2, 'the same stage and tier under two prompt digests are two knobs');
    const settings = improveSettings(policy);
    assert.ok(!('missing' in settings));
    const { pick } = rankKnobs(rows, settings);
    assert.equal(pick?.digest, promptDigest('review'));
    assert.deepEqual(pick?.explicit, { accepted: 0, 'rework-needed': 0, rejected: 2 });
    const printed = renderRanking(rows, settings).join('\n');
    assert.doesNotMatch(printed, /%\s*(accept|reject)|rate/i);
  });

  it('counts only runs that reached a runtime: an admission refusal is not part of the sample', () => {
    const policy = parseStoreConfig(config());
    const [c] = reviewCards(1, promptDigest('review'), 0);
    const refused = { ...c!, runIds: ['run_a', 'run_b', 'run_c'] };
    const rows = knobRows([refused], [], policy, (id) => (id === 'run_c' ? 'completed' : 'quota-waiting'));
    assert.equal(rows[0]!.runs, 1);
  });
});

describe('a real pass opens exactly one pull request with its evidence, and edits no live configuration', () => {
  function coordinatorRepo(): { path: string; origin: string } {
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const origin = join(dir, 'coordinator.git');
    const path = join(dir, 'coordinator');
    mkdirSync(join(path, 'src', 'loop', 'prompts'), { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(path, 'init', '--quiet', '--initial-branch=main');
    for (const [k, v] of [['user.name', 'Fixture'], ['user.email', 'f@example.test'], ['commit.gpgsign', 'false']]) git(path, 'config', k!, v!);
    git(path, 'remote', 'add', 'origin', 'https://github.com/fixture/coordinator.git');
    git(path, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/fixture/coordinator.git');
    git(path, 'config', 'remote.origin.pushurl', origin);
    writeFileSync(join(path, 'src', 'loop', 'prompts', 'review.md'), promptTemplate('review'), 'utf8');
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', 'coordinator');
    git(path, 'push', '--quiet', 'origin', 'main');
    return { path, origin };
  }

  // Holds the decision in docs/adr/20260918-local-console-and-proposing-improve.md.
  it('drafts a prompt edit, replays the frozen case before and after, and opens then updates one pull request', async () => {
    for (const c of reviewCards(10, promptDigest('review'), 3)) saveScorecard(c);
    freezeIncidentCase({
      kind: 'reviewer-detects-bad-candidate', expected: 'defect-reported', words: 'the review flags the unbounded retry', subject: 'PR #659',
      pins: { pr: '659', head: SHA('659'), base: SHA('base'), defectPattern: 'sync.ts' }, by: 'octocat',
    });
    const { path, origin } = coordinatorRepo();
    const mainBefore = execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    const drafted = promptTemplate('review').replace('What to judge, in order:', 'What to judge, in order (retry loops need a bound):');
    const commands = new FakeCommands((input: DispatchTaskInput) => {
      const out = outputFileIn(input.prompt)!;
      if (input.workClass === 'loop-improve') writeFileSync(out, JSON.stringify({ kind: 'prompt', template: drafted, rationale: 'Three reviews were rejected for missing unbounded retries.' }));
      // The drafted prompt catches the defect; the current one does not.
      else writeFileSync(out, input.prompt.includes('retry loops need a bound') ? '1. [high] web/sync.ts retries without a bound\n' : '1. [low] a typo\n');
      return completed(input);
    });
    const coordinatorStore = new FakeStore();
    const git = new GitRepo(path);
    const repo = new FakeRepo(config());
    const pass = () => runPass({
      repo, store: new FakeStore(), commands, rules: fixtureRules(),
      improve: {
        targetGit: git, command: 'agentsys loop --once --stage improve --repo /fixture (in /fixture)',
        coordinator: { git, store: coordinatorStore, slug: 'fixture/coordinator', base: 'main', path, commit: mainBefore },
        pull: () => Promise.resolve({ title: 'feat(sync): retry a failed upload', body: '' }),
      },
    }, { dryRun: false, stages: ['improve'] });

    const first = await pass();
    const improve = first.stages.find((s) => s.stage === 'improve')!;
    assert.equal(improve.counts.produced, 1, improve.items.map((i) => i.result).join('; '));
    assert.equal(coordinatorStore.pulls.length, 1);
    const pr = coordinatorStore.pulls[0]!;
    assert.equal(pr.baseRefName, 'main');
    const branch = improveBranch({ stage: 'review', runtime: 'pi-local', model: 'model-other-1', effort: 'high', digest: promptDigest('review') } as never);
    assert.equal(pr.headRefName, branch);
    for (const needle of ['### The rule that picked it', '| improve rank by |', 'review · pi-local/model-other-1/high', '0/0/3', '### Trials', 'agentsys replay compare --version incidents-1', 'FAIL     pass', 'Command: `agentsys loop --once --stage improve']) {
      assert.ok(pr.body.includes(needle), `the body carries ${needle}`);
    }
    assert.equal(listTrials().length, 2, 'a before and an after trial are recorded');
    assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), mainBefore, 'main is unchanged');
    assert.equal(execFileSync('git', ['-C', origin, 'show', `${branch}:src/loop/prompts/review.md`], { encoding: 'utf8' }), drafted);
    assert.deepEqual(execFileSync('git', ['-C', origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n').sort(), [branch, 'main'].sort());
    assert.equal(repo.storeConfig, config(), 'the live store configuration is untouched');

    await pass();
    assert.equal(coordinatorStore.pulls.length, 1, 'a second pass updates the same pull request');
    assert.ok(coordinatorStore.writes.some((w) => w.kind === 'update-pull' && w.target === pr.number));
  });

  // Holds the decision in docs/adr/20261014-prompt-proposals-need-a-named-repository.md.
  it('saves a prompt draft in the state directory, and opens nothing, when no coordinator repository is named for proposals', async () => {
    for (const c of reviewCards(10, promptDigest('review'), 3)) saveScorecard(c);
    const drafted = promptTemplate('review').replace('What to judge, in order:', 'What to judge, in order (retry loops need a bound):');
    const commands = new FakeCommands((input: DispatchTaskInput) => {
      writeFileSync(outputFileIn(input.prompt)!, JSON.stringify({ kind: 'prompt', template: drafted, rationale: 'Three reviews were rejected for missing unbounded retries.' }));
      return completed(input);
    });
    const store = new FakeStore();
    const report = await runPass({
      repo: new FakeRepo(config()), store, commands, rules: fixtureRules(),
      improve: { targetGit: new GitRepo(dir), command: 'x', pull: () => Promise.resolve({ title: 't', body: '' }) },
    }, { dryRun: false, stages: ['improve'] });

    const item = report.stages.find((s) => s.stage === 'improve')!.items[0]!;
    assert.match(item.reason, /saved as a draft instead: no prompt proposal repository is named in the floor/);
    const saved = /saved the draft to (\S+);/.exec(item.result ?? '')?.[1];
    assert.ok(saved, item.result);
    assert.equal(readFileSync(join(saved, 'review.md'), 'utf8'), drafted);
    const body = readFileSync(join(saved, 'pull-request.md'), 'utf8');
    for (const needle of ['# improve(loop): the review prompt', '### The rule that picked it', '### Trials']) assert.ok(body.includes(needle), `the draft carries ${needle}`);
    assert.deepEqual(store.writes, [], 'nothing is written to any repository');
  });

  // Holds the decision in docs/adr/20261014-prompt-proposals-need-a-named-repository.md.
  it('proposes prompts in the coordinator\'s own repository only when the floor names it', async () => {
    const { path } = coordinatorRepo();
    const deps = async () => {
      const lines: string[] = [];
      const d = await improveDeps(new GitRepo(dir), 'example-org/larkspur', path, (l) => lines.push(l));
      return { coordinator: d.coordinator?.slug, lines };
    };
    const unnamed = await deps();
    assert.equal(unnamed.coordinator, undefined, 'a fresh floor names no repository');
    assert.ok(unnamed.lines.some((l) => l.includes('saved as drafts, not proposed in fixture/coordinator')), unnamed.lines.join('\n'));
    writeFloor({ prBases: {}, readOnlyProjects: [], promptProposals: 'example-org/somewhere-else' });
    assert.equal((await deps()).coordinator, undefined, 'a floor naming another repository proposes nothing here');
    writeFloor({ prBases: {}, readOnlyProjects: [], promptProposals: 'fixture/coordinator' });
    assert.equal((await deps()).coordinator, 'fixture/coordinator');
  });

  it('drafts on the option of its own stage that can start when the first cannot, and refers to the knob\'s own tier row', async () => {
    for (const c of reviewCards(10, promptDigest('review'), 3)) saveScorecard(c);
    const { path } = coordinatorRepo();
    const mainSha = execFileSync('git', ['-C', path, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    const commands = new FakeCommands((input: DispatchTaskInput) => {
      writeFileSync(outputFileIn(input.prompt)!, 'not a draft');
      return completed(input);
    });
    commands.unready.add('claude-local');
    const git = new GitRepo(path);
    const twoFamilies = config().replace('| improve | claude-local | model-improve | low | 1 | 1 |', '| improve | claude-local | model-improve | low | 1 | 1 |\n| improve | pi-local | gpt-improve | high | 0 | 1 |');
    const lines: string[] = [];
    await runPass({
      repo: new FakeRepo(twoFamilies), store: new FakeStore(), commands, rules: fixtureRules(), log: (l) => lines.push(l),
      improve: { targetGit: git, command: 'x', coordinator: { git, store: new FakeStore(), slug: 'fixture/coordinator', base: 'main', path, commit: mainSha }, pull: () => Promise.resolve({ title: 't', body: '' }) },
    }, { dryRun: false, stages: ['improve'] });
    const improveRun = commands.dispatched.find((d) => d.workClass === 'loop-improve');
    assert.equal(improveRun?.runtime, 'pi-local');
    assert.equal(improveRun?.settings.model, 'gpt-improve');
    assert.ok(lines.some((l) => l.startsWith('choice improve knob ') && l.includes('ran gpt-improve·high on pi-local')));
  });
});

describe('a draft that does not fit is refused before anything is written', () => {
  const current = promptTemplate('review');
  const tier = (t: Record<string, unknown>) => JSON.stringify({ kind: 'tier', tier: { runtime: 'pi-local', model: 'm', effort: 'high', fiveHourPercent: 0, weeklyPercent: 2, ...t }, rationale: 'because' });
  it('refuses each malformed shape with its reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['the review is fine', /not a JSON object/],
      [JSON.stringify({ kind: 'prompt', template: current, rationale: 'r' }), /empty or unchanged/],
      [JSON.stringify({ kind: 'prompt', template: current.replace('{{workContext}}', ''), rationale: 'r' }), /changes the placeholders/],
      [JSON.stringify({ kind: 'prompt', template: `${current}\nmore`, rationale: '' }), /no rationale/],
      [tier({ runtime: 'openai-cloud' }), /does not name a runtime/],
      [tier({ fiveHourPercent: 120 }), /whole-number bounds/],
      [tier({ weeklyPercent: 1.5 }), /whole-number bounds/],
      [JSON.stringify({ kind: 'policy', rationale: 'r' }), /kind is policy/],
    ];
    for (const [text, reason] of cases) assert.throws(() => parseDraft(text, current), reason, text.slice(0, 60));
  });
  it('accepts a well-formed draft of each kind', () => {
    assert.equal(parseDraft(JSON.stringify({ kind: 'prompt', template: `${current}\nmore`, rationale: 'r' }), current).kind, 'prompt');
    assert.equal(parseDraft(`Here it is:\n${tier({})}`, current).kind, 'tier');
  });
});
