import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, assertOperatorDeferrals } from './evidence.js';
import type { EvidenceItem, RequiredCheck } from './evidence.js';
import type { CandidateIdentity } from './run.js';

const CANDIDATE: CandidateIdentity = {
  repo: 'example-org/larkspur',
  base: 'dev',
  head: 'f6972a77d71f7ab4dcd13832131676d7e32dc4c2',
  backendRevisions: { processUpload: 'rev-99' },
};

const REQUIRED: RequiredCheck[] = [
  { name: 'unit', requiredClass: 'emulator' },
  { name: 'real-import', requiredClass: 'real-provider', fixtureVersion: 'bookshelf-v1' },
];

function item(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    check: 'unit',
    class: 'emulator',
    reportedOutcome: 'passed',
    candidate: CANDIDATE,
    observedAt: new Date().toISOString(),
    source: 'ci-run-1',
    ...over,
  };
}

const realItem = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  item({ check: 'real-import', class: 'real-provider', fixtureVersion: 'bookshelf-v1', ...over });

describe('evidence that cannot satisfy a check', () => {
  it('missing evidence leaves the check unmet, not passed', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item()]);
    const v = r.verdicts.find((x) => x.check === 'real-import')!;
    assert.equal(v.satisfied, false);
    assert.equal(v.disqualifier, 'missing');
    assert.equal(r.accepted, false);
  });

  it('a new required check absent from an older report fails it', () => {
    // The older report knew only about `unit`; the configuration now requires more.
    const olderReport = [item()];
    const r = aggregate(CANDIDATE, REQUIRED, olderReport);
    assert.equal(r.accepted, false);
    assert.equal(r.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'missing');
  });

  it('a skipped check has not run', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item({ reportedOutcome: 'skipped' }), realItem()]);
    assert.equal(r.verdicts.find((x) => x.check === 'unit')?.disqualifier, 'skipped');
  });

  it('a failed check is not rescued by being reported', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item({ reportedOutcome: 'failed' }), realItem()]);
    assert.equal(r.verdicts.find((x) => x.check === 'unit')?.disqualifier, 'failed');
  });

  it('a mock cannot satisfy a real-provider check', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem({ class: 'mocked' })]);
    const v = r.verdicts.find((x) => x.check === 'real-import')!;
    assert.equal(v.disqualifier, 'wrong-class');
    assert.match(v.detail, /A mock cannot stand in for a real call/);
  });

  it('evidence from another candidate is superseded, not reused', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [
      item(),
      realItem({ candidate: { ...CANDIDATE, head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }),
    ]);
    assert.equal(r.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'superseded');
  });

  it('unreadable evidence is not a pass', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem({ inaccessible: true })]);
    assert.equal(r.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'inaccessible');
  });

  it('stale evidence cannot stand for the candidate', () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem({ observedAt: old })]);
    assert.equal(r.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'stale');
  });

  it('a wrong fixture version is a configuration mismatch', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem({ fixtureVersion: 'bookshelf-v0' })]);
    assert.equal(r.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'configuration-mismatch');
  });

  it('a matching frontend SHA is not sufficient backend identity', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [
      item(),
      realItem({ candidate: { ...CANDIDATE, backendRevisions: { processUpload: 'rev-01' } } }),
    ]);
    const v = r.verdicts.find((x) => x.check === 'real-import')!;
    assert.equal(v.disqualifier, 'configuration-mismatch');
    assert.match(v.detail, /not sufficient backend identity/);
  });
});

describe('retries do not bury the first failure', () => {
  it('marks a check flaky when an earlier attempt failed', () => {
    // The shape actually observed on deploy run 34252983064: attempt 1 failed,
    // attempt 3 succeeded, and a summary view showed only the latest.
    const r = aggregate(CANDIDATE, REQUIRED, [
      item({ attempt: 1, reportedOutcome: 'failed', source: 'run/attempt/1' }),
      item({ attempt: 3, reportedOutcome: 'passed', source: 'run/attempt/3' }),
      realItem(),
    ]);
    assert.deepEqual(r.flaky, ['unit']);
    assert.equal(r.verdicts.find((x) => x.check === 'unit')?.satisfied, true);
    assert.equal(r.accepted, true, 'the later pass counts, but the earlier failure stays visible');
  });
});

describe('acceptance is not a completion message', () => {
  it('accepts only when every required check is satisfied', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem()]);
    assert.equal(r.accepted, true);
  });

  it('reports each evidence class separately', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem({ class: 'mocked' })]);
    assert.deepEqual(r.byClass['emulator'], { satisfied: 1, required: 1 });
    assert.deepEqual(r.byClass['real-provider'], { satisfied: 0, required: 1 });
    assert.deepEqual(r.byClass['native'], { satisfied: 0, required: 0 });
  });

  it('states the tested scope without implying more', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item(), realItem()]);
    assert.match(r.scopeStatement, /f6972a7/);
    assert.match(r.scopeStatement, /says nothing about untested platforms/);
    assert.match(r.scopeStatement, /does not mean the change is deployed/);
  });

  it('names the candidate in a failing scope statement too', () => {
    const r = aggregate(CANDIDATE, REQUIRED, [item()]);
    assert.match(r.scopeStatement, /did not satisfy every required check/);
    assert.match(r.scopeStatement, /real-provider 0\/1/);
  });
});

/**
 * The operator deferred live extension verification for this phase. These cases use
 * LABELLED DETERMINISTIC FIXTURES — the candidate, checks and evidence below are test
 * data, not records of a real run. They establish how the selection behaves; they are
 * not, and cannot be, the real evidence the retained gates still owe.
 */
describe('a deferred check neither blocks nor counts as coverage', () => {
  const OPERATOR = 'operator@example.test';
  const deferral = {
    reason: 'Live extension verification deferred by the operator for this phase',
    deferredBy: OPERATOR,
    deferredAt: '2026-09-09T11:51:34Z',
  };
  const withNative = (over: Partial<RequiredCheck> = {}): RequiredCheck[] => [
    ...REQUIRED,
    { name: 'extension-native-journey', requiredClass: 'native', deferral, ...over },
  ];

  it('lets the current scope complete while the deferred check has no evidence', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem()]);
    assert.equal(report.accepted, true, 'the deferred check must not block the phase');
    assert.deepEqual(report.deferred, ['extension-native-journey']);
  });

  it('reports the deferred check as untested rather than passed or absent', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem()]);
    const v = report.verdicts.find((x) => x.check === 'extension-native-journey');
    assert.ok(v, 'a deferred check still appears in the report');
    assert.equal(v.satisfied, false, 'deferred is not satisfied');
    assert.equal(v.deferred, true);
    assert.match(v.detail, /Not tested, not passed/);
    assert.match(v.detail, new RegExp(OPERATOR));
  });

  it('names the deferred scope in the sentence that states the result', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem()]);
    assert.match(report.scopeStatement, /Deferred and therefore untested, not passed: extension-native-journey/);
  });

  it('does not count a deferred check as native coverage that was met', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem()]);
    assert.equal(report.byClass.native.required, 0, 'deferred scope is not required coverage');
    assert.equal(report.byClass.native.satisfied, 0);
  });

  it('still blocks on a missing web/backend check while native is deferred', () => {
    // Only the emulator check is offered; the real-provider one is absent.
    const report = aggregate(CANDIDATE, withNative(), [item()]);
    assert.equal(report.accepted, false, 'a deferral elsewhere cannot excuse a missing real check');
    const v = report.verdicts.find((x) => x.check === 'real-import');
    assert.equal(v?.disqualifier, 'missing');
  });

  it('still blocks on a failed web/backend check while native is deferred', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem({ reportedOutcome: 'failed' })]);
    assert.equal(report.accepted, false);
    assert.equal(report.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'failed');
  });

  it('blocks again when a configuration explicitly requires the deferred check', () => {
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem()],
      { enforceDeferred: ['extension-native-journey'] });
    assert.equal(report.accepted, false, 'asking for the check back puts it back to blocking');
    const v = report.verdicts.find((x) => x.check === 'extension-native-journey');
    assert.equal(v?.deferred, undefined);
    assert.equal(v?.disqualifier, 'missing');
    assert.match(v?.detail ?? '', /this configuration requires it anyway/);
    assert.deepEqual(report.deferred, [], 'an enforced check is no longer deferred scope');
  });

  it('accepts an enforced deferred check when its real evidence is actually there', () => {
    const nativeEvidence = item({
      check: 'extension-native-journey', class: 'native', source: 'native-run-1',
    });
    const report = aggregate(CANDIDATE, withNative(), [item(), realItem(), nativeEvidence],
      { enforceDeferred: ['extension-native-journey'] });
    assert.equal(report.accepted, true);
    assert.equal(report.byClass.native.satisfied, 1);
  });

  it('refuses a deferral that did not come from the operator', () => {
    const forged: RequiredCheck[] = [
      ...REQUIRED,
      {
        name: 'extension-native-journey',
        requiredClass: 'native',
        deferral: { ...deferral, deferredBy: 'run_abc123' },
      },
    ];
    assert.throws(() => assertOperatorDeferrals(forged, OPERATOR), /cannot retire a required check/);
    // The operator's own deferral passes the same guard.
    assert.doesNotThrow(() => assertOperatorDeferrals(withNative(), OPERATOR));
  });

  it('does not rewrite an earlier failure as a success when the scope changes', () => {
    // The same candidate, judged before and after the deferral. The real check that
    // failed then still fails now; deferring native scope changes nothing about it.
    const before = aggregate(CANDIDATE, [...REQUIRED, { name: 'extension-native-journey', requiredClass: 'native' }],
      [item(), realItem({ reportedOutcome: 'failed' })]);
    const after = aggregate(CANDIDATE, withNative(), [item(), realItem({ reportedOutcome: 'failed' })]);
    assert.equal(before.accepted, false);
    assert.equal(after.accepted, false, 'a scope change cannot turn a failed check green');
    assert.equal(after.verdicts.find((x) => x.check === 'real-import')?.disqualifier, 'failed');
  });
});
