import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'main.js');

/**
 * Walk the sequence `docs/OPERATING.md` tells an operator to follow, from a clean
 * state directory, through the built binary.
 *
 * The per-command tests elsewhere check each surface in isolation. This checks that
 * the documented *order* works — that nothing in it depends on a step the guide does
 * not mention, and that a reader following the guide top to bottom is not stopped by
 * something the guide never told them to do.
 */

let state = '';

async function agentsys(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, AGENTSYS_STATE: state },
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'agentsys-setup-'));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

const OP = 'operator@example.test';

describe('the documented setup sequence, from clean state', () => {
  it('walks setup, configuration, approval, dispatch, status, recovery and evaluation', async () => {
    // "Name the operator"
    const init = await agentsys('init', '--operator', OP);
    assert.equal(init.code, 0);
    assert.match(init.stdout, /No autonomy grants are active/);

    // "Check what each runtime needs" — reports state, never invents readiness.
    const readiness = await agentsys('readiness', '--runtime', 'pi-local');
    assert.match(readiness.stdout, /pi-local: (ready|NOT READY)/);

    // Configuration the guide names.
    const config = await agentsys('config', '--claude-cloud-session', 'session_example');
    assert.equal(config.code, 0);
    assert.match(config.stdout, /session_example/);

    const policy = await agentsys('policy', '--subscription', 'claude-max', '--show');
    assert.match(policy.stdout, /"fiveHourThresholdPercent": 60/);
    assert.match(policy.stdout, /"weeklyThresholdPercent": 40/);

    const ledger = await agentsys('ledger');
    assert.match(ledger.stdout, /Paid-call allowance: \$10\.00/);

    // "Approving one task", with the flags the guide shows.
    const approve = await agentsys(
      'approve', '--as', OP, '--repo', 'example/consumer', '--scope', 'repair the failing test',
      '--class', 'ci-repair', '--runtime', 'pi-local', '--profile', 'default',
      '--actions', 'author-changes,open-pr', '--max-attempts', '3',
    );
    assert.equal(approve.code, 0, approve.stderr);
    const approvalId = /"id": "(apv_[a-z0-9]+)"/.exec(approve.stdout)?.[1];
    assert.ok(approvalId);

    // Status before anything has run says so plainly.
    assert.match((await agentsys('status')).stdout, /No runs recorded/);

    // Recovery on a clean install has nothing to do.
    const recover = await agentsys('recover', '--runtime', 'pi-local');
    assert.equal(recover.code, 0);
    assert.match(recover.stdout, /No runs were left unsettled/);

    // Evaluation surfaces exist and report emptiness honestly.
    const cards = await agentsys('scorecards');
    assert.match(cards.stdout, /Samples: 0/);
    assert.match(cards.stdout, /not a success rate/);

    // Grant management, end to end, as the guide describes it.
    const grant = await agentsys(
      'grant', 'create', '--as', OP, '--repos', 'example/consumer', '--classes', 'ci-repair',
      '--sources', 'ci:example', '--actions', 'author-changes,open-pr',
      '--runtimes', 'pi-local', '--profiles', 'default', '--max-dispatches', '3',
      '--reason', 'documented walk-through',
    );
    assert.equal(grant.code, 0, grant.stderr);
    const grantId = /"id": "(grant_[a-z0-9]+)"/.exec(grant.stdout)?.[1];
    assert.ok(grantId);

    const revoked = await agentsys('grant', 'revoke', '--as', OP, '--id', grantId, '--reason', 'walk-through over');
    assert.equal(revoked.code, 0);

    // The delivered state the guide promises: no active grants.
    const grants = JSON.parse((await agentsys('grant', 'list')).stdout) as Array<{ status: string }>;
    assert.equal(grants.filter((g) => g.status === 'active').length, 0);
  });

  it('version management works from clean state and starts unactivated', async () => {
    await agentsys('init', '--operator', OP);
    assert.match((await agentsys('version', 'show')).stdout, /No version has been activated/);

    const candidate = await agentsys(
      'version', 'record-candidate', '--coordinator', 'sha-test',
      '--origin', 'branch example', '--purpose', 'documented walk-through',
    );
    assert.equal(candidate.code, 0);
    assert.match(candidate.stdout, /test subject, not the running system/);

    // Recording a candidate must not have activated anything.
    assert.match((await agentsys('version', 'show')).stdout, /No version has been activated/);
  });
});

describe('generic system code assumes no particular consumer', () => {
  /**
   * No consumer's branch, cloud project or fixture may be assumed by generic code:
   * every such limit comes from the operator's floor. A fictional consumer the
   * system was never told about is the way to expose such a coupling.
   */
  const FICTIONAL = 'example-org/unrelated-service';

  it('runs the whole authority and admission path for a consumer it has never heard of', async () => {
    await agentsys('init', '--operator', OP);

    const approve = await agentsys(
      'approve', '--as', OP, '--repo', FICTIONAL, '--scope', 'anything',
      '--class', 'some-other-class', '--runtime', 'claude-web', '--profile', 'default',
      '--actions', 'author-changes', '--max-attempts', '2',
    );
    assert.equal(approve.code, 0, approve.stderr);
    const approvalId = /"id": "(apv_[a-z0-9]+)"/.exec(approve.stdout)?.[1];

    // No PR-base constraint applies: that rule is keyed to repositories that declare
    // one, and a consumer the system has never heard of declares none.
    const dispatch = await agentsys(
      'dispatch', '--task', 'unrelated_1', '--repo', FICTIONAL, '--class', 'some-other-class',
      '--runtime', 'claude-web', '--profile', 'default', '--actions', 'author-changes',
      '--approval', approvalId!, '--prompt', 'x',
      '--estimate-five-hour', '1', '--estimate-weekly', '1', '--estimate-basis', 'operator-bound',
    );
    // Positive assertions first: a `doesNotMatch` on empty output would pass
    // vacuously, so require the request to have actually travelled the whole path.
    //
    // Deliberately not asserting the per-window arithmetic. It prints only when a
    // usage reading was obtained, and on a runner with no vendor binary the read
    // fails first — which is a true answer about the environment, not about this
    // consumer. The invariant is that the answer comes from the runtime or from
    // admission, never from the repository being unrecognised.
    assert.match(dispatch.stdout, /Subscription: claude-max/, 'admission was consulted');
    assert.match(dispatch.stdout, /(Setup incomplete|Completed|Waiting on subscription allowance)/,
      'the answer came from the runtime or from admission');
    // Only then: an unknown repository is not a refusal.
    assert.doesNotMatch(dispatch.stdout, /Refused/, 'an unknown repository is not a refusal');
  });

  it('ingests a CI event from a consumer the system was never told about', async () => {
    await agentsys('init', '--operator', OP);
    const eventPath = join(state, 'event.json');
    writeFileSync(eventPath, JSON.stringify({
      source: 'ci:example-org', repo: FICTIONAL, workflowName: 'build',
      runId: '777', headSha: 'abc1234', branch: 'trunk', conclusion: 'failure',
      title: 'build failed', isFixture: true,
    }), 'utf8');

    const intake = await agentsys('intake', '--event', eventPath, '--class', 'some-other-class');
    assert.match(intake.stdout, /Job job_/, 'the job was recorded');
    assert.match(intake.stdout, /Awaiting approval/, 'and correctly held for approval');
    assert.doesNotMatch(intake.stdout, /base/i, 'no required PR base was invented for it');
  });

  // Holds the decision in docs/adr/20261014-consumer-values-live-in-configuration.md and docs/adr/20261014-prompt-proposals-need-a-named-repository.md.
  it('holds no required base or read-only project in a clean state directory', async () => {
    await agentsys('init', '--operator', OP);
    const floor = JSON.parse((await agentsys('floor', '--show')).stdout) as { prBases: object; readOnlyProjects: unknown[] };
    assert.deepEqual(floor, { prBases: {}, readOnlyProjects: [] }, 'a fresh install must carry no consumer-specific limit');
  });
});
