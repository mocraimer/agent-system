import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type {
  CoordinatorCommands, DispatchTaskInput, EvaluationView, EvidenceView, JobsView, ReadinessView, StatusRun, StatusView, UsageView,
} from '../commands.js';
import type { ConsoleCommands } from '../console/commands.js';
import { createConsoleCommands } from '../console/commands.js';
import { FileStore } from '../console/file-store.js';
import { consoleTarget } from '../console/service.js';
import { fixtureTargetRepo, issue, proposal, snapshot, writeStoreFile } from '../console/testkit.js';
import { GitRepo } from '../loop/git.js';
import { fixtureStoreConfig } from '../loop/testkit.js';
import type { Outcome } from '../core/outcome.js';
import { startUiServer } from './server.js';

let state = '';
let handle: Awaited<ReturnType<typeof startUiServer>> | undefined;
let calls: string[][] = [];

const OPERATOR = 'operator@example.test';
const STATIC = {
  '/': '<!doctype html><html><script src="/app.js"></script></html>',
  '/index.html': '<!doctype html><html><script src="/app.js"></script></html>',
  '/app.js': 'document.body.textContent = "ui";',
  '/styles.css': 'body { color: black; }',
};

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'agentsys-ui-'));
  process.env['AGENTSYS_STATE'] = state;
  calls = [];
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  delete process.env['AGENTSYS_STATE'];
  rmSync(state, { recursive: true, force: true });
});

function outcome(kind: Outcome['kind'] = 'completed'): Outcome {
  return { kind, summary: kind, nextAction: 'Inspect the result.' };
}

function fakeCommands(fixtureRun?: StatusRun['run']): CoordinatorCommands {
  const status: StatusView = { generatedAt: new Date().toISOString(), runs: fixtureRun ? [{ run: fixtureRun, elapsedSeconds: 0, active: false }] : [], reservations: [] };
  const jobs: JobsView = { generatedAt: new Date().toISOString(), jobs: [] };
  const usage: UsageView = { generatedAt: new Date().toISOString(), runtimes: [] };
  const readiness: ReadinessView = { generatedAt: new Date().toISOString(), runtimes: [] };
  const evidence: EvidenceView = { generatedAt: new Date().toISOString(), requiredChecks: [], deferred: [], evidenceCount: 0, configuration: { valid: true } };
  const evaluation: EvaluationView = { view: 'summary', scorecards: { report: { key: {}, sampleCount: 0, byStatus: {}, attemptCounts: { recorded: 0, dispatched: 0, dispatchUnknown: 0, delivered: 0, byStatus: {} }, unresolved: 0, failedAttempts: 0, operatorVerdicts: { accepted: 0, 'rework-needed': 0, rejected: 0 }, unrated: 0, caveat: '0 sample(s).' }, count: 0 }, suites: { count: 0 }, trials: { count: 0 } };
  return {
    status: () => status,
    jobs: () => jobs,
    authority: () => ({ generatedAt: new Date().toISOString(), operatorConfigured: true, approvals: [], grants: [] }),
    policy: () => ({ generatedAt: new Date().toISOString(), policy: { subscriptionId: 'test', fiveHourThresholdPercent: 60, weeklyThresholdPercent: 40, safetyMarginPercent: 5, maxReadingAgeSeconds: 300 } }),
    ledger: () => ({ generatedAt: new Date().toISOString(), policy: { allowanceUsd: 10 }, remainingUsd: 10, calls: [] }),
    version: () => ({ generatedAt: new Date().toISOString(), active: null, candidates: [], history: [], identity: { loaded: null, onDisk: null, selectedCoordinator: null, loadedMatchesDisk: null, loadedMatchesSelected: null } }),
    usage: async () => usage,
    readiness: async () => readiness,
    evidence: () => evidence,
    evaluation: () => evaluation,
    configuredOperator: () => OPERATOR,
    approve: (actor: { id: string }) => { calls.push(['approve', actor.id]); return {} as never; },
    approvalList: () => [], approvalGet: () => undefined,
    grantCreate: () => ({}) as never, grantList: () => [], grantGet: () => undefined, grantNarrow: () => ({}) as never, grantRevoke: () => ({}) as never,
    policySet: () => ({}) as never, ledgerAllowanceSet: () => ({}) as never,
    checkDefer: () => ({ checks: [], changed: {} }) as never, checkRestore: () => ({ checks: [], changed: {} }) as never,
    feedbackRecord: () => ({}) as never, versionActivate: () => ({}) as never, versionRollback: () => ({}) as never,
    intakeFailure: () => ({}) as never,
    recover: async () => [],
    dispatch: async (input: DispatchTaskInput) => {
      calls.push(['dispatch', input.taskId]);
      return { outcome: outcome(), recovered: [] };
    },
  } as unknown as CoordinatorCommands;
}

async function start(fixtureRun?: StatusRun['run']): Promise<void> {
  handle = await startUiServer({
    repoRoots: [state],
    commands: fakeCommands(fixtureRun),
    staticFiles: STATIC,
  });
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  assert.ok(handle);
  return fetch(`http://127.0.0.1:${handle.port}${path}`, init);
}

async function session(): Promise<{ cookie: string; csrf: string }> {
  assert.ok(handle);
  const bootstrap = await request('/api/session/bootstrap', {
    method: 'POST',
    headers: { 'X-UI-Bootstrap': handle.bootstrapToken },
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const payload = await bootstrap.json() as { csrfToken: string };
  return { cookie, csrf: payload.csrfToken };
}

function mutationInit(sessionInfo: { cookie: string; csrf: string }, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Cookie: sessionInfo.cookie,
      Origin: `http://127.0.0.1:${handle!.port}`,
      'X-CSRF-Token': sessionInfo.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

describe('loopback UI authentication', () => {
  // Holds the decision in docs/adr/20260918-local-console-and-proposing-improve.md.
  it('requires a bootstrap session and one-time token', async () => {
    await start();
    const address = handle!.server.address();
    assert.equal(typeof address === 'object' && address?.address, '127.0.0.1');
    assert.equal((await request('/api/status')).status, 401);
    const page = await request('/');
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
    const first = await session();
    assert.equal((await request('/api/session', { headers: { Cookie: first.cookie } })).status, 200);
    assert.equal((await request('/api/session/bootstrap', { method: 'POST', headers: { 'X-UI-Bootstrap': handle!.bootstrapToken } })).status, 401);
    assert.deepEqual(calls, [], 'authentication and reload-shaped GETs do not dispatch work');
  });

  it('rejects cross-origin and missing-CSRF mutations', async () => {
    await start();
    const current = await session();
    const body = { repo: 'owner/repo', scope: 'test', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default', actions: ['review'] };
    const missing = await request('/api/approvals', { method: 'POST', headers: { Cookie: current.cookie, Origin: `http://127.0.0.1:${handle!.port}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(missing.status, 403);
    const crossOrigin = await request('/api/approvals', { method: 'POST', headers: { Cookie: current.cookie, Origin: 'https://evil.example', 'X-CSRF-Token': current.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(crossOrigin.status, 403);
  });
});

describe('typed command and CLI mutation boundary', () => {
  it('uses the shared dispatch command and does not accept an actor from the body', async () => {
    await start();
    const current = await session();
    const response = await request('/api/dispatch', mutationInit(current, {
      taskId: 'task_ui', repo: 'owner/repo', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default', actions: ['review'], approvalId: 'apv_abc', prompt: 'read only', repoPath: state,
      settings: {}, estimate: { fiveHourPercent: 1, weeklyPercent: 1, uncertaintyPercent: 1, basis: 'operator-bound', detail: 'test bound' },
    }));
    assert.equal(response.status, 202);
    const operation = await response.json() as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, [['dispatch', 'task_ui']]);
    assert.match(operation.id, /^op_/);
  });

  it('derives operator authority for typed mutations', async () => {
    await start();
    const current = await session();
    const response = await request('/api/approvals', mutationInit(current, {
      repo: 'owner/repo', scope: 'test', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default', actions: ['review'],
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ['approve', OPERATOR]);
  });

  it('rejects a browser-supplied actor field', async () => {
    await start();
    const current = await session();
    const response = await request('/api/approvals', mutationInit(current, {
      as: 'attacker@example.test', repo: 'owner/repo', scope: 'test', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default', actions: ['review'],
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });
});

describe('bounded evidence access', () => {
  it('does not serve paths outside a run evidence directory', async () => {
    const run: StatusRun['run'] = {
      id: 'run_abc123', taskId: 'task', attempt: 1,
      authority: { type: 'approval', id: 'apv_abc', version: 1 },
      limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      runtime: 'pi-local', profile: 'default', actions: ['review'],
      settings: { requested: { model: 'vendor-default', effort: 'vendor-default' }, resolved: { model: 'vendor-default', effort: 'vendor-default' }, observed: { model: 'unknown', effort: 'unknown' } },
      startedAt: new Date().toISOString(), status: 'completed', evidenceDir: join(state, 'evidence', 'run_abc123'),
    };
    mkdirSync(join(state, 'evidence', 'run_abc123'), { recursive: true });
    writeFileSync(join(state, 'outside.txt'), 'secret');
    await start(run);
    const current = await session();
    const traversal = await request('/api/evidence/runs/run_abc123/..%2F..%2Foutside.txt', { headers: { Cookie: current.cookie } });
    assert.ok([400, 404].includes(traversal.status));
  });
});

describe('console routes act only through the console command layer', () => {
  let consoleCalls: Array<[string, string, unknown]> = [];
  const board = { repo: 'owner/repo', state: { name: 'Nothing to do', because: 'idle' }, items: [], counts: {}, verdicts: [], paused: {} };
  const fakeConsole = (): ConsoleCommands => ({
    view: async () => ({ board, policy: { source: 's', stopLines: [], tiers: [], limits: [], ladder: [] } }) as never,
    inspect: async (ref: string) => ({ item: { ref } }) as never,
    steer: async () => ({ policy: {}, paused: {}, stages: [], runs: [] }) as never,
    act: async (actor, input) => { consoleCalls.push(['act', actor.id, input]); return { ref: input.ref, action: input.action, did: 'done', buildIdentity: { loaded: null, onDisk: null, selectedCoordinator: null, loadedMatchesDisk: null, loadedMatchesSelected: null } }; },
    propose: async (actor, change) => { consoleCalls.push(['propose', actor.id, change]); return { branch: 'b', pr: 1, commit: 'c', opened: true, live: '4', proposed: '5' }; },
    pause: (actor, stage, paused) => { consoleCalls.push(['pause', actor.id, { stage, paused }]); return {}; },
    stopRun: async (actor, runId) => { consoleCalls.push(['stop', actor.id, runId]); return { runId, taskId: 't', stoppedBy: actor.id, at: 'now' }; },
    redispatchRun: async (actor, runId) => { consoleCalls.push(['redispatch', actor.id, runId]); return { outcome: outcome(), recovered: [], runtimeDispatched: true }; },
    freezeCase: async (actor, input) => { consoleCalls.push(['freeze', actor.id, input]); return { version: 'incidents-1', caseId: 'c', oracleDigest: 'd', cases: 1, pins: {} }; },
  });

  async function startConsole(withConsole = true): Promise<void> {
    consoleCalls = [];
    handle = await startUiServer({ repoRoots: [state], commands: fakeCommands(), staticFiles: STATIC, ...(withConsole ? { console: fakeConsole() } : {}) });
  }

  const WRITES: Array<[string, unknown]> = [
    ['/api/console/actions', { ref: '#12', action: 'apply-shaped', expected: 'a'.repeat(64) }],
    ['/api/console/policy', { kind: 'stop-line', label: 'type:chore', value: 5 }],
    ['/api/console/stages/shape/pause', {}],
    ['/api/console/stages/shape/resume', {}],
    ['/api/console/runs/run_abc123/stop', {}],
    ['/api/console/runs/run_abc123/redispatch', {}],
    ['/api/console/cases', { ref: 'PR #12', kind: 'reviewer-detects-bad-candidate', expected: 'defect-reported', words: 'the review names the retry', defectPattern: 'sync.ts' }],
  ];

  it('refuses every console route without a session, and every console write without the CSRF token', async () => {
    await startConsole();
    for (const path of ['/api/console/view', '/api/console/steer', '/api/console/inspect?ref=%2312']) {
      assert.equal((await request(path)).status, 401, path);
    }
    const current = await session();
    for (const [path, body] of WRITES) {
      assert.equal((await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${handle!.port}` }, body: JSON.stringify(body) })).status, 401, `${path} without a session`);
      const noCsrf = await request(path, { method: 'POST', headers: { Cookie: current.cookie, Origin: `http://127.0.0.1:${handle!.port}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(noCsrf.status, 403, `${path} without CSRF`);
    }
    assert.deepEqual(consoleCalls, []);
  });

  it('refuses a browser-supplied actor, operator, or repository path on every console write', async () => {
    await startConsole();
    const current = await session();
    for (const [path, body] of WRITES) {
      for (const extra of [{ as: 'x' }, { operator: 'attacker' }, { actor: 'x' }, { repoPath: '/etc' }, { repo: 'other/repo' }]) {
        const response = await request(path, mutationInit(current, { ...(body as object), ...extra }));
        assert.equal(response.status, 400, `${path} with ${Object.keys(extra)[0]}`);
      }
    }
    assert.deepEqual(consoleCalls, []);
  });

  it('passes the configured operator, never anything from the browser, to each console command', async () => {
    await startConsole();
    const current = await session();
    for (const [path, body] of WRITES) {
      const response = await request(path, mutationInit(current, body));
      assert.ok([200, 202].includes(response.status), `${path} answered ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(consoleCalls.map(([name, actor]) => [name, actor]), [
      ['act', OPERATOR], ['propose', OPERATOR], ['pause', OPERATOR], ['pause', OPERATOR], ['stop', OPERATOR], ['redispatch', OPERATOR], ['freeze', OPERATOR],
    ]);
    assert.deepEqual(consoleCalls[2]![2], { stage: 'shape', paused: true });
    assert.deepEqual(consoleCalls[3]![2], { stage: 'shape', paused: false });
  });

  it('validates what the browser names: items, actions, stages, runs and table cells', async () => {
    await startConsole();
    const current = await session();
    const bad: Array<[string, unknown, number]> = [
      ['/api/console/actions', { ref: '../12', action: 'apply-shaped' }, 422],
      ['/api/console/actions', { ref: '#12', action: 'merge-main' }, 422],
      ['/api/console/actions', { ref: '#12', action: 'apply-shaped' }, 422],
      ['/api/console/actions', { ref: '#12', action: 'apply-shaped', expected: 'wrong' }, 422],
      ['/api/console/policy', { kind: 'stop-line', label: 'type:chore | 9', value: 5 }, 422],
      ['/api/console/policy', { kind: 'tier', stage: 'shape', runtime: 'nope', model: 'm', effort: 'e', fiveHourPercent: 1, weeklyPercent: 1 }, 422],
      ['/api/console/stages/deploy/pause', {}, 422],
      ['/api/console/runs/..%2Fx/stop', {}, 404],
      ['/api/console/cases', { ref: 'PR #12', kind: 'made-up', expected: 'x', words: 'y' }, 422],
    ];
    for (const [path, body, status] of bad) assert.equal((await request(path, mutationInit(current, body))).status, status, path);
    assert.equal((await request('/api/console/inspect?ref=..%2Fetc', { headers: { Cookie: current.cookie } })).status, 422);
    assert.deepEqual(consoleCalls, []);
  });

  it('says how to start the console when no store was named at startup', async () => {
    await startConsole(false);
    const current = await session();
    const view = await request('/api/console/view', { headers: { Cookie: current.cookie } });
    assert.equal(view.status, 404);
    assert.match(JSON.stringify(await view.json()), /agentsys ui --repo <path>/);
    assert.equal((await request('/api/console/actions', mutationInit(current, { ref: '#1', action: 'apply-shaped', expected: 'a'.repeat(64) }))).status, 404);
  });

  it('binds a real action to the inspected fingerprint and refuses a changed ticket through HTTP', async () => {
    const fixture = fixtureTargetRepo(state, fixtureStoreConfig());
    writeFileSync(join(state, 'config.json'), JSON.stringify({ operator: OPERATOR }));
    const storePath = join(state, 'store.json');
    writeStoreFile(storePath, snapshot({ issues: [issue(12, { body: 'initial body', comments: [proposal('initial body')] })] }));
    const store = new FileStore(storePath);
    const repo = new GitRepo(fixture.path);
    handle = await startUiServer({ repoRoots: [state], commands: fakeCommands(), staticFiles: STATIC,
      console: createConsoleCommands({ target: await consoleTarget(repo, store), store, git: repo, coordinator: fakeCommands(),
        mergeStage: async () => ({ produced: false, summary: 'not ready' }) }) });
    const current = await session();
    const inspect = async () => (await (await request('/api/console/inspect?ref=%2312', { headers: { Cookie: current.cookie } })).json()) as { actionToken: string; evidence: Array<{ text: string; current: boolean }> };
    const first = await inspect();
    assert.match(first.evidence[0]!.text, /the draft/);
    assert.equal(first.evidence[0]!.current, true);
    const file = JSON.parse(readFileSync(storePath, 'utf8')) as { issues: Array<{ body: string }>; writes: unknown[]; failRead?: string };
    file.issues[0]!.body = 'changed';
    writeFileSync(storePath, JSON.stringify(file));
    const stale = await request('/api/console/actions', mutationInit(current, { ref: '#12', action: 'apply-shaped', expected: first.actionToken }));
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(await stale.json()), /Refresh/);
    assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8') as string).writes, []);
    file.issues[0]!.body = 'initial body';
    file.failRead = 'store offline';
    writeFileSync(storePath, JSON.stringify(file));
    assert.equal((await request('/api/console/actions', mutationInit(current, { ref: '#12', action: 'apply-shaped', expected: first.actionToken }))).status, 409);
    delete file.failRead;
    writeFileSync(storePath, JSON.stringify(file));
    const fresh = await inspect();
    const result = await request('/api/console/actions', mutationInit(current, { ref: '#12', action: 'apply-shaped', expected: fresh.actionToken }));
    assert.equal(result.status, 200);
    assert.match(JSON.stringify(await result.json()), /labeled #12 shaped/);
    assert.equal(JSON.parse(readFileSync(storePath, 'utf8') as string).writes.length, 1);
  });

  it('never echoes a credential from the environment in a response', async () => {
    // Built at run time so the test source holds no credential-shaped literal.
    const secrets = { TELEGRAM_BOT_TOKEN: `${'7'.repeat(9)}:${'T'.repeat(35)}`, GITHUB_TOKEN: `${'gh'}p_${'G'.repeat(36)}`, GH_TOKEN: `${'gh'}o_${'H'.repeat(36)}` };
    const saved = Object.fromEntries(Object.keys(secrets).map((k) => [k, process.env[k]]));
    Object.assign(process.env, secrets);
    try {
      await startConsole();
      const current = await session();
      const bodies: string[] = [];
      for (const path of ['/api/session', '/api/console/view', '/api/console/steer', '/api/console/inspect?ref=%2312', '/api/overview', '/api/status']) {
        bodies.push(await (await request(path, { headers: { Cookie: current.cookie } })).text());
      }
      for (const [path, body] of WRITES) bodies.push(await (await request(path, mutationInit(current, body))).text());
      for (const value of Object.values(secrets)) {
        assert.ok(bodies.every((b) => !b.includes(value)), 'no response carries a credential');
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
