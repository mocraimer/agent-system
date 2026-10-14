import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'node:test';
import { AGENT_ACTOR, OPERATOR, sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import type { RunRecord } from '../core/run.js';
import { getRun, saveRun } from '../core/run.js';
import { getScorecard, saveScorecard, scorecardFromRun } from '../eval/scorecard.js';
import { FakeStore, SHA } from './testkit.js';
import { coordinatorCommands } from './pass.js';
import { renderReviewMarker } from './markers.js';
import { attestDelivery } from './attest.js';

let box: Sandbox;
beforeEach(() => { box = sandbox(); });
afterEach(() => box.cleanup());

const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
const REPO = 'example-org/larkspur';
const HEAD = SHA('original');
const SHA2 = SHA('changed');
const REASON = 'I inspected this run’s retained output and the PR; this run made the description edit.';

function fixture(stage: 'fix' | 'sweep', options: { taskId?: string; attempt?: number; runId?: string } = {}) {
  const store = new FakeStore();
  const id = options.runId ?? 'run_attest_1';
  const taskId = options.taskId ?? `loop-${stage}-test`;
  const evidenceDir = join(box.root, 'evidence', id);
  const outputPath = join(evidenceDir, 'output.md');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(outputPath, 'Retained completed worker output.\n');
  if (stage === 'sweep') writeFileSync(join(evidenceDir, 'claude-local-stdout.json'), JSON.stringify({ result: 'Created a PR.' }));
  const run: RunRecord = {
    id, taskId, attempt: options.attempt ?? 1, authority: { type: 'grant', id: 'fixture', version: 1 },
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 },
    runtime: 'claude-local', profile: 'default', actions: ['author-changes'],
    settings: {
      requested: { model: 'fixture', effort: 'low' }, resolved: { model: 'fixture', effort: 'low' },
      observed: { model: 'unknown', effort: 'unknown' },
    },
    startedAt: '2026-09-22T00:00:00Z', endedAt: '2026-09-22T00:01:00Z', status: 'completed',
    repo: REPO, runtimeDispatched: true, evidenceDir, outputPath,
    loop: stage === 'fix'
      ? { stage, item: 'PR #40', workType: 'bug', head: HEAD, fixBranch: 'ticket/12', fixBase: 'dev',
        descriptionBeforeDigest: hash('before'), reviewCommentAtDispatch: 91, round: 2 }
      : { stage, item: '#12', workType: 'bug', sweepBase: 'dev', sweepNoPullAtDispatch: true },
    delivery: { status: 'unverified', reason: 'No task artifact has been verified.', evidence: [] },
  };
  saveRun(run);
  saveScorecard(scorecardFromRun(run, { repo: REPO, workClass: `loop-${stage}`, workflowVersion: 'test', loop: run.loop! }));
  const pr = store.addPull({ number: stage === 'fix' ? 40 : 41, headRefName: 'ticket/12', headRefOid: HEAD, baseRefName: 'dev', body: 'after' });
  const reviewId = stage === 'fix' ? store.addComment(40, renderReviewMarker({ sha: HEAD, findings: 1, independent: true, reviewer: 'fixture' })).id : undefined;
  return { store, run, pr, reviewId };
}

const args = (runId: string, pr: number, head = HEAD, bodyDigest?: string) => ({
  runId, pr, head, reason: REASON, ...(bodyDigest ? { bodyDigest } : {}),
});

test('fix description-only delivery is explicitly attributed to one run and current same-run scorecard', async () => {
  const { store, run, reviewId } = fixture('fix');
  const entry = await attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('after')));
  assert.deepEqual({ kind: entry?.kind, pr: entry?.pr, head: entry?.head, bodyDigest: entry?.bodyDigest,
    reviewCommentAtDispatch: entry?.reviewCommentAtDispatch, reviewCommentAtAttestation: entry?.reviewCommentAtAttestation, round: entry?.round },
  { kind: 'description', pr: 40, head: HEAD, bodyDigest: hash('after'), reviewCommentAtDispatch: 91,
    reviewCommentAtAttestation: reviewId, round: 2 });
  assert.equal(getRun(run.id)?.delivery?.source, 'operator-attested');
  assert.equal(getRun(run.id)?.delivery?.by, OPERATOR.id);
  assert.equal(getRun(run.id)?.loop?.wrote, undefined);
  assert.deepEqual(getScorecard(`card_${run.taskId}`)?.loop?.attestedDelivery, entry);
  assert.equal(getScorecard(`card_${run.taskId}`)?.loop?.wrote, undefined);
  assert.deepEqual(store.writes, []);
  assert.ok(getRun(run.id)?.delivery?.evidence.includes(`body sha256:${hash('after')}`));
  assert.deepEqual(coordinatorCommands().attestedDescription(REPO, 40, HEAD),
    { bodyDigest: hash('after'), reviewCommentAtAttestation: reviewId, round: 2 });
  assert.equal(coordinatorCommands().attestedDescription('unrelated/repo', 40, HEAD), undefined,
    'another repository cannot borrow this run\'s attestation');
});

test('a review posted during the fix is still older than the later operator attestation', async () => {
  const { store, run } = fixture('fix');
  const intervening = store.addComment(40, renderReviewMarker({ sha: HEAD, findings: 0, independent: true, reviewer: 'concurrent' }));
  const entry = await attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('after')));
  assert.equal(entry.reviewCommentAtDispatch, 91);
  assert.equal(entry.reviewCommentAtAttestation, intervening.id);
  assert.equal(coordinatorCommands().attestedDescription(REPO, 40, HEAD)?.reviewCommentAtAttestation, intervening.id);
});

test('sweep delivery needs recorded no PR at dispatch, exact ticket branch and base', async () => {
  const { store, run } = fixture('sweep');
  const entry = await attestDelivery(OPERATOR, store, args(run.id, 41));
  assert.equal(entry?.kind, 'sweep');
  assert.equal(entry?.bodyDigest, undefined);
  assert.equal(getRun(run.id)?.delivery?.status, 'delivered');
  assert.deepEqual(store.writes, []);
});

test('fix rejects stale head, stale body digest, unchanged baseline and missing baseline', async () => {
  const { store, run, pr } = fixture('fix');
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 40, SHA2, hash('after'))), /head moved/);
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('not current'))), /stale or unchanged/);
  pr.body = 'before';
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('before'))), /stale or unchanged/);
  const { descriptionBeforeDigest: _baseline, ...withoutBaseline } = run.loop!;
  saveRun({ ...run, loop: withoutBaseline });
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('before'))), /baseline digest/);
  assert.equal(getRun(run.id)?.delivery?.status, 'unverified');
});

test('sweep requires a retained worker result, not only a request directory', async () => {
  const { store, run } = fixture('sweep');
  rmSync(join(run.evidenceDir!, 'claude-local-stdout.json'));
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 41)), /Retained worker result is missing/);
  assert.equal(getRun(run.id)?.delivery?.status, 'unverified');
});

test('sweep rejects absent dispatch no-PR flag and missing base', async () => {
  const { store, run } = fixture('sweep');
  const { sweepNoPullAtDispatch: _noPull, ...withoutNoPull } = run.loop!;
  saveRun({ ...run, loop: withoutNoPull });
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 41)), /absence of a PR/);
  const { sweepBase: _base, ...withoutBase } = run.loop!;
  saveRun({ ...run, loop: withoutBase });
  await assert.rejects(attestDelivery(OPERATOR, store, args(run.id, 41)), /branch and base/);
});

test('interrupted, un-dispatched, evidence-less and wrong actor/repository attempts are refused', async () => {
  const { store, run } = fixture('fix');
  const input = args(run.id, 40, HEAD, hash('after'));
  await assert.rejects(attestDelivery(AGENT_ACTOR, store, input), /Only the configured operator/);
  await assert.rejects(attestDelivery({ kind: 'operator', id: 'not-the-operator' }, store, input), /not the configured operator/);
  const other = new FakeStore();
  Object.defineProperty(other, 'repo', { value: 'elsewhere/repo' });
  await assert.rejects(attestDelivery(OPERATOR, other, input), /in this repository/);
  saveRun({ ...run, status: 'remote-uncertain' });
  await assert.rejects(attestDelivery(OPERATOR, store, input), /completed, dispatched/);
  saveRun({ ...run, runtimeDispatched: false });
  await assert.rejects(attestDelivery(OPERATOR, store, input), /completed, dispatched/);
  saveRun({ ...run, outputPath: join(box.root, 'missing-output.md') });
  await assert.rejects(attestDelivery(OPERATOR, store, input), /Retained worker result is missing/);
  saveRun({ ...run, evidenceDir: join(box.root, 'missing-evidence') });
  await assert.rejects(attestDelivery(OPERATOR, store, input), /Retained worker result is missing/);
});

test('wrong PR, branch, base, or moved current head cannot be attested', async () => {
  const { store, run, pr } = fixture('fix');
  const input = args(run.id, 40, HEAD, hash('after'));
  await assert.rejects(attestDelivery(OPERATOR, store, { ...input, pr: 41 }), /does not match/);
  pr.headRefName = 'ticket/99';
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
  pr.headRefName = 'ticket/12';
  pr.baseRefName = 'main';
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
  pr.baseRefName = 'dev';
  pr.headRefOid = SHA2;
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
});

test('sweep refuses a PR outside the recorded branch, base, head or number', async () => {
  const { store, run, pr } = fixture('sweep');
  const input = args(run.id, 41);
  await assert.rejects(attestDelivery(OPERATOR, store, { ...input, pr: 42 }), /not currently open/);
  pr.headRefName = 'ticket/13';
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
  pr.headRefName = 'ticket/12';
  pr.baseRefName = 'main';
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
  pr.baseRefName = 'dev';
  pr.headRefOid = SHA2;
  await assert.rejects(attestDelivery(OPERATOR, store, input), /not currently open/);
});

test('same facts are idempotent, conflicting facts rejected', async () => {
  const { store, run } = fixture('fix');
  const input = args(run.id, 40, HEAD, hash('after'));
  const first = await attestDelivery(OPERATOR, store, input);
  const second = await attestDelivery(OPERATOR, store, input);
  assert.deepEqual(first, second);
  assert.equal(getScorecard(`card_${run.taskId}`)?.loop?.attestedDelivery?.at, first?.at);
  await assert.rejects(attestDelivery(OPERATOR, store, { ...input, reason: 'Changed account' }), /conflicting attestation/);
  assert.equal(getRun(run.id)?.delivery?.reason, REASON);
});

test('CLI attests through its read-only GitHub store without starting a model', async () => {
  const { run, pr } = fixture('fix');
  const bin = join(box.root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  // Only a PR read is supported: any GitHub write or provider path fails.
  writeFileSync(gh, `#!/usr/bin/env node\nconst command = process.argv.slice(2).join(' ');\nif (command.startsWith('pr list --repo ${REPO} --head ticket/12 --state all')) {\n  process.stdout.write(${JSON.stringify(JSON.stringify([pr]))});\n} else if (command.startsWith('api repos/${REPO}/issues/40/comments --paginate')) {\n  process.stdout.write('');\n} else { process.stderr.write('unexpected gh call'); process.exit(2); }\n`);
  chmodSync(gh, 0o755);
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');
  const { stdout } = await promisify(execFile)(process.execPath, [cli,
    'attest-delivery', '--run', run.id, '--pr', '40', '--head', HEAD, '--body-digest', hash('after'),
    '--reason', REASON, '--as', OPERATOR.id,
  ], { env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
  assert.match(stdout, /Operator-attested delivery/);
  assert.match(stdout, /not automatic delivery or merge approval/);
  assert.equal(getRun(run.id)?.delivery?.source, 'operator-attested');
});

test('attesting an earlier attempt never credits a later attempt or changes its scorecard loop', async () => {
  const { store, run, reviewId } = fixture('fix');
  const later = { ...run, id: 'run_later', attempt: 2, loop: { stage: 'fix', item: 'PR #40', workType: 'bug' } } as RunRecord;
  saveRun(later);
  const card = getScorecard(`card_${run.taskId}`)!;
  saveScorecard({ ...card, runIds: [run.id, later.id], loop: later.loop! });
  await attestDelivery(OPERATOR, store, args(run.id, 40, HEAD, hash('after')));
  assert.equal(getRun(run.id)?.delivery?.status, 'delivered');
  assert.equal(getRun(later.id)?.delivery?.status, 'unverified');
  assert.equal(getScorecard(card.id)?.loop?.attestedDelivery, undefined);
  assert.equal(getScorecard(card.id)?.attestedDeliveries?.[0]?.runId, run.id,
    'historical attestation remains on the task without claiming the later run delivered it');
  assert.deepEqual(coordinatorCommands().attestedDescription(REPO, 40, HEAD),
    { bodyDigest: hash('after'), reviewCommentAtAttestation: reviewId, round: 2 });
});
