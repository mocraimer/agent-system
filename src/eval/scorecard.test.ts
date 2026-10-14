import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { saveRun } from '../core/run.js';
import type { RunRecord } from '../core/run.js';
import {
  blockersFor, FeedbackError, getScorecard, groupReport, listScorecards, recordCheckResult,
  recordFeedback, recordRepairCycle, recordReview, saveScorecard, ScorecardEvidenceError,
} from './scorecard.js';
import type { CheckInput, ReviewInput, Scorecard } from './scorecard.js';

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

function card(over: Partial<Scorecard> = {}): Scorecard {
  return {
    id: 'card_t1',
    taskId: 't1',
    repo: 'mocraimer/agent-system',
    workClass: 'ci-repair',
    authority: { type: 'grant', id: 'grant_a', version: 2 },
    runtime: 'pi-local',
    profile: 'default',
    settings: {
      requested: { model: 'gpt-6-astra', effort: 'high' },
      resolved: { model: 'gpt-6-astra', effort: 'high' },
      observed: { model: 'gpt-6-astra', effort: 'high' },
    },
    workflowVersion: 'coordinator@0.1.0',
    attempts: 1,
    runIds: ['run_1'],
    manifestPaths: [],
    checks: [],
    reviewerFindings: [],
    repairs: [],
    usage: {},
    blockers: [],
    finalStatus: 'completed',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  author: 'author-session', reviewer: { id: 'review-session', relationship: 'independent' },
  source: 'code-bugs / report.md', head: 'a'.repeat(40), findings: [{ severity: 'high', summary: 'lost history' }],
  ...over,
});

describe('recorded evaluation evidence', () => {
  it('keeps linked legacy attempts in their scorecard cohort without inventing a loaded build', () => {
    box = sandbox();
    const legacy = card({ id: 'card_old', taskId: 'old', runIds: ['run_old', 'run_null'], workflowVersion: 'coordinator@0.1.0' });
    const digest = 'a'.repeat(64);
    const current = card({ id: 'card_new', taskId: 'new', runIds: ['run_new'], workflowVersion: digest });
    saveScorecard(legacy);
    saveScorecard(current);
    const run = (id: string, taskId: string): RunRecord => ({
      id, taskId, attempt: 1, authority: legacy.authority, limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      runtime: 'pi-local', profile: 'default', actions: ['review'], settings: legacy.settings,
      repo: legacy.repo, workClass: legacy.workClass, startedAt: '2026-09-17T00:00:00Z', status: 'checks-failed',
    } as RunRecord);
    saveRun(run('run_old', 'old'));
    saveRun({ ...run('run_null', 'old'), build: null });
    saveRun({ ...run('run_new', 'new'), build: { digest, revision: null, dirty: false, builtAt: '2026-09-17T00:00:00Z' } });
    const old = groupReport(listScorecards(), { workflowVersion: 'coordinator@0.1.0' });
    assert.equal(old.sampleCount, 1);
    assert.equal(old.attemptCounts.recorded, 2);
    assert.deepEqual(old.recordedAttempts.map((attempt) => attempt.id).sort(), ['run_null', 'run_old']);
    assert.ok(old.recordedAttempts.every((attempt) => !attempt.build), 'the card version is not either old process build');
    const fresh = groupReport(listScorecards(), { workflowVersion: digest });
    assert.equal(fresh.sampleCount, 1);
    assert.deepEqual(fresh.recordedAttempts.map((attempt) => attempt.id), ['run_new']);
  });

  it('attributes mixed-build retries to the build that ran each attempt', () => {
    box = sandbox();
    const oldDigest = 'a'.repeat(64);
    const newDigest = 'b'.repeat(64);
    saveScorecard(card({ workflowVersion: newDigest, attempts: 3, runIds: ['run_old', 'run_new', 'run_legacy'] }));
    const run = (id: string, build?: RunRecord['build']): RunRecord => ({
      id, taskId: 't1', attempt: 1, authority: { type: 'grant', id: 'grant_a', version: 2 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 }, runtime: 'pi-local',
      profile: 'default', actions: ['review'], settings: card().settings,
      repo: 'mocraimer/agent-system', workClass: 'ci-repair',
      startedAt: '2026-09-17T00:00:00Z', status: 'completed',
      ...(build !== undefined ? { build } : {}),
    });
    saveRun(run('run_old', { digest: oldDigest, revision: null, dirty: false, builtAt: '2026-09-17T00:00:00Z' }));
    saveRun(run('run_new', { digest: newDigest, revision: null, dirty: false, builtAt: '2026-09-18T00:00:00Z' }));
    saveRun(run('run_legacy'));

    const old = groupReport(listScorecards(), { workflowVersion: oldDigest });
    assert.equal(old.sampleCount, 0, 'the task card records its latest retry');
    assert.deepEqual(old.recordedAttempts.map((attempt) => attempt.id), ['run_old']);
    const fresh = groupReport(listScorecards(), { workflowVersion: newDigest });
    assert.equal(fresh.sampleCount, 1);
    assert.deepEqual(fresh.recordedAttempts.map((attempt) => attempt.id), ['run_new']);
    const unknown = groupReport(listScorecards(), { workflowVersion: 'unversioned' });
    assert.deepEqual(unknown.recordedAttempts.map((attempt) => attempt.id), ['run_legacy']);
    assert.equal(groupReport(listScorecards(), {}).attemptCounts.recorded, 3);
  });

  it('keeps an old empty card not-reviewed without rewriting it', () => {
    box = sandbox();
    const original = card();
    saveScorecard(original);
    const report = groupReport(listScorecards(), {}).evidence[0]!;
    assert.equal(report.checkStatus, 'not-recorded');
    assert.equal(report.reviewStatus, 'not-reviewed');
    assert.equal(report.independentReviewStatus, 'not-reviewed');
    assert.deepEqual(report.reviews, []);
    assert.deepEqual(getScorecard(original.id), original);
  });

  it('appends checks, reviews and repairs without clearing earlier failures or feedback', () => {
    box = sandbox();
    saveScorecard(card());
    recordFeedback('card_t1', { verdict: 'rework-needed', by: 'op', reason: 'fix it' });
    const head1 = 'a'.repeat(40);
    const head2 = 'b'.repeat(40);
    const head3 = 'c'.repeat(40);
    const at = '2026-06-01T12:00:00.000Z';
    const checks = [
      { name: 'unit', outcome: 'failed' as const, source: 'run/1', head: head1, at },
      { name: 'unit', outcome: 'passed' as const, source: 'run/2', head: head3, at },
    ];
    const repairs = [
      { trigger: 'review-finding' as const, detail: 'retained findings', head: head2, at },
      { trigger: 'failed-check' as const, detail: 'retained repairs', head: head3, at },
    ];
    const firstReview = review({ head: head1, at });
    const secondReview = review({ head: head2, at, findings: [{ severity: 'low', summary: 'repair history missing' }] });
    const cleanReview = review({ head: head3, at, findings: [] });
    recordCheckResult('card_t1', checks[0]!);
    recordReview('card_t1', firstReview);
    recordRepairCycle('card_t1', repairs[0]!);
    recordReview('card_t1', secondReview);
    recordRepairCycle('card_t1', repairs[1]!);
    recordCheckResult('card_t1', checks[1]!);
    recordReview('card_t1', cleanReview);

    const reviews = [firstReview, secondReview, cleanReview].map(({ findings, ...entry }) => ({
      ...entry, reviewer: { ...entry.reviewer, independent: true }, findingCount: findings.length,
    }));
    const findings = [firstReview, secondReview].flatMap(({ findings, ...entry }) =>
      findings.map((finding) => ({ ...entry, reviewer: { ...entry.reviewer, independent: true }, ...finding })));
    const reloaded = getScorecard('card_t1')!;
    const report = groupReport(listScorecards(), {});
    for (const evidence of [reloaded, report.evidence[0]!]) {
      assert.deepEqual(evidence.checks, checks);
      assert.deepEqual(evidence.reviews, reviews);
      assert.deepEqual(evidence.reviewerFindings, findings);
      assert.deepEqual(evidence.repairs, repairs);
    }
    assert.equal(reloaded.feedback?.verdict, 'rework-needed');
    assert.equal(report.failedAttempts, 1);
    assert.deepEqual(reloaded.usage, {}, 'recording evidence must not invent consumption');
  });

  it('requires an explicit immutable head on every new evidence write, even with a candidate head', () => {
    box = sandbox();
    const original = card({ candidateHead: 'a'.repeat(40) });
    saveScorecard(original);
    for (const head of [undefined, '', ' ', 'main', 'refs/heads/main', 'HEAD', 'abc123',
      'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'b'.repeat(63), 'b'.repeat(65)]) {
      const writes = [
        () => recordCheckResult(original.id, { name: 'unit', outcome: 'passed', source: 'run', head } as Parameters<typeof recordCheckResult>[1]),
        () => recordReview(original.id, review({ head } as Partial<ReviewInput>)),
        () => recordRepairCycle(original.id, { trigger: 'failed-check', detail: 'fixed', head } as Parameters<typeof recordRepairCycle>[1]),
      ];
      for (const write of writes) {
        assert.throws(write, ScorecardEvidenceError, `must reject head ${String(head)}`);
        assert.deepEqual(getScorecard(original.id), original);
      }
    }
  });

  it('accepts full SHA-1 and SHA-256 heads without requiring the current candidate or a local commit', () => {
    box = sandbox();
    saveScorecard(card({ candidateHead: 'c'.repeat(40) }));
    for (const head of ['0123456789abcdef'.repeat(2) + 'ABCDEF01', 'ABCDEF0123456789'.repeat(4)]) {
      recordCheckResult('card_t1', { name: 'unit', outcome: 'passed', source: 'run', head });
      recordReview('card_t1', review({ head }));
      recordRepairCycle('card_t1', { trigger: 'failed-check', detail: 'fixed', head });
      const stored = getScorecard('card_t1')!;
      for (const entries of [stored.checks, stored.reviews!, stored.reviewerFindings, stored.repairs]) {
        assert.equal(entries.at(-1)?.head, head);
      }
      assert.equal(stored.feedback, undefined);
      assert.equal(stored.candidateHead, 'c'.repeat(40));
    }
  });

  it('reads and reports old headless evidence without inferring or backfilling heads', () => {
    box = sandbox();
    const legacyReview = {
      author: 'author', reviewer: { id: 'reviewer', relationship: 'independent' as const, independent: true as const },
      source: 'old review', at: '2026-06-01T00:00:00.000Z',
    };
    const original = card({
      candidateHead: 'a'.repeat(40),
      checks: [{ name: 'unit', outcome: 'failed', source: 'old run' }],
      reviews: [{ ...legacyReview, findingCount: 1 }],
      reviewerFindings: [{ ...legacyReview, severity: 'high', summary: 'old finding' }],
      repairs: [{ at: legacyReview.at, trigger: 'failed-check', detail: 'old repair' }],
    });
    saveScorecard(original);
    const report = groupReport(listScorecards(), {});
    const evidence = report.evidence[0]!;
    assert.deepEqual(evidence.checks, original.checks);
    assert.deepEqual(evidence.reviews, original.reviews);
    assert.deepEqual(evidence.reviewerFindings, original.reviewerFindings);
    assert.deepEqual(evidence.repairs, original.repairs);
    assert.deepEqual(getScorecard(original.id), original);
  });

  it('records attributable independent findings with explicit trace and timestamps', () => {
    box = sandbox();
    saveScorecard(card());
    const next = recordReview('card_t1', review({ at: '2026-06-01T12:00:00Z' }));
    assert.deepEqual(next.reviewerFindings[0], {
      author: 'author-session',
      reviewer: { id: 'review-session', relationship: 'independent', independent: true },
      source: 'code-bugs / report.md', head: 'a'.repeat(40), at: '2026-06-01T12:00:00.000Z',
      severity: 'high', summary: 'lost history',
    });
    assert.equal(groupReport([next], {}).evidence[0]?.independentReviewStatus, 'reviewed');
  });

  it('distinguishes completed zero-finding review from no review', () => {
    box = sandbox();
    saveScorecard(card());
    const next = recordReview('card_t1', review({ findings: [] }));
    const result = groupReport([next], {}).evidence[0]!;
    assert.equal(result.reviewStatus, 'reviewed');
    assert.equal(result.independentReviewStatus, 'reviewed');
    assert.deepEqual(result.reviewerFindings, []);
    assert.equal(result.reviews[0]?.findingCount, 0);
    assert.match(result.reviews[0]!.at, /^\d{4}-/);
    assert.equal(next.feedback, undefined, 'review does not create operator acceptance');
  });

  it('keeps an external review count when its detailed findings live on GitHub', () => {
    box = sandbox();
    saveScorecard(card());
    const next = recordReview('card_t1', review({ findings: [], findingCount: 2 }));
    assert.deepEqual(next.reviewerFindings, []);
    assert.equal(next.reviews?.[0]?.findingCount, 2);
  });

  it('records self and non-independent reviews without promoting either', () => {
    box = sandbox();
    saveScorecard(card());
    for (const reviewer of [
      { id: 'author-session', relationship: 'author' as const },
      { id: 'paired-session', relationship: 'not-independent' as const },
    ]) recordReview('card_t1', review({ reviewer, findings: [] }));
    const result = groupReport(listScorecards(), {}).evidence[0]!;
    assert.equal(result.reviewStatus, 'reviewed');
    assert.equal(result.independentReviewStatus, 'not-reviewed');
    assert.deepEqual(result.reviews.map((entry) => entry.reviewer.independent), [false, false]);
  });

  it('rejects independence for equal normalized identities, and inconsistent author attribution', () => {
    box = sandbox();
    const original = card();
    saveScorecard(original);
    assert.throws(() => recordReview('card_t1', review({
      author: ' Author-Session ', reviewer: { id: 'author-session', relationship: 'independent' },
    })), /author cannot be an independent reviewer/);
    assert.throws(() => recordReview('card_t1', review({
      reviewer: { id: 'different-person', relationship: 'author' },
    })), /must use the author identity/);
    assert.deepEqual(getScorecard(original.id), original);
  });

  it('derives the independence boolean instead of trusting a caller-supplied value', () => {
    box = sandbox();
    saveScorecard(card());
    const next = recordReview('card_t1', review({ reviewer: {
      id: 'author-session', relationship: 'author', independent: true,
    } as ReviewInput['reviewer'] }));
    assert.equal(next.reviewerFindings[0]?.reviewer.independent, false);
  });

  it('rejects malformed review batches atomically', () => {
    box = sandbox();
    const original = card();
    saveScorecard(original);
    const invalid: Partial<ReviewInput>[] = [
      { author: ' ' }, { reviewer: { id: '', relationship: 'independent' } },
      { reviewer: { id: 'review-session', relationship: 'yes' as never } },
      { source: '' }, { head: '' }, { at: 'not a timestamp' },
      { findings: undefined as never }, { findings: {} as never },
      { findings: [null as never] },
      { findings: [{ severity: 'high', summary: 'valid' }, { severity: 'high', summary: '' }] },
      { findings: [{ severity: 'fatal' as never, summary: 'invalid severity' }] },
    ];
    for (const input of invalid) {
      assert.throws(() => recordReview(original.id, review(input)), ScorecardEvidenceError);
      assert.deepEqual(getScorecard(original.id), original);
    }
  });

  it('rejects malformed check and repair input without modifying the card', () => {
    box = sandbox();
    const original = card();
    saveScorecard(original);
    for (const over of [{ name: '' }, { source: '' }, { outcome: 'green' }, { at: 'invalid' }, { head: ' ' }]) {
      assert.throws(() => recordCheckResult(original.id, {
        name: 'unit', source: 'run/1', outcome: 'passed', head: 'a'.repeat(40), ...over,
      } as CheckInput), ScorecardEvidenceError);
    }
    for (const over of [{ detail: '' }, { trigger: 'unknown' }, { at: 'invalid' }, { head: '' }]) {
      assert.throws(() => recordRepairCycle(original.id, {
        trigger: 'failed-check', detail: 'fixed it', head: 'a'.repeat(40), ...over,
      } as Parameters<typeof recordRepairCycle>[1]), ScorecardEvidenceError);
    }
    assert.deepEqual(getScorecard(original.id), original);
  });

  it('refuses missing cards and path-shaped ids rather than creating history', () => {
    box = sandbox();
    for (const id of ['card_missing', '../outside', '..', '/tmp/outside']) {
      assert.throws(() => recordCheckResult(id, { name: 'unit', source: 'run/1', outcome: 'passed', head: 'a'.repeat(40) }), ScorecardEvidenceError);
      assert.throws(() => recordReview(id, review()), ScorecardEvidenceError);
      assert.throws(() => recordRepairCycle(id, { trigger: 'failed-check', detail: 'fixed it', head: 'a'.repeat(40) }), ScorecardEvidenceError);
    }
    assert.deepEqual(listScorecards(), []);
  });

  it('can record evidence for non-ASCII and spaced task identifiers', () => {
    box = sandbox();
    const original = card({ id: 'card_tâche one', taskId: 'tâche one' });
    saveScorecard(original);
    const next = recordCheckResult(original.id, { name: 'unit', source: 'run', outcome: 'skipped', head: 'a'.repeat(40) });
    assert.equal(next.checks[0]?.outcome, 'skipped');
    assert.deepEqual(getScorecard(original.id), next);
  });

  it('filters evidence and counts over the same population', () => {
    box = sandbox();
    saveScorecard(card());
    saveScorecard(card({ id: 'card_other', taskId: 'other', repo: 'other/repo' }));
    recordReview('card_other', review());
    const result = groupReport(listScorecards(), { repo: 'mocraimer/agent-system' });
    assert.equal(result.sampleCount, 1);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]?.scorecardId, 'card_t1');
    assert.equal(result.evidence[0]?.reviewStatus, 'not-reviewed');
  });
});

describe('operator feedback', () => {
  it('records a verdict with identity and reason', () => {
    box = sandbox();
    saveScorecard(card());
    const c = recordFeedback('card_t1', { verdict: 'accepted', by: 'operator@example.test', reason: 'looks right' });
    assert.equal(c.feedback?.verdict, 'accepted');
    assert.equal(c.feedback?.by, 'operator@example.test');
  });

  it('refuses an unattributed verdict', () => {
    box = sandbox();
    saveScorecard(card());
    assert.throws(
      () => recordFeedback('card_t1', { verdict: 'accepted', by: '  ', reason: 'x' }),
      FeedbackError,
    );
  });

  it('refuses a verdict with no reason', () => {
    box = sandbox();
    saveScorecard(card());
    assert.throws(
      () => recordFeedback('card_t1', { verdict: 'rejected', by: 'operator@example.test', reason: '' }),
      /needs a reason/,
    );
  });

  it('keeps the earlier verdict when one is corrected', () => {
    box = sandbox();
    saveScorecard(card());
    recordFeedback('card_t1', { verdict: 'accepted', by: 'op', reason: 'first look' });
    const c = recordFeedback('card_t1', { verdict: 'rework-needed', by: 'op', reason: 'found a problem' });
    assert.equal(c.feedback?.verdict, 'rework-needed');
    assert.equal(c.feedback?.supersedes, 'accepted');
    assert.equal(c.feedbackHistory?.length, 1);
    assert.equal(c.feedbackHistory?.[0]?.verdict, 'accepted');
  });
});

describe('what the reports refuse to claim', () => {
  it('leaves unrated real work unrated', () => {
    box = sandbox();
    saveScorecard(card());
    const r = groupReport(listScorecards(), { repo: 'mocraimer/agent-system' });
    assert.equal(r.unrated, 1);
    assert.deepEqual(r.operatorVerdicts, { accepted: 0, 'rework-needed': 0, rejected: 0 });
  });

  it('does not let fixture feedback pass as operator acceptance', () => {
    box = sandbox();
    saveScorecard(card());
    recordFeedback('card_t1', {
      verdict: 'accepted', by: 'replay-suite', reason: 'expected outcome for case 3', isFixture: true,
    });
    const r = groupReport(listScorecards(), {});
    assert.equal(r.operatorVerdicts.accepted, 0, 'a fixture verdict is not an operator verdict');
    assert.equal(r.unrated, 1);
    // It is still stored, so the mechanism is exercised and auditable.
    assert.equal(getScorecard('card_t1')?.feedback?.isFixture, true);
  });

  it('reports counts and a caveat, never a success rate', () => {
    box = sandbox();
    saveScorecard(card({ id: 'card_a', taskId: 'a' }));
    saveScorecard(card({ id: 'card_b', taskId: 'b', finalStatus: 'checks-failed' }));
    const r = groupReport(listScorecards(), {});
    assert.equal(r.sampleCount, 2);
    assert.deepEqual(r.byStatus, { completed: 1, 'checks-failed': 1 });
    assert.match(r.caveat, /not a success rate/);
    assert.doesNotMatch(JSON.stringify(r), /"successRate"|"passRate"/);
  });

  it('counts unresolved work rather than dropping it', () => {
    box = sandbox();
    saveScorecard(card({ id: 'card_a', taskId: 'a', finalStatus: 'running' }));
    saveScorecard(card({ id: 'card_b', taskId: 'b', blockers: ['native runner offline'] }));
    const r = groupReport(listScorecards(), {});
    assert.equal(r.unresolved, 2);
  });

  it('treats unknown usage as unknown, not zero', () => {
    box = sandbox();
    saveScorecard(card({ usage: { paidCallUnknown: true } }));
    const c = getScorecard('card_t1')!;
    assert.equal(c.usage.paidCallUsd, undefined);
    assert.equal(c.usage.paidCallUnknown, true);
  });

  it('marks a contaminated account delta rather than presenting it as per-run cost', () => {
    box = sandbox();
    saveScorecard(card({
      usage: {
        admissionEstimatePercent: { fiveHour: 2, weekly: 1 },
        observedAccountDeltaPercent: { fiveHour: 9, weekly: 3 },
        deltaContaminated: true,
      },
    }));
    assert.equal(getScorecard('card_t1')?.usage.deltaContaminated, true);
  });
});

describe('scorecard blockers', () => {
  it('keeps quota and uncertain outcomes unresolved, but not a checks result', () => {
    assert.deepEqual(blockersFor({ kind: 'quota-waiting', summary: 'allowance unavailable' }), ['allowance unavailable']);
    assert.deepEqual(blockersFor({ kind: 'remote-uncertain', summary: 'remote session unknown' }), ['remote session unknown']);
    assert.deepEqual(blockersFor({ kind: 'completed', summary: 'done' }), []);
    assert.deepEqual(blockersFor({ kind: 'checks-failed', summary: 'checks failed' }), []);
  });
});

describe('grouping comparable work', () => {
  it('groups by authorizing grant', () => {
    box = sandbox();
    saveScorecard(card({ id: 'card_a', taskId: 'a', authority: { type: 'grant', id: 'grant_a', version: 1 } }));
    saveScorecard(card({ id: 'card_b', taskId: 'b', authority: { type: 'grant', id: 'grant_b', version: 1 } }));
    assert.equal(groupReport(listScorecards(), { authorityId: 'grant_a' }).sampleCount, 1);
  });

  it('groups by the effective configuration that actually ran', () => {
    box = sandbox();
    saveScorecard(card({ id: 'card_a', taskId: 'a' }));
    saveScorecard(card({
      id: 'card_b', taskId: 'b',
      settings: {
        requested: { model: 'vendor-default', effort: 'vendor-default' },
        resolved: { model: 'vendor-default', effort: 'vendor-default' },
        observed: { model: 'unknown', effort: 'unknown' },
      },
    }));
    assert.equal(groupReport(listScorecards(), { effectiveConfiguration: 'gpt-6-astra/high' }).sampleCount, 1);
    assert.equal(groupReport(listScorecards(), { effectiveConfiguration: 'unknown/unknown' }).sampleCount, 1);
  });

  it('groups by runtime and workflow version', () => {
    box = sandbox();
    saveScorecard(card({ id: 'card_a', taskId: 'a', runtime: 'pi-local' }));
    saveScorecard(card({ id: 'card_b', taskId: 'b', runtime: 'claude-web', workflowVersion: 'coordinator@0.2.0' }));
    assert.equal(groupReport(listScorecards(), { runtime: 'claude-web' }).sampleCount, 1);
    assert.equal(groupReport(listScorecards(), { workflowVersion: 'coordinator@0.1.0' }).sampleCount, 1);
  });
});


describe('what a scorecard records as a blocker', () => {
  it('records the summary for a run that waited on allowance', () => {
    assert.deepEqual(
      blockersFor({ kind: 'quota-waiting', summary: 'weekly window is full' }),
      ['weekly window is full'],
    );
  });

  it('records it for a run whose remote state is unknown', () => {
    assert.deepEqual(
      blockersFor({ kind: 'remote-uncertain', summary: 'session accepted the prompt' }),
      ['session accepted the prompt'],
    );
  });

  it('records none for a run that finished', () => {
    assert.deepEqual(blockersFor({ kind: 'completed', summary: 'done' }), []);
  });

  it('records none for a run whose checks failed, which is a result and not a blocker', () => {
    // The work ran and was judged. Scoring that as blocked would hide a real
    // failure inside the same bucket as work that never started.
    assert.deepEqual(blockersFor({ kind: 'checks-failed', summary: 'two checks failed' }), []);
  });
});
