import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { Scorecard } from '../eval/scorecard.js';

const run = promisify(execFile);

/**
 * Drive the built CLI as a subprocess.
 *
 * Calling the exported `main` in-process would miss argument parsing, exit codes
 * and the module's own top-level wiring — the parts an operator actually meets.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'main.js');

let state = '';

async function agentsys(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, AGENTSYS_STATE: state },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'agentsys-cli-'));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

const OP = 'operator@example.test';
const REPO = 'mocraimer/agent-system';
const HEAD1 = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);

function seedScorecard(id = 'card_evidence', repo = REPO): Scorecard {
  const card: Scorecard = {
    id, taskId: id.slice(5), repo, workClass: 'ci-repair',
    authority: { type: 'approval', id: 'apv_fixture', version: 1 },
    runtime: 'pi-local', profile: 'default',
    settings: {
      requested: { model: 'fixture', effort: 'high' }, resolved: { model: 'fixture', effort: 'high' },
      observed: { model: 'fixture', effort: 'high' },
    },
    workflowVersion: 'test-fixture', attempts: 1, runIds: ['run_fixture'], manifestPaths: [],
    checks: [], reviewerFindings: [], repairs: [], usage: {}, blockers: [], finalStatus: 'completed',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  mkdirSync(join(state, 'scorecards'), { recursive: true });
  writeFileSync(join(state, 'scorecards', `${id}.json`), JSON.stringify(card));
  return card;
}

function storedScorecard(): Scorecard {
  return JSON.parse(readFileSync(join(state, 'scorecards', 'card_evidence.json'), 'utf8')) as Scorecard;
}

const reviewArgs = [
  'scorecards', 'review', '--scorecard', 'card_evidence', '--author', 'author-session', '--reviewer', 'review-session',
  '--relationship', 'independent', '--source', 'code-bugs/report.md', '--head', HEAD1, '--as', OP,
];

describe('evaluation evidence through the real CLI', () => {
  it('leaves old empty cards not-reviewed and shows missing checks honestly', async () => {
    const original = seedScorecard();
    const result = await agentsys('scorecards');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /card_evidence task=evidence/);
    assert.match(result.stdout, /checks: not recorded \(not verified\)/);
    assert.match(result.stdout, /review: not-reviewed; independent review: not-reviewed/);
    assert.doesNotMatch(result.stdout, /reviewed, no findings|clean|ACCEPTED/);
    assert.deepEqual(storedScorecard(), original);
  });

  it('records and reports checks, review findings, repairs and feedback across processes', async () => {
    await agentsys('init', '--operator', OP);
    seedScorecard();
    const findings = join(state, 'findings.json');
    writeFileSync(findings, JSON.stringify([{ severity: 'high', summary: 'failed check history was lost' }]));
    for (const args of [
      ['scorecards', 'check', '--scorecard', 'card_evidence', '--name', 'unit', '--outcome', 'failed', '--source', 'unit/1', '--head', HEAD1, '--as', OP],
      [...reviewArgs, '--findings', findings],
      ['scorecards', 'repair', '--scorecard', 'card_evidence', '--trigger', 'review-finding', '--detail', 'preserve earlier checks', '--head', HEAD2, '--as', OP],
      ['scorecards', 'check', '--scorecard', 'card_evidence', '--name', 'unit', '--outcome', 'passed', '--source', 'unit/2', '--head', HEAD2, '--as', OP],
      [...reviewArgs, '--head', HEAD2, '--no-findings'],
      ['feedback', '--scorecard', 'card_evidence', '--verdict', 'accepted', '--reason', 'operator inspected', '--as', OP],
    ]) {
      const result = await agentsys(...args);
      assert.equal(result.code, 0, result.stderr);
    }
    const result = await agentsys('scorecards');
    assert.equal(result.code, 0, result.stderr);
    for (const text of ['unit: failed', 'unit: passed', 'reviewed, 1 finding(s)',
      '[high] failed check history was lost', 'reviewer=review-session', 'independent=true',
      'author=author-session', 'source=code-bugs/report.md', `head=${HEAD1}`, `head=${HEAD2}`, 'reviewed, no findings',
      'review-finding: preserve earlier checks', 'failed checks:1', '"accepted":1',
      'not a success rate', 'not acceptance of the current head']) assert.ok(result.stdout.includes(text), text);
    const card = storedScorecard();
    assert.equal(card.checks.length, 2);
    assert.equal(card.reviewerFindings.length, 1);
    assert.equal(card.reviewerFindings[0]?.head, HEAD1);
    assert.deepEqual(card.reviews?.map((review) => review.head), [HEAD1, HEAD2]);
    assert.equal(card.repairs.length, 1);
    assert.deepEqual(card.usage, {});
  });

  it('requires an explicit completed review and distinguishes independent no-findings from self-review', async () => {
    await agentsys('init', '--operator', OP);
    seedScorecard();
    const missing = await agentsys(...reviewArgs);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /exactly one/);
    const self = await agentsys(...reviewArgs, '--reviewer', 'author-session', '--relationship', 'author', '--no-findings');
    assert.equal(self.code, 0, self.stderr);
    const selfReport = await agentsys('scorecards');
    assert.match(selfReport.stdout, /reviewed, no findings/);
    assert.match(selfReport.stdout, /independent review: not-reviewed/);
    assert.match(selfReport.stdout, /independent=false/);
    const independent = await agentsys(...reviewArgs, '--no-findings');
    assert.equal(independent.code, 0, independent.stderr);
    assert.match((await agentsys('scorecards')).stdout, /independent review: reviewed/);
    assert.equal(storedScorecard().reviews?.length, 2);
    assert.deepEqual(storedScorecard().reviewerFindings, []);
  });

  it('rejects contradictory attribution and malformed findings without partial writes or stacks', async () => {
    await agentsys('init', '--operator', OP);
    const original = seedScorecard();
    const path = join(state, 'bad-findings.json');
    for (const contents of ['not json', '{}', 'null', '[{"severity":"high","summary":"ok"},{"severity":"unknown","summary":"bad"}]']) {
      writeFileSync(path, contents);
      const result = await agentsys(...reviewArgs, '--findings', path);
      assert.equal(result.code, 2, result.stderr);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
      assert.deepEqual(storedScorecard(), original);
    }
    const same = await agentsys(...reviewArgs, '--reviewer', ' AUTHOR-SESSION ', '--no-findings');
    assert.equal(same.code, 2);
    assert.match(same.stderr, /author cannot be an independent reviewer/);
    const both = await agentsys(...reviewArgs, '--findings', path, '--no-findings');
    assert.equal(both.code, 2);
    assert.match(both.stderr, /exactly one/);
    assert.deepEqual(storedScorecard(), original);
  });

  it('rejects missing cards, invalid checks/repairs and the wrong operator', async () => {
    await agentsys('init', '--operator', OP);
    const original = seedScorecard();
    for (const args of [
      ['scorecards', 'check', '--scorecard', 'card_evidence', '--name', 'unit', '--source', 'run', '--outcome', 'green', '--as', OP],
      ['scorecards', 'repair', '--scorecard', 'card_evidence', '--trigger', 'unknown', '--detail', 'fixed', '--as', OP],
      ['scorecards', 'repair', '--scorecard', 'card_missing', '--trigger', 'failed-check', '--detail', 'fixed', '--as', OP],
      ['scorecards', 'check', '--scorecard', 'card_evidence', '--name', 'unit', '--source', 'run', '--outcome', 'passed', '--as', 'wrong'],
      [...reviewArgs, '--no-findings', '--as', 'wrong'],
      ['scorecards', 'repair', '--scorecard', 'card_evidence', '--trigger', 'failed-check', '--detail', 'fixed', '--as', 'wrong'],
    ]) {
      const result = await agentsys(...args, '--head', HEAD1);
      assert.equal(result.code, 2, result.stderr);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
      assert.deepEqual(storedScorecard(), original);
    }
  });

  it('requires a full commit ID on each evidence command without changing the card', async () => {
    await agentsys('init', '--operator', OP);
    const original = seedScorecard();
    for (const args of [
      ['scorecards', 'check', '--name', 'unit', '--source', 'run', '--outcome', 'passed'],
      ['scorecards', 'review', '--author', 'a', '--reviewer', 'b', '--relationship', 'independent', '--source', 'review', '--no-findings'],
      ['scorecards', 'repair', '--trigger', 'failed-check', '--detail', 'fixed'],
    ]) {
      for (const headArgs of [[], ['--head', 'main'], ['--head', 'abc123']]) {
        const result = await agentsys(...args, '--scorecard', original.id, '--as', OP, ...headArgs);
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, /head/);
        assert.doesNotMatch(result.stderr, /\n\s+at /);
        assert.deepEqual(storedScorecard(), original);
      }
    }
  });

  it('serializes concurrent evidence and feedback appends without losing history', async () => {
    await agentsys('init', '--operator', OP);
    seedScorecard();
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => agentsys('scorecards', 'check', '--scorecard', 'card_evidence',
        '--name', `check-${i}`, '--source', `run/${i}`, '--outcome', 'passed', '--head', HEAD1, '--as', OP)),
      agentsys(...reviewArgs, '--no-findings'),
      agentsys('scorecards', 'repair', '--scorecard', 'card_evidence', '--trigger', 'failed-check', '--detail', 'fixed', '--head', HEAD2, '--as', OP),
      agentsys('feedback', '--scorecard', 'card_evidence', '--verdict', 'rework-needed', '--reason', 'inspect', '--as', OP),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const card = storedScorecard();
    assert.equal(new Set(card.checks.map((check) => check.name)).size, 5);
    assert.equal(card.reviews?.length, 1);
    assert.equal(card.repairs.length, 1);
    assert.equal(card.feedback?.verdict, 'rework-needed');
  });

  it('filters per-card details with the aggregate population and documents the writers', async () => {
    seedScorecard();
    seedScorecard('card_other', 'other/repo');
    const result = await agentsys('scorecards', '--repo', REPO);
    assert.match(result.stdout, /Samples: 1/);
    assert.match(result.stdout, /card_evidence/);
    assert.doesNotMatch(result.stdout, /card_other/);
    const help = await agentsys('--help');
    assert.match(help.stdout, /full 40- or 64-character hexadecimal commit ID/);
    assert.doesNotMatch(help.stdout, /\[--head/);
    for (const word of ['scorecards check', 'scorecards review', 'scorecards repair', '--findings', '--no-findings', '--relationship', '--trigger']) {
      assert.ok(help.stdout.includes(word), word);
    }
  });
});

describe('a fresh install', () => {
  it('prints usage rather than doing anything', async () => {
    const { stdout, code } = await agentsys('--help');
    assert.equal(code, 0);
    assert.match(stdout, /Every dispatch needs either an individual approval or an active standing grant/);
  });

  it('has no grants', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout } = await agentsys('grant', 'list');
    assert.deepEqual(JSON.parse(stdout), []);
  });

  it('holds a dispatch for approval instead of running it', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout, code } = await agentsys(
      'dispatch', '--task', 't1', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
      '--prompt', 'anything',
    );
    assert.equal(code, 1, 'an unauthorized dispatch must not exit success');
    assert.match(stdout, /Awaiting approval/);
    assert.match(stdout, /Next: Approve this task explicitly/);
  });
});

describe('authority through the real CLI', () => {
  it('refuses to mint authority without an operator identity', async () => {
    await agentsys('init', '--operator', OP);
    const { stderr, code } = await agentsys(
      'approve', '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
    );
    assert.equal(code, 2);
    assert.match(stderr, /Who is acting\?/);
  });

  it('refuses an operator id that is not the configured one', async () => {
    await agentsys('init', '--operator', OP);
    const { stderr, code } = await agentsys(
      'approve', '--as', 'someone-else', '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
    );
    assert.equal(code, 2);
    assert.match(stderr, /not the configured operator/);
  });

  it('runs the grant lifecycle: create, show, narrow, revoke', async () => {
    await agentsys('init', '--operator', OP);
    const created = await agentsys(
      'grant', 'create', '--as', OP, '--repos', REPO, '--classes', 'ci-repair',
      '--sources', 'github-actions:x', '--actions', 'author-changes,open-pr',
      '--runtimes', 'pi-local', '--profiles', 'default', '--max-dispatches', '3',
      '--reason', 'trial',
    );
    assert.equal(created.code, 0);
    assert.match(created.stdout, /Relevant history at the time of the decision/);
    assert.match(created.stdout, /no evaluation history behind this decision yet/);
    const id = /"id": "(grant_[a-z0-9]+)"/.exec(created.stdout)?.[1];
    assert.ok(id, 'grant id is reported');

    const narrowed = await agentsys('grant', 'narrow', '--as', OP, '--id', id!, '--repos', REPO, '--reason', 'tighten');
    assert.equal(narrowed.code, 0);
    assert.match(narrowed.stdout, /"version": 2/);

    const widened = await agentsys('grant', 'narrow', '--as', OP, '--id', id!, '--repos', `${REPO},other/repo`, '--reason', 'sneak');
    assert.equal(widened.code, 2, 'narrowing must not be usable to widen');
    assert.match(widened.stderr, /cannot add to repos/);

    const revoked = await agentsys('grant', 'revoke', '--as', OP, '--id', id!, '--reason', 'done');
    assert.equal(revoked.code, 0);
    assert.match(revoked.stdout, /Revoked/);

    const after = await agentsys(
      'dispatch', '--task', 't9', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
      '--trigger-source', 'github-actions:x', '--prompt', 'anything',
    );
    assert.equal(after.code, 1, 'a revoked grant cannot authorize new work');
    assert.match(after.stdout, /Awaiting approval/);
  });

  // Holds the decision in docs/adr/20261015-unsafe-actions-refused-before-authority.md.
  it('refuses to even record a grant that names a forbidden action', async () => {
    await agentsys('init', '--operator', OP);
    const { stderr, code } = await agentsys(
      'grant', 'create', '--as', OP, '--repos', REPO, '--classes', 'ci-repair',
      '--sources', 'src', '--actions', 'author-changes,merge',
      '--runtimes', 'pi-local', '--profiles', 'default', '--max-dispatches', '9', '--reason', 'over-broad',
    );
    assert.equal(code, 2, 'an over-broad grant is refused at the point it is written');
    assert.match(stderr, /never authorized/);
    assert.match(stderr, /not a spelling problem/, 'the message must not read as a typo');
  });

  // Holds the decision in docs/adr/20261015-unsafe-actions-refused-before-authority.md.
  it('refuses a dispatch naming a forbidden action', async () => {
    await agentsys('init', '--operator', OP);
    const { stderr, code } = await agentsys(
      'dispatch', '--task', 't2', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes,force-push',
      '--trigger-source', 'src', '--prompt', 'anything',
    );
    assert.equal(code, 2);
    assert.match(stderr, /never authorized/);
  });

  it('refuses an action that is merely misspelled, with the valid list', async () => {
    await agentsys('init', '--operator', OP);
    const { stderr, code } = await agentsys(
      'approve', '--as', OP, '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes,opn-pr',
    );
    assert.equal(code, 2, 'a typo must not be written into an approval');
    assert.match(stderr, /Unknown action "opn-pr"/);
    assert.match(stderr, /open-pr/);
  });
});

describe('the operator floor through the real CLI', () => {
  it('sets and clears a required base and a read-only project, and only for the operator', async () => {
    await agentsys('init', '--operator', OP);
    const refused = await agentsys('floor', '--repo', 'example-org/larkspur', '--pr-base', 'dev', '--as', 'someone-else@example.test');
    assert.notEqual(refused.code, 0, 'only the configured operator changes the floor');
    assert.equal((await agentsys('floor', '--repo', 'example-org/larkspur', '--pr-base', 'dev', '--as', OP)).code, 0);
    assert.equal((await agentsys('floor', '--read-only-project', 'larkspur-prod', '--as', OP)).code, 0);
    assert.deepEqual(JSON.parse((await agentsys('floor', '--show')).stdout), { prBases: { 'example-org/larkspur': 'dev' }, readOnlyProjects: ['larkspur-prod'] });
    await agentsys('floor', '--repo', 'example-org/larkspur', '--clear-pr-base', '--as', OP);
    await agentsys('floor', '--writable-project', 'larkspur-prod', '--as', OP);
    assert.deepEqual(JSON.parse((await agentsys('floor', '--show')).stdout), { prBases: {}, readOnlyProjects: [] });
    assert.equal((await agentsys('floor', '--prompt-proposals', 'example-org/agent-system-ops', '--as', OP)).code, 0);
    assert.equal(JSON.parse((await agentsys('floor', '--show')).stdout).promptProposals, 'example-org/agent-system-ops');
    await agentsys('floor', '--clear-prompt-proposals', '--as', OP);
    assert.deepEqual(JSON.parse((await agentsys('floor', '--show')).stdout), { prBases: {}, readOnlyProjects: [] });
  });
});

describe('settings and admission through the real CLI', () => {
  it('rejects an unsupported effort instead of running a different one', async () => {
    await agentsys('init', '--operator', OP);
    const approve = await agentsys(
      'approve', '--as', OP, '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'claude-web', '--profile', 'default', '--actions', 'author-changes',
    );
    const apv = /"id": "(apv_[a-z0-9]+)"/.exec(approve.stdout)?.[1];
    const { stdout } = await agentsys(
      'dispatch', '--task', 't3', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'claude-web', '--profile', 'default', '--actions', 'author-changes',
      '--approval', apv!, '--prompt', 'x', '--effort', 'ludicrous',
      '--estimate-five-hour', '1', '--estimate-weekly', '1', '--estimate-basis', 'operator-bound',
    );
    // Either admission or settings rejects it; neither may silently substitute.
    assert.ok(
      /Unsupported model\/effort settings/.test(stdout) || /Waiting on subscription allowance/.test(stdout),
      `expected a refusal, got: ${stdout}`,
    );
    assert.doesNotMatch(stdout, /Completed/);
  });

  /**
   * The budget deliberately ignores admission refusals, so the number an
   * operator is shown has to ignore them too. When the two counts disagree the
   * status line understates the remaining budget, and the scorecard records a
   * task as having taken attempts that never reached a runtime.
   */
  it('does not spend an attempt on a dispatch that admission refused', async () => {
    await agentsys('init', '--operator', OP);
    const approve = await agentsys(
      'approve', '--as', OP, '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
      '--max-attempts', '2',
    );
    const apv = /"id": "(apv_[a-z0-9]+)"/.exec(approve.stdout)?.[1];
    const dispatch = async (): Promise<string> => (await agentsys(
      'dispatch', '--task', 't-attempts', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
      '--approval', apv!, '--prompt', 'x',
    )).stdout;

    const first = await dispatch();
    assert.match(first, /Waiting on subscription allowance/, `expected a refusal, got: ${first}`);
    const second = await dispatch();
    assert.match(second, /Waiting on subscription allowance/, `expected a refusal, got: ${second}`);

    // Three refusals against a two-attempt budget: still refused for the
    // subscription, never for a budget the refusals themselves ate.
    const third = await dispatch();
    assert.doesNotMatch(third, /permitted attempts/, `refusals consumed the budget: ${third}`);

    const { stdout } = await agentsys('status', '--task', 't-attempts');
    const attempts = [...stdout.matchAll(/attempt=(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(attempts.length, 3, `expected three recorded runs, got: ${stdout}`);
    assert.deepEqual(attempts, [1, 1, 1], `a refused run advanced the attempt label: ${stdout}`);
  });

  it('shows the admission arithmetic, not just a verdict', async () => {
    await agentsys('init', '--operator', OP);
    const approve = await agentsys(
      'approve', '--as', OP, '--repo', REPO, '--scope', 'x', '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
    );
    const apv = /"id": "(apv_[a-z0-9]+)"/.exec(approve.stdout)?.[1];
    const { stdout } = await agentsys(
      'dispatch', '--task', 't4', '--repo', REPO, '--class', 'ci-repair',
      '--runtime', 'pi-local', '--profile', 'default', '--actions', 'author-changes',
      '--approval', apv!, '--prompt', 'x',
      '--estimate-five-hour', '2', '--estimate-weekly', '1',
      '--estimate-basis', 'operator-bound', '--estimate-detail', 'bounded by operator',
    );
    assert.match(stdout, /Subscription: openai-codex/);
    assert.match(stdout, /estimate basis: operator-bound — bounded by operator/);
  });

  it('sets, shows and turns off a weekly ramp, changing nothing else in the policy', async () => {
    await agentsys('init', '--operator', OP);
    const before = JSON.parse((await agentsys('policy', '--subscription', 'claude-max', '--show')).stdout) as Record<string, unknown>;
    assert.equal('weeklyRampHours' in before, false, 'a policy written before the ramp existed loads with none');

    const set = await agentsys('policy', '--subscription', 'claude-max', '--ramp-hours', '24', '--as', OP);
    assert.equal(set.code, 0);
    const shown = JSON.parse((await agentsys('policy', '--subscription', 'claude-max', '--show')).stdout) as Record<string, unknown>;
    assert.deepEqual(shown, { ...before, weeklyRampHours: 24 });

    const off = await agentsys('policy', '--subscription', 'claude-max', '--ramp-hours', '0', '--as', OP);
    assert.equal(off.code, 0);
    assert.deepEqual(JSON.parse((await agentsys('policy', '--subscription', 'claude-max', '--show')).stdout), before, '0 hours leaves the policy as it was before there was a ramp');
  });

  it('keeps the ramp when another threshold changes, and refuses a ramp that is not 0 to 168 hours', async () => {
    await agentsys('init', '--operator', OP);
    await agentsys('policy', '--subscription', 'openai-codex', '--ramp-hours', '24', '--as', OP);
    const { stdout } = await agentsys('policy', '--subscription', 'openai-codex', '--weekly', '70', '--as', OP);
    assert.match(stdout, /"weeklyRampHours": 24/);
    assert.match(stdout, /"weeklyThresholdPercent": 70/);
    for (const bad of ['-1', '169']) assert.equal((await agentsys('policy', '--subscription', 'openai-codex', '--ramp-hours', bad, '--as', OP)).code, 2, bad);
    const refused = await agentsys('policy', '--subscription', 'openai-codex', '--ramp-hours', '12');
    assert.equal(refused.code, 2, 'setting a ramp needs an operator identity');
  });

  it('lets the operator change a threshold and reports it back', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout } = await agentsys('policy', '--subscription', 'claude-max', '--as', OP, '--five-hour', '25');
    assert.match(stdout, /"fiveHourThresholdPercent": 25/);
    assert.match(stdout, /"weeklyThresholdPercent": 40/, 'untouched fields keep their value');
  });

  it('reports the paid-call allowance and refuses to raise it without an operator', async () => {
    await agentsys('init', '--operator', OP);
    const shown = await agentsys('ledger');
    assert.match(shown.stdout, /Paid-call allowance: \$10\.00/);
    const raised = await agentsys('ledger', '--set-allowance', '999');
    assert.equal(raised.code, 2, 'raising the allowance needs an operator identity');
  });

  it('reserves a paid call against the allowance and settles it at its actual cost', async () => {
    await agentsys('init', '--operator', OP);
    const reserved = await agentsys(
      'ledger', 'reserve', '--task', 't-stt', '--run', 'run_stt', '--operation', 'openai:embeddings',
      '--bound-usd', '0.10', '--basis', '40 article summaries at listed rate plus one retry',
    );
    assert.equal(reserved.code, 0);
    assert.match(reserved.stdout, /Reserved \$0\.10/);
    assert.match(reserved.stdout, /remaining allowance: \$9\.90/);

    const id = /\b(call_[a-z0-9]+)\b/.exec(reserved.stdout)?.[1];
    assert.ok(id, `no reservation id in: ${reserved.stdout}`);

    const held = await agentsys('ledger');
    assert.match(held.stdout, /remaining: \$9\.90/, 'a reservation is charged before the call runs');

    const settled = await agentsys('ledger', 'settle', id, '--actual-usd', '0.03');
    assert.equal(settled.code, 0);
    assert.match(settled.stdout, /remaining allowance: \$9\.97/, 'settling at the actual cost frees the rest');
  });

  it('refuses a call it cannot afford instead of shrinking the bound', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout, code } = await agentsys(
      'ledger', 'reserve', '--task', 't-big', '--run', 'run_big', '--operation', 'openai:translate',
      '--bound-usd', '12', '--basis', 'a whole batch',
    );
    assert.equal(code, 1);
    assert.match(stdout, /leaving only \$10\.00/);
    const after = await agentsys('ledger');
    assert.match(after.stdout, /remaining: \$10\.00/, 'a refused call reserves nothing');
  });

  it('will not record a call as free just because the figure was omitted', async () => {
    await agentsys('init', '--operator', OP);
    const reserved = await agentsys(
      'ledger', 'reserve', '--task', 't-unk', '--run', 'run_unk', '--operation', 'openai:embeddings',
      '--bound-usd', '0.10', '--basis', 'bounded summaries',
    );
    const id = /\b(call_[a-z0-9]+)\b/.exec(reserved.stdout)?.[1];
    assert.ok(id);

    const forgotten = await agentsys('ledger', 'settle', id);
    assert.equal(forgotten.code, 2, 'settling with no figure at all is a usage error');
    assert.match(forgotten.stderr + forgotten.stdout, /--actual-unknown/);

    const deliberate = await agentsys('ledger', 'settle', id, '--actual-unknown');
    assert.equal(deliberate.code, 0);
    assert.match(deliberate.stdout, /still charging the \$0\.10 bound/);
    const after = await agentsys('ledger');
    assert.match(after.stdout, /remaining: \$9\.90/, 'an unknown actual does not become zero');
  });

  it('releases a call that never happened, but not one already settled', async () => {
    await agentsys('init', '--operator', OP);
    const reserved = await agentsys(
      'ledger', 'reserve', '--task', 't-rel', '--run', 'run_rel', '--operation', 'openai:embeddings',
      '--bound-usd', '0.10', '--basis', 'bounded summaries',
    );
    const id = /\b(call_[a-z0-9]+)\b/.exec(reserved.stdout)?.[1];
    assert.ok(id);

    const released = await agentsys('ledger', 'release', id);
    assert.equal(released.code, 0);
    assert.match((await agentsys('ledger')).stdout, /remaining: \$10\.00/);

    const second = await agentsys(
      'ledger', 'reserve', '--task', 't-rel2', '--run', 'run_rel2', '--operation', 'openai:embeddings',
      '--bound-usd', '0.10', '--basis', 'bounded summaries',
    );
    const id2 = /\b(call_[a-z0-9]+)\b/.exec(second.stdout)?.[1];
    assert.ok(id2);
    await agentsys('ledger', 'settle', id2, '--actual-usd', '0.05');
    const late = await agentsys('ledger', 'release', id2);
    assert.equal(late.code, 1, 'a settled call is spent; releasing it would forget real money');
    assert.match(late.stderr, /already settled/);
  });

  it('serves an operator whose command happens to carry a --test flag', async () => {
    // `--test` is a Node runtime flag, but nothing stops an operator typing it as
    // a CLI argument. Matching it in user argv made the store think it was inside
    // a test run and refuse a real command.
    //
    // This has to run the way an operator does, with AGENTSYS_STATE unset — the
    // guard only fires on the fallback path, so the usual harness environment
    // would hide the failure entirely. `cwd` is a throwaway directory so the
    // fallback `.state` lands there and not in the repository.
    const home = mkdtempSync(join(tmpdir(), 'agentsys-operator-'));
    // An operator's shell has neither variable. `NODE_TEST_CONTEXT` has to go too:
    // it is inherited by anything this test runner spawns, so leaving it set would
    // tell the CLI it is inside a test run and prove nothing about the argv check.
    const env = { ...process.env };
    delete env['AGENTSYS_STATE'];
    delete env['NODE_TEST_CONTEXT'];
    try {
      const { stdout } = await run(process.execPath, [CLI, 'ledger', '--test'], {
        env, cwd: home, timeout: 120_000,
      });
      assert.match(stdout, /Paid-call allowance/, 'a stray flag must not be read as a test runner');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an unknown ledger subcommand rather than printing the balance', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout, stderr, code } = await agentsys('ledger', 'spend');
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /Paid-call allowance/);
    assert.match(stderr + stdout, /Unknown ledger subcommand/);
  });
});

describe('manual Pi stop attestation through the CLI', () => {
  it('requires operator confirmation and preserves unverified state across processes', async () => {
    await agentsys('init', '--operator', OP);
    seedScorecard('card_evidence');
    const run = {
      id: 'run_fixture', taskId: 'evidence', attempt: 1, runtime: 'pi-local',
      authority: { type: 'approval', id: 'apv_fixture', version: 1 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      profile: 'default', actions: ['author-changes'],
      settings: { requested: { model: 'm', effort: 'high' }, resolved: { model: 'm', effort: 'high' },
        observed: { model: 'unknown', effort: 'unknown' } },
      startedAt: '2026-06-01T00:00:00.000Z', status: 'running', runtimeDispatched: true,
      admissionId: 'res_fixture', evidenceDir: join(state, 'evidence', 'run_fixture'),
      delivery: { status: 'unverified', reason: 'not checked', evidence: [] },
    };
    mkdirSync(join(state, 'runs'), { recursive: true });
    mkdirSync(join(state, 'reservations'), { recursive: true });
    writeFileSync(join(state, 'runs', 'run_fixture.json'), JSON.stringify(run));
    writeFileSync(join(state, 'reservations', 'res_fixture.json'), JSON.stringify({
      id: 'res_fixture', subscriptionId: 'test', taskId: 'evidence', runId: 'run_fixture',
      estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 0, detail: 'test' },
      createdAt: run.startedAt, state: 'outstanding',
    }));
    const args = ['resolve-pi', '--run', 'run_fixture', '--evidence', 'local-inspection/42',
      '--reason', 'Checked Pi group and descendants; all stopped.', '--as', OP];
    assert.notEqual((await agentsys(...args)).code, 0, 'confirmation cannot be omitted');
    assert.notEqual((await agentsys(...args, '--confirm-stopped', '--as', 'wrong')).code, 0);
    const result = await agentsys(...args, '--confirm-stopped');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /checks-failed.*unverified/);
    const saved = JSON.parse(readFileSync(join(state, 'runs', 'run_fixture.json'), 'utf8'));
    assert.equal(saved.stopAttestation.evidence, 'local-inspection/42');
    assert.equal(saved.status, 'checks-failed');
    assert.equal(saved.delivery.status, 'unverified');
    assert.equal(storedScorecard().finalStatus, 'checks-failed');
    assert.equal(JSON.parse(readFileSync(join(state, 'reservations', 'res_fixture.json'), 'utf8')).state, 'released');
    assert.equal((await agentsys(...args, '--confirm-stopped')).code, 0);
    assert.notEqual((await agentsys(...args, '--confirm-stopped', '--evidence', 'different')).code, 0);
  });
});

describe('recovery', () => {
  it('says plainly when there is nothing to recover', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout, code } = await agentsys('recover');
    assert.equal(code, 0);
    assert.match(stdout, /No runs were left unsettled/);
  });

  it('reconciles a run abandoned in `running` and reports it as blocking', async () => {
    await agentsys('init', '--operator', OP);
    // Exactly the state a killed coordinator leaves: recorded as running, with no
    // session id, so the remote work may exist under an id nobody learned.
    const run = {
      id: 'run_abandoned', taskId: 't-abandoned', attempt: 1,
      authority: { type: 'approval', id: 'apv_x', version: 1 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
      settings: {
        requested: { model: 'm', effort: 'high' },
        resolved: { model: 'm', effort: 'high' },
        observed: { model: 'unknown', effort: 'unknown' },
      },
      startedAt: new Date().toISOString(), status: 'running',
    };
    mkdirSync(join(state, 'runs'), { recursive: true });
    writeFileSync(join(state, 'runs', 'run_abandoned.json'), JSON.stringify(run), 'utf8');

    const { stdout, code } = await agentsys('recover');
    assert.equal(code, 1, 'an unresolved run must not be reported as fine');
    assert.match(stdout, /run_abandoned/);
    assert.match(stdout, /still block a new attempt/);
  });
});

describe('reconcile exit codes', () => {
  it('exits non-zero when the session is not settled', async () => {
    await agentsys('init', '--operator', OP);
    // Without a stored run and evidence directory, Pi cannot confirm this
    // unknown session stopped. A script chaining reconcile into dispatch must
    // not be told an in-flight session finished.
    const { stdout, code } = await agentsys('reconcile', 'sess_unknown', '--runtime', 'pi-local');
    assert.equal(code, 1, 'an unsettled session must not report success');
    assert.match(stdout, /Remote state uncertain/);
  });

  it('names the session it could not settle', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout } = await agentsys('reconcile', 'sess_abc123', '--runtime', 'pi-local');
    assert.match(stdout, /sess_abc123/);
  });

  it('uses stored local evidence and exits zero for a settled failure', async () => {
    await agentsys('init', '--operator', OP);
    const evidenceDir = join(state, 'evidence', 'run_local');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, 'pi-rpc-events.jsonl'),
      [
        JSON.stringify({ type: 'response', id: 'state', command: 'get_state', success: false }),
        JSON.stringify({ type: 'agentsys_local_process_stopped' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const run = {
      id: 'run_local', taskId: 'task_local', attempt: 1,
      authority: { type: 'approval', id: 'apv_local', version: 1 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      runtime: 'pi-local', profile: 'default', actions: ['review'],
      settings: {
        requested: { model: 'm', effort: 'high' },
        resolved: { model: 'm', effort: 'high' },
        observed: { model: 'unknown', effort: 'unknown' },
      },
      startedAt: new Date().toISOString(), status: 'remote-uncertain',
      sessionId: 'sess_local', evidenceDir,
    };
    mkdirSync(join(state, 'runs'), { recursive: true });
    writeFileSync(join(state, 'runs', 'run_local.json'), JSON.stringify(run), 'utf8');

    const { stdout, code } = await agentsys('reconcile', 'sess_local', '--runtime', 'pi-local');
    assert.equal(code, 0, 'a local checks-failed result is settled even though the task failed');
    assert.match(stdout, /No confirmed success/);
  });
});

describe('status', () => {
  it('says plainly when there is nothing rather than printing an empty table', async () => {
    await agentsys('init', '--operator', OP);
    const { stdout } = await agentsys('status');
    assert.match(stdout, /No runs recorded/);
  });
});

/**
 * The operator deferred live extension verification for this phase.
 *
 * These drive the real command line end to end. The candidate, check list and
 * evidence are LABELLED DETERMINISTIC FIXTURES — test data written by this file, not
 * records of any real run. They establish how the configuration and acceptance
 * surfaces behave; they are not the real evidence the retained gates still owe.
 */
describe('deferred scope through the real configuration and acceptance surfaces', () => {
  const CANDIDATE = {
    repo: 'example-org/larkspur',
    base: 'dev',
    head: '1111111111111111111111111111111111111111',
  };
  const evidenceItem = (over: Record<string, unknown> = {}) => ({
    check: 'web-journey', class: 'real-provider', reportedOutcome: 'passed',
    candidate: CANDIDATE, observedAt: new Date().toISOString(), source: 'fixture', ...over,
  });

  async function configure(): Promise<void> {
    await agentsys('init', '--operator', OP);
    writeFileSync(join(state, 'required-checks.json'), JSON.stringify([
      { name: 'web-journey', requiredClass: 'real-provider' },
      { name: 'extension-native-journey', requiredClass: 'native' },
    ]));
  }
  const writeEvidence = (evidence: unknown[]): string => {
    const path = join(state, 'evidence.json');
    writeFileSync(path, JSON.stringify({ candidate: CANDIDATE, evidence }));
    return path;
  };

  it('lists a deferred check as deferred, never as passed', async () => {
    await configure();
    const deferred = await agentsys('checks', '--defer', 'extension-native-journey',
      '--reason', 'Live extension verification deferred for this phase', '--as', OP);
    assert.equal(deferred.code, 0, deferred.stderr);
    assert.match(deferred.stdout, /extension-native-journey \(native\) — DEFERRED by/);
    assert.match(deferred.stdout, /Deferred means untested and unverified, not passed/);
  });

  it('refuses to defer a check without the operator', async () => {
    await configure();
    const { code } = await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'x');
    assert.equal(code, 2, 'deferring a check is an authority decision');
    const shown = await agentsys('checks');
    assert.doesNotMatch(shown.stdout, /DEFERRED/, 'nothing was deferred');
  });

  it('completes the current scope while the deferred check has no evidence', async () => {
    await configure();
    await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'deferred', '--as', OP);
    const { stdout, code } = await agentsys('accept', '--evidence', writeEvidence([evidenceItem()]));
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^deferred extension-native-journey/m);
    assert.match(stdout, /Deferred and therefore untested, not passed: extension-native-journey/);
    assert.match(stdout, /ACCEPTED for the tested scope/);
  });

  it('still blocks when the required web check is absent', async () => {
    await configure();
    await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'deferred', '--as', OP);
    const { stdout, code } = await agentsys('accept', '--evidence', writeEvidence([]));
    assert.equal(code, 1, 'a deferral elsewhere cannot excuse a missing real check');
    assert.match(stdout, /BLOCKED {2}web-journey/);
    assert.match(stdout, /NOT ACCEPTED/);
  });

  it('still blocks when the required web check failed', async () => {
    await configure();
    await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'deferred', '--as', OP);
    const evidence = writeEvidence([evidenceItem({ reportedOutcome: 'failed' })]);
    const { stdout, code } = await agentsys('accept', '--evidence', evidence);
    assert.equal(code, 1);
    assert.match(stdout, /BLOCKED {2}web-journey/);
  });

  it('blocks again when this configuration explicitly requires the deferred check', async () => {
    await configure();
    await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'deferred', '--as', OP);
    const { stdout, code } = await agentsys('accept',
      '--evidence', writeEvidence([evidenceItem()]), '--require', 'extension-native-journey');
    assert.equal(code, 1, 'asking for the check back puts it back to blocking');
    assert.match(stdout, /BLOCKED {2}extension-native-journey/);
    assert.match(stdout, /this configuration requires it anyway/);
  });

  it('refuses a check list whose deferral was not written by the operator', async () => {
    await configure();
    writeFileSync(join(state, 'required-checks.json'), JSON.stringify([
      { name: 'web-journey', requiredClass: 'real-provider' },
      {
        name: 'extension-native-journey', requiredClass: 'native',
        deferral: { reason: 'retired by the run', deferredBy: 'run_abc123', deferredAt: new Date().toISOString() },
      },
    ]));
    const { stdout, stderr, code } = await agentsys('accept', '--evidence', writeEvidence([evidenceItem()]));
    assert.notEqual(code, 0, 'a forged deferral must not produce an acceptance');
    assert.match(stdout + stderr, /cannot retire a required check/);
  });

  it('restores a deferred check to blocking', async () => {
    await configure();
    await agentsys('checks', '--defer', 'extension-native-journey', '--reason', 'deferred', '--as', OP);
    const restored = await agentsys('checks', '--restore', 'extension-native-journey', '--as', OP);
    assert.equal(restored.code, 0);
    assert.doesNotMatch(restored.stdout, /DEFERRED/);
    const { code } = await agentsys('accept', '--evidence', writeEvidence([evidenceItem()]));
    assert.equal(code, 1, 'restored means required again');
  });
});
