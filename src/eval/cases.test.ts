import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DispatchTaskInput } from '../commands.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { attemptEvidencePins } from '../core/run.js';
import { promptDigest, promptTemplate } from '../loop/prompts.js';
import { completed, outputFileIn, SHA } from '../loop/testkit.js';
import { CaseError, freezeIncidentCase, latestIncidentSuite } from './cases.js';
import { compareConfigurations, freezeSuite, getSuite, listTrials, OracleError } from './oracle.js';
import { parseConfiguration, renderConfiguration, ReplayError, replaySuite } from './replay-run.js';
import { BUILTIN_SCORING, runControls } from './replay.js';

let box: Sandbox;
let scratch: string;
beforeEach(() => { box = sandbox(); scratch = mkdtempSync(join(tmpdir(), 'replay-')); });
afterEach(() => { box.cleanup(); rmSync(scratch, { recursive: true, force: true }); });

const PINS = {
  repo: 'example-org/larkspur', pr: '659', head: SHA('head-659'), base: SHA('base-659'), issue: '636',
  issueBodyHash: 'f'.repeat(64), reviewMarker: 'sha=b2fb7b69 findings=0 independent=yes', promptTemplate: 'review',
  promptDigest: 'a'.repeat(64), tier: 'pi-local/gpt-5.6-luna/max', defectPattern: 'sync.ts',
};

function freeze(subject = 'PR #659', pins: Record<string, string> = PINS) {
  return freezeIncidentCase({ kind: 'reviewer-detects-bad-candidate', expected: 'defect-reported', words: 'the review flags the unbounded retry in web/sync.ts', subject, pins, by: 'octocat' });
}

describe('an incident becomes a frozen case', () => {
  it('writes the case with its pins and pre-stated expectation into a new suite version, frozen', () => {
    const { suite, caseId } = freeze();
    assert.equal(suite.version, 'incidents-1');
    assert.equal(caseId, `incident-pr-659-${PINS.head.slice(0, 8)}`);
    const c = suite.cases[0]!;
    assert.equal(c.expected, 'defect-reported');
    assert.equal(c.isFixture, false);
    assert.deepEqual(c.requiredChecks, ['review']);
    for (const key of ['head', 'base', 'issueBodyHash', 'promptDigest', 'tier', 'reviewMarker']) assert.equal(c.inputs[key], PINS[key as keyof typeof PINS]);
    assert.equal(c.inputs['expectedInWords'], 'the review flags the unbounded retry in web/sync.ts');
    assert.match(suite.oracleDigest, /^[0-9a-f]{16,64}$/);
    assert.deepEqual(getSuite('incidents-1'), suite, 'the suite is on disk as frozen');
  });

  it('a second case goes into the next version, carrying the first; a frozen version never changes', () => {
    const first = freeze().suite;
    const second = freeze('PR #662', { ...PINS, pr: '662', head: SHA('head-662') }).suite;
    assert.equal(second.version, 'incidents-2');
    assert.deepEqual(second.cases.map((c) => c.id), [first.cases[0]!.id, `incident-pr-662-${SHA('head-662').slice(0, 8)}`]);
    assert.deepEqual(getSuite('incidents-1')!.cases.length, 1);
    assert.equal(latestIncidentSuite()?.version, 'incidents-2');
    assert.throws(() => freezeSuite('incidents-1', second.cases, BUILTIN_SCORING), OracleError, 're-freezing a version with a changed case is refused');
    assert.throws(() => freeze(), CaseError, 'the same incident is not frozen twice');
  });

  it('the scorer\'s six controls all degrade against the new version', () => {
    const { suite } = freeze();
    const { controls, allHeld } = runControls(suite);
    assert.equal(controls.length, 6);
    assert.ok(allHeld, controls.filter((c) => !c.held).map((c) => c.id).join(', '));
  });

  it('refuses an expectation the kind cannot observe, no words, or a reviewer case without the words a finding must hold', () => {
    assert.throws(() => freezeIncidentCase({ kind: 'reviewer-detects-bad-candidate', expected: 'completed', words: 'x', subject: 'PR #1', pins: PINS, by: 'm' }), /expects one of defect-reported, defect-missed/);
    assert.throws(() => freezeIncidentCase({ kind: 'approved-repair', expected: 'completed', words: '  ', subject: 'PR #1', pins: {}, by: 'm' }), /in your own words/);
    assert.throws(() => freezeIncidentCase({ kind: 'reviewer-detects-bad-candidate', expected: 'defect-reported', words: 'x', subject: 'PR #1', pins: { head: 'a' }, by: 'm' }), /the words a finding must contain/);
  });
});

describe('a frozen case replays against a configuration and records a trial', () => {
  const fakeRepo = {
    worktrees: [] as string[],
    slug: () => Promise.resolve('example-org/larkspur'),
    fetch: () => Promise.resolve(),
    addWorktree(dir: string, ref: string) { this.worktrees.push(`${dir}@${ref}`); return Promise.resolve(); },
    removeWorktree: () => Promise.resolve(),
  };
  const reviewing = (finding: string) => (input: DispatchTaskInput) => {
    writeFileSync(outputFileIn(input.prompt) ?? join(scratch, 'none.md'), `1. [high] ${finding}\n`, 'utf8');
    return Promise.resolve(completed(input));
  };

  it('reopens and replays an interrupted incident without rewriting its provenance or claiming its draft was delivered', async () => {
    const prior = completed({ taskId: 'interrupted-review', runtime: 'pi-local', settings: {}, actions: ['review'] } as DispatchTaskInput).run!;
    prior.status = 'checks-failed';
    prior.summary = 'local process stopped before settlement';
    prior.build = { digest: 'a'.repeat(64), revision: 'b'.repeat(40), dirty: false, builtAt: '2026-01-01T00:00:00.000Z' };
    prior.runtimeDispatched = true;
    prior.delivery = { status: 'unverified', reason: 'Interrupted; draft only.', evidence: [] };
    prior.outputPath = join(scratch, 'partial.md');
    writeFileSync(prior.outputPath, 'unfinished draft');
    const { suite } = freeze('PR #659', { ...PINS, ...attemptEvidencePins(prior) });
    const reopened = getSuite(suite.version)!;
    const snapshot = JSON.parse(reopened.cases[0]!.inputs['recordedAttempt']!);
    assert.equal(snapshot.status, 'checks-failed');
    assert.equal(snapshot.delivery.status, 'unverified');
    assert.equal(snapshot.build.digest, prior.build.digest);
    assert.ok(reopened.cases[0]!.inputs['attemptOutputDigest']);
    const trial = await replaySuite({ repo: fakeRepo, scratch, pull: () => Promise.resolve({ title: 't', body: 'b' }), dispatch: reviewing('sync.ts defect') }, reopened, parseConfiguration(`review:pi-local/model-x/high:${promptDigest('review').slice(0, 8)}`));
    assert.equal(trial.passed, 1);
    assert.equal(getSuite(suite.version)!.cases[0]!.inputs['recordedAttempt'], reopened.cases[0]!.inputs['recordedAttempt']);
  });

  it('dispatches the review prompt at the pinned head against the pinned base, and scores what it found', async () => {
    const { suite } = freeze();
    const dispatched: DispatchTaskInput[] = [];
    const config = parseConfiguration(`review:pi-local/model-x/high:${promptDigest('review').slice(0, 8)}`);
    const trial = await replaySuite({
      repo: fakeRepo, scratch, approvalId: 'apv_x', pull: () => Promise.resolve({ title: 'feat(sync): retry a failed upload', body: 'body' }),
      dispatch: (input) => { dispatched.push(input); return reviewing('web/sync.ts retries a failed upload forever')(input); },
    }, suite, config);
    assert.equal(dispatched.length, 1);
    const d = dispatched[0]!;
    assert.equal(d.workClass, 'replay-review');
    assert.equal(d.timeoutMs, 3_600_000, 'a replayed review has the review stage\'s hour');
    assert.equal(d.approvalId, 'apv_x');
    assert.deepEqual(d.settings, { model: 'model-x', effort: 'high' });
    assert.equal(d.promptVersion?.digest, promptDigest('review'));
    assert.match(d.prompt, new RegExp(`git diff ${PINS.base}\\.\\.\\.${PINS.head}`));
    assert.ok(fakeRepo.worktrees.some((w) => w.endsWith(`@${PINS.head}`)));
    assert.equal(trial.passed, 1);
    assert.equal(trial.configuration, `review:pi-local/model-x/high:${promptDigest('review').slice(0, 12)}`);
    assert.deepEqual(trial.runs.map((r) => r.observed), ['defect-reported']);
    assert.equal(listTrials().length, 1, 'the trial is recorded');
  });

  it('a review that misses the defect fails the case; a configuration that was never run is not run, not FAIL', async () => {
    const { suite } = freeze();
    const digest = promptDigest('review').slice(0, 8);
    const a = parseConfiguration(`review:pi-local/model-x/high:${digest}`);
    await replaySuite({ repo: fakeRepo, scratch, pull: () => Promise.resolve({ title: 't', body: 'b' }), dispatch: reviewing('the README typo on line 3') }, suite, a);
    const rows = compareConfigurations(listTrials(), renderConfiguration({ ...a, digest: promptDigest('review') }), 'review:claude-local/other/low:0000000000ab');
    assert.deepEqual(rows.map((r) => [r.a, r.b]), [[false, undefined]]);
  });

  it('refuses a configuration whose prompt digest is not the template it would run', async () => {
    const { suite } = freeze();
    await assert.rejects(replaySuite({ repo: fakeRepo, scratch, pull: () => Promise.resolve({ title: 't', body: 'b' }), dispatch: reviewing('x') }, suite, parseConfiguration('review:pi-local/m/e:deadbeef')), ReplayError);
    const drafted = `${promptTemplate('review')}\nA drafted line.`;
    await assert.rejects(replaySuite({ repo: fakeRepo, scratch, pull: () => Promise.resolve({ title: 't', body: 'b' }), dispatch: reviewing('x') }, suite, parseConfiguration(`review:pi-local/m/e:${promptDigest('review').slice(0, 8)}`), drafted), /template given has digest/);
    assert.throws(() => parseConfiguration('shape:pi-local/m/e:deadbeef'), /no replayable case kind/);
    assert.throws(() => parseConfiguration('review pi-local'), /is not a configuration/);
  });
});
