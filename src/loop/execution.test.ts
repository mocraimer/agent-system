import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import type { RuntimeAdapter } from '../adapters/types.js';
import { createGrant } from '../core/authority.js';
import { getRun, listRuns } from '../core/run.js';
import { listReservations } from '../core/admission.js';
import { OPERATOR, sandbox } from '../core/testkit.js';
import { getScorecard } from '../eval/scorecard.js';
import { worktreeDir } from './context.js';
import { GitRepo } from './git.js';
import { renderReviewMarker } from './markers.js';
import { coordinatorCommands } from './pass.js';
import { attestDelivery } from './attest.js';
import { parseStoreConfig } from './policy.js';
import { planFix } from './stages/fix.js';
import { planSweep } from './stages/sweep.js';
import { FakeStore, fixtureRules, fixtureStoreConfig } from './testkit.js';
import type { PassContext } from './types.js';

it('real fix worktree/dispatch retains interruption and refuses unverified description-only delivery', async (t) => {
  const box = sandbox();
  const target = join(box.root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'required.txt'), 'complete target');
  const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git('branch', 'ticket/1'); git('remote', 'add', 'origin', target);
  const head = git('rev-parse', 'HEAD');
  const store = new FakeStore();
  store.addIssue({ number: 1, labels: [] });
  store.addPull({ number: 1, headRefOid: head, body: 'old description' });
  store.branchHeads.set('ticket/1', head);
  store.addComment(1, renderReviewMarker({ sha: head, findings: 1, independent: true, reviewer: 'fixture',
    bodyDigest: createHash('sha256').update(store.pulls[0]!.body).digest('hex') }));
  let calls = 0;
  let entered!: () => void;
  let resume!: () => void;
  const pausedAtProvider = new Promise<void>((resolve) => { entered = resolve; });
  const continueProvider = new Promise<void>((resolve) => { resume = resolve; });
  const adapter: RuntimeAdapter = {
    capabilities: { runtime: 'claude-local', subscriptionId: 'execution-fixture', supportsModelSelection: true, supportsEffortSelection: true, effortLevels: ['low'], reportsEffectiveSettings: false, acceptsCallerSessionId: false, skillInvocationForm: 'fixture' },
    checkReadiness: async () => undefined,
    readUsage: async () => ({ ok: true, reading: { subscriptionId: 'execution-fixture', observedAt: new Date().toISOString(), source: 'fixture', windows: [{ kind: 'five-hour', usedPercent: 1, vendorLabel: 'fixture' }, { kind: 'weekly', usedPercent: 1, vendorLabel: 'fixture' }] } }),
    reconcile: async () => ({ kind: 'checks-failed', summary: 'fixture stopped', nextAction: 'inspect' }),
    dispatch: async (request) => {
      calls++;
      assert.equal(readFileSync(join(request.repoPath, 'required.txt'), 'utf8'), 'complete target');
      assert.ok(!request.repoPath.startsWith(box.root), 'the actual dispatch runs outside controller state');
      const run = getRun(request.runId)!;
      assert.equal(run.loop?.head, head);
      assert.equal(run.delivery?.status, 'unverified');
      writeFileSync(run.outputPath!, calls === 1 ? 'partial draft' : calls === 2 ? "I'll wait for the lint result before committing." : 'Corrected the description; no commit needed.');
      if (calls === 1) { entered(); await continueProvider; }
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (calls === 3) {
        await store.updatePullBody(1, 'corrected description with verified scope');
        store.pulls[0]!.body = 'corrected description with verified scope';
      }
      return { outcome: { kind: calls === 1 ? 'checks-failed' : 'completed', summary: calls === 1 ? 'local process stopped' : 'runtime settled', nextAction: 'inspect retained evidence' }, settings: { requested: { model: 'model-fix', effort: 'low' }, resolved: { model: 'model-fix', effort: 'low' }, observed: { model: 'unknown', effort: 'unknown' } } };
    },
  };
  const slug = store.repo;
  const triggerSource = `agentsys-loop:${slug}`;
  createGrant(OPERATOR, { repos: [slug], workClasses: ['loop-fix'], triggerSources: [triggerSource], actions: ['author-changes', 'push-branch'], runtimes: ['claude-local'], profiles: ['default'], perTask: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, aggregate: { maxDispatchesPerWindow: 3, windowHours: 24, maxConcurrentRuns: 1 }, reason: 'isolated execution regression' });
  const ctx: PassContext = {
    passId: 'fixture-pass', startedAt: new Date(), options: { dryRun: false }, slug, base: 'dev', baseSha: head, policyRef: 'fixture',
    policy: parseStoreConfig(fixtureStoreConfig({ defaultRung: 4 })), rules: fixtureRules(), repo: new GitRepo(target), store,
    commands: coordinatorCommands(() => adapter), issues: store.issues, merged: [], pulls: store.pulls,
    triggerSource, stateDir: join(box.root, 'controller', '.state', 'loop'),
    comments: (n) => store.comments(n), commits: (n) => store.pullCommits(n), issue: (n) => store.issue(n), forget: () => {}, log: () => {},
  };
  let worker: string | undefined;
  try {
    worker = worktreeDir(ctx, 'fix-1');
    const execute = async () => {
      const plan = await planFix(ctx);
      assert.equal(plan.items[0]?.decision.kind, 'dispatch');
      return plan.items[0]!.act!();
    };
    const interrupted = execute();
    await pausedAtProvider;
    const inFlight = listRuns()[0]!;
    assert.equal(inFlight.status, 'running');
    assert.ok(listReservations().some((reservation) => reservation.state === 'held' && reservation.runId === inFlight.id),
      'the unsettled run retains its reservation');
    await assert.rejects(attestDelivery(OPERATOR, store, { runId: inFlight.id, pr: 1, head, bodyDigest: '0'.repeat(64), reason: 'Checked the partial output' }),
      /completed, dispatched fix\/sweep attempt/);
    resume();
    assert.equal((await interrupted).produced, false);
    const first = listRuns()[0]!;
    assert.equal(first.status, 'checks-failed');
    await assert.rejects(attestDelivery(OPERATOR, store, { runId: first.id, pr: 1, head, bodyDigest: '0'.repeat(64), reason: 'Checked the interrupted attempt' }),
      /completed, dispatched fix\/sweep attempt/);
    assert.equal(first.delivery?.status, 'unverified');
    assert.equal(store.writes.length, 0, 'no partial fix comment is published');
    const unfinished = await execute();
    assert.equal(unfinished.produced, false);
    assert.match(unfinished.summary, /no pushed head.*description edits cannot be attributed/);
    assert.equal(store.writes.length, 0, 'runtime settlement with pending lint consumes no fix round');
    const pendingLint = listRuns().find((run) => run.id !== first.id)!;
    await assert.rejects(attestDelivery(OPERATOR, store, { runId: pendingLint.id, pr: 1, head,
      bodyDigest: createHash('sha256').update('old description').digest('hex'), reason: 'Checked the pending lint attempt' }),
    /stale or unchanged from the dispatch baseline/);
    const attempted = await execute();
    assert.equal(attempted.produced, false, JSON.stringify(attempted));
    assert.match(attempted.summary, /description edits cannot be attributed/);
    const runs = listRuns();
    assert.equal(runs.length, 3);
    assert.equal(new Set(runs.map((run) => run.outputPath)).size, 3);
    assert.equal(readFileSync(first.outputPath!, 'utf8'), 'partial draft');
    const last = runs.find((run) => readFileSync(run.outputPath!, 'utf8') === 'Corrected the description; no commit needed.')!;
    assert.ok(last, 'the completed attempt keeps its reply artifact');
    assert.equal(last.delivery?.status, 'unverified', 'the body change cannot establish worker delivery');
    assert.ok(attempted.summary.includes(last.outputPath!), 'the unverified reason points to retained output');
    assert.equal(store.writes.length, 1, 'only the simulated description edit is written; no fix round is published');
    assert.equal(getScorecard(`card_${last.taskId}`)?.runIds.length, 3);
    assert.ok(listReservations().every((reservation) => reservation.state === 'released'));
    const timing = last.timing!;
    assert.ok(Date.parse(timing.providerEndedAt!) - Date.parse(timing.dispatchStartedAt!) >= 10);
    assert.equal(timing.adoptionEndedAt, undefined, 'there is no automatic adoption for unverified work');
    const bodyDigest = createHash('sha256').update('corrected description with verified scope').digest('hex');
    const entry = await attestDelivery(OPERATOR, store, { runId: last.id, pr: 1, head, bodyDigest,
      reason: 'I checked this attempt\'s retained output and the corrected PR description' });
    assert.equal(entry.runId, last.id);
    assert.equal(entry.reviewCommentAtDispatch, entry.reviewCommentAtAttestation);
    assert.equal(getRun(last.id)?.delivery?.source, 'operator-attested');
    assert.equal(getRun(first.id)?.delivery?.status, 'unverified');
    assert.equal(getRun(pendingLint.id)?.delivery?.status, 'unverified');
    assert.deepEqual(getScorecard(`card_${last.taskId}`)?.attestedDeliveries?.map((d) => d.runId), [last.id]);
    assert.equal(coordinatorCommands().attestedDescription(slug, 1, head)?.bodyDigest, bodyDigest);
    t.diagnostic(JSON.stringify({ fakeProviderOnly: true, timing, setupMs: Date.parse(timing.dispatchStartedAt!) - Date.parse(timing.setupStartedAt!), providerMs: Date.parse(timing.providerEndedAt!) - Date.parse(timing.dispatchStartedAt!), adoptionMs: Date.parse(timing.adoptionEndedAt!) - Date.parse(timing.providerEndedAt!) }));
    assert.equal(git('branch', '--show-current'), 'main', 'the original target checkout stays intact');
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    if (worker) { await ctx.repo.removeWorktree(worker); rmSync(dirname(worker), { recursive: true, force: true }); }
    box.cleanup();
  }
});

it('real sweep dispatch retains no-PR-at-dispatch evidence and only attests the completed attempt', async () => {
  const box = sandbox();
  const target = join(box.root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'required.txt'), 'complete target');
  const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git('branch', 'dev'); git('remote', 'add', 'origin', target); git('fetch', '-q', 'origin', 'dev');
  const head = git('rev-parse', 'HEAD');
  const store = new FakeStore();
  for (const n of [50, 51]) store.addIssue({ number: n, labels: ['auto', 'shaped', 'effort:home', 'type:chore'] });
  const slug = store.repo;
  const triggerSource = `agentsys-loop:${slug}`;
  createGrant(OPERATOR, { repos: [slug], workClasses: ['loop-sweep'], triggerSources: [triggerSource],
    actions: ['author-changes', 'push-branch', 'open-pr'], runtimes: ['claude-local'], profiles: ['default'],
    perTask: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 0 },
    aggregate: { maxDispatchesPerWindow: 2, windowHours: 24, maxConcurrentRuns: 1 }, reason: 'isolated sweep provenance' });
  const adapter: RuntimeAdapter = {
    capabilities: { runtime: 'claude-local', subscriptionId: 'execution-fixture', supportsModelSelection: true,
      supportsEffortSelection: true, effortLevels: ['low'], reportsEffectiveSettings: false,
      acceptsCallerSessionId: false, skillInvocationForm: 'fixture' },
    checkReadiness: async () => undefined,
    readUsage: async () => ({ ok: true, reading: { subscriptionId: 'execution-fixture', observedAt: new Date().toISOString(),
      source: 'fixture', windows: [{ kind: 'five-hour', usedPercent: 1, vendorLabel: 'fixture' },
        { kind: 'weekly', usedPercent: 1, vendorLabel: 'fixture' }] } }),
    reconcile: async () => ({ kind: 'checks-failed', summary: 'fixture stopped', nextAction: 'inspect' }),
    dispatch: async (request) => {
      const ticket = Number(request.taskId.replace('loop-sweep-', ''));
      const run = getRun(request.runId)!;
      assert.equal(run.loop?.sweepNoPullAtDispatch, true);
      assert.deepEqual(await store.pullsFromHead(`ticket/${ticket}`), [], 'the PR was absent at dispatch');
      writeFileSync(join(run.evidenceDir!, 'claude-local-stdout.json'), JSON.stringify({ result: `run-ticket result for #${ticket}: opened a PR` }));
      store.addPull({ number: ticket + 100, headRefName: `ticket/${ticket}`, headRefOid: head,
        baseRefName: 'dev', body: `Ticket #${ticket} delivery` });
      return { outcome: { kind: ticket === 50 ? 'checks-failed' : 'completed', summary: 'fixture result', nextAction: 'inspect' },
        settings: { requested: { model: 'model-sweep', effort: 'low' }, resolved: { model: 'model-sweep', effort: 'low' },
          observed: { model: 'unknown', effort: 'unknown' } } };
    },
  };
  const ctx: PassContext = {
    passId: 'sweep-fixture-pass', startedAt: new Date(), options: { dryRun: false }, slug,
    base: 'dev', baseSha: head, policyRef: 'fixture', policy: parseStoreConfig(fixtureStoreConfig({ defaultRung: 5 })),
    rules: fixtureRules(), repo: new GitRepo(target), store, commands: coordinatorCommands(() => adapter),
    issues: store.issues, merged: [], pulls: store.pulls, triggerSource,
    stateDir: join(box.root, 'controller', '.state', 'loop'),
    comments: (n) => store.comments(n), commits: (n) => store.pullCommits(n), issue: (n) => store.issue(n),
    forget: () => {}, log: () => {},
  };
  try {
    const first = await planSweep(ctx);
    assert.equal(first.items.find((item) => item.ref === '#50')?.decision.kind, 'dispatch');
    assert.equal((await first.items.find((item) => item.ref === '#50')!.act!()).produced, false);
    const interrupted = listRuns().find((run) => run.taskId === 'loop-sweep-50')!;
    assert.equal(interrupted.status, 'checks-failed', interrupted.summary);
    assert.equal(interrupted.delivery?.status, 'unverified');
    await assert.rejects(attestDelivery(OPERATOR, store, { runId: interrupted.id, pr: 150, head,
      reason: 'I saw the PR but the runtime did not finish' }), /completed, dispatched fix\/sweep attempt/);
    const second = await planSweep(ctx);
    assert.equal(second.items.find((item) => item.ref === '#50')?.decision.kind, 'skip');
    assert.equal(second.items.find((item) => item.ref === '#51')?.decision.kind, 'dispatch');
    assert.equal((await second.items.find((item) => item.ref === '#51')!.act!()).produced, false);
    const completed = listRuns().find((run) => run.taskId === 'loop-sweep-51')!;
    assert.equal(completed.loop?.sweepNoPullAtDispatch, true);
    assert.equal(completed.loop?.sweepBase, 'dev');
    assert.equal(completed.delivery?.status, 'unverified');
    assert.match(readFileSync(join(completed.evidenceDir!, 'claude-local-stdout.json'), 'utf8'), /run-ticket result for #51/);
    const entry = await attestDelivery(OPERATOR, store, { runId: completed.id, pr: 151, head,
      reason: 'I checked this run-ticket result, claim, branch and PR' });
    assert.equal(entry.runId, completed.id);
    assert.equal(entry.kind, 'sweep');
    assert.equal(getRun(completed.id)?.delivery?.source, 'operator-attested');
    assert.equal(getRun(interrupted.id)?.delivery?.status, 'unverified');
    assert.ok((await store.comments(51)).some((c) => c.body.includes('Claimed by the coordinator')));
    assert.ok(listReservations().every((reservation) => reservation.state === 'released'));
  } finally {
    for (const n of [50, 51]) rmSync(dirname(worktreeDir(ctx, `sweep-${n}`)), { recursive: true, force: true });
    box.cleanup();
  }
});
