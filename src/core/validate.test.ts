import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkShape, RecordShapeError, SHAPE_KINDS } from './validate.js';

/**
 * `checkShape` is what stops a malformed stored record reaching code that spreads
 * or iterates a field the type promises is there. It is the enforcement layer for
 * every `readRecord` and `listRecords` call, so it is tested directly rather than
 * only through them.
 */

const VALID_APPROVAL = {
  id: 'apv_1', repo: 'owner/repo', workClass: 'ci-repair',
  runtime: 'pi-local', profile: 'default', version: 1, actions: ['author-changes'],
};

describe('checkShape', () => {
  it('returns a well-formed record unchanged', () => {
    assert.deepEqual(checkShape('approval', 'a.json', VALID_APPROVAL), VALID_APPROVAL);
  });

  it('refuses a record that is not an object', () => {
    for (const bad of [null, 42, 'text', [1, 2, 3]]) {
      assert.throws(() => checkShape('approval', 'a.json', bad), RecordShapeError);
    }
  });

  it('names every missing field, not just the first', () => {
    try {
      checkShape('approval', 'a.json', { id: 'apv_1' });
      assert.fail('expected a RecordShapeError');
    } catch (err) {
      const message = (err as Error).message;
      for (const field of ['repo', 'workClass', 'runtime', 'profile', 'version', 'actions']) {
        assert.match(message, new RegExp(field), `${field} should be named`);
      }
    }
  });

  /**
   * Absence and corruption are different things. An approval written before the
   * tier fields existed must still load; one holding `model: 42` must not, or it
   * reaches authorization as an `Approval` whose tier is a number.
   */
  it('accepts an approval with no tier fields at all', () => {
    const { model: _m, effort: _e, ...legacy } = { ...VALID_APPROVAL, model: 'opus', effort: 'max' };
    assert.doesNotThrow(() => checkShape('approval', 'a.json', legacy));
  });

  it('accepts tier fields that are strings', () => {
    assert.doesNotThrow(
      () => checkShape('approval', 'a.json', { ...VALID_APPROVAL, model: 'opus', effort: 'max' }),
    );
  });

  it('refuses a tier field that is present and not a string', () => {
    for (const bad of [42, { name: 'opus' }, ['opus'], true, null]) {
      assert.throws(
        () => checkShape('approval', 'a.json', { ...VALID_APPROVAL, model: bad }),
        /model \(string when present\)/,
        `model: ${JSON.stringify(bad)} should be refused`,
      );
      assert.throws(
        () => checkShape('approval', 'a.json', { ...VALID_APPROVAL, effort: bad }),
        /effort \(string when present\)/,
        `effort: ${JSON.stringify(bad)} should be refused`,
      );
    }
  });

  it('refuses a field of the wrong type, not merely a missing one', () => {
    assert.throws(
      () => checkShape('approval', 'a.json', { ...VALID_APPROVAL, version: 'one' }),
      /version \(number\)/,
    );
    assert.throws(
      () => checkShape('approval', 'a.json', { ...VALID_APPROVAL, actions: 'author-changes' }),
      /actions \(array\)/,
    );
  });

  it('refuses a kind it has no spec for, rather than passing it through', () => {
    assert.throws(
      () => checkShape('not-a-kind' as never, 'a.json', {}),
      /no shape is defined/,
    );
  });

  it('names the file, so an operator can find the bad record', () => {
    assert.throws(
      () => checkShape('approval', '/state/approvals/apv_1.json', {}),
      /\/state\/approvals\/apv_1\.json/,
    );
  });

  it('says what a malformed record probably means', () => {
    assert.throws(
      () => checkShape('approval', 'a.json', {}),
      /predate a schema change or have been written by an interrupted run/,
    );
  });

  it('has a spec for every kind the store reads', () => {
    // If a new durable record type is added without a spec, `readRecord` would
    // throw for it at runtime. This makes that a test failure instead.
    for (const kind of ['approval', 'grant', 'run', 'job', 'reservation', 'paid-call',
      'scorecard', 'eval-suite', 'active-version']) {
      assert.ok(SHAPE_KINDS.includes(kind), `no shape spec for "${kind}"`);
    }
  });

  it('allows old empty scorecards but rejects malformed or falsely independent review evidence', () => {
    const card = {
      id: 'card_1', taskId: 't1', repo: 'owner/repo', attempts: 1,
      runIds: [], checks: [], reviewerFindings: [], repairs: [], blockers: [],
    };
    const review = {
      author: 'author', reviewer: { id: 'reviewer', relationship: 'independent', independent: true },
      source: 'code-bugs', head: 'sha', at: '2026-06-01T00:00:00Z', findingCount: 0,
    };
    assert.deepEqual(checkShape('scorecard', 'card.json', card), card);
    assert.doesNotThrow(() => checkShape('scorecard', 'card.json', { ...card, reviews: [review] }));
    const { head: _head, ...headless } = review;
    assert.doesNotThrow(() => checkShape('scorecard', 'card.json', {
      ...card, reviews: [headless], reviewerFindings: [{ ...headless, severity: 'high', summary: 'old finding' }],
    }));
    for (const reviews of [null, {}, [null], [{ ...review, findingCount: -1 }],
      [{ ...review, head: null }], [{ ...review, head: 123 }], [{ ...review, head: '' }],
      [{ ...review, reviewer: { ...review.reviewer, id: ' AUTHOR ' } }],
      [{ ...review, reviewer: { ...review.reviewer, relationship: 'author' } }],
    ]) {
      assert.throws(() => checkShape('scorecard', 'card.json', { ...card, reviews }), /reviews/);
    }
    for (const reviewerFindings of [undefined, [null], ['unattributed legacy text'],
      [{ ...review, severity: 'unknown', summary: 'bad' }],
    ]) {
      assert.throws(() => checkShape('scorecard', 'card.json', { ...card, reviewerFindings }), /reviewerFindings/);
    }
    assert.doesNotThrow(() => checkShape('scorecard', 'card.json', {
      ...card, reviewerFindings: [{ ...review, severity: 'high', summary: 'a finding' }],
    }));
  });

  it('the grant spec covers the arrays the authorization path iterates', () => {
    // grantMatches calls .includes() on each of these; a missing one would be a
    // TypeError on the dispatch hot path.
    const grant = {
      id: 'grant_1', status: 'active', version: 1,
      repos: [], workClasses: [], triggerSources: [], actions: [], runtimes: [], profiles: [],
      history: [],
    };
    assert.doesNotThrow(() => checkShape('grant', 'g.json', grant));
    for (const field of ['repos', 'workClasses', 'triggerSources', 'actions', 'runtimes', 'profiles', 'history']) {
      const missing = { ...grant } as Record<string, unknown>;
      delete missing[field];
      assert.throws(
        () => checkShape('grant', 'g.json', missing),
        new RegExp(field),
        `a grant missing ${field} must be refused`,
      );
    }
  });
});
