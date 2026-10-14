import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as markers from './markers.js';
import { FIXTURE_MARKER_PREFIX } from './testkit.js';

/**
 * Every marker follows the repository's prefix only if `useMarkerPrefix` assigns
 * it. A marker declared without being added there keeps its placeholder and
 * silently matches nothing; these tests make that gap fail.
 */
describe('useMarkerPrefix', () => {
  afterEach(() => markers.useMarkerPrefix(FIXTURE_MARKER_PREFIX));
  const SHA = 'a'.repeat(40);

  it('points every exported marker at the new prefix', () => {
    markers.useMarkerPrefix('acme-co');
    const exported = Object.entries(markers).filter(([name, value]) => typeof value === 'string' && /MARKER/.test(name));
    assert.ok(exported.length >= 10, 'the exported markers were found');
    for (const [name, value] of exported) assert.match(value as string, /^<!-- acme-co-/, `${name} follows the prefix`);
  });

  it('parses what it renders under the new prefix, and nothing under the old one', () => {
    markers.useMarkerPrefix('acme-co');
    const rendered = [
      markers.renderReviewMarker({ sha: SHA, findings: 2, independent: true, reviewer: 'm·high' }),
      markers.renderFixMarker({ round: 1, from: SHA, to: SHA }),
      markers.renderAppliedMarker({ comment: 7, head: SHA }),
      markers.renderAcceptedMarker(SHA),
      markers.renderReviewAgainMarker({ head: SHA, counted: 3 }),
      markers.renderDeclinedMarker({ label: 'apply-comment', key: 'b'.repeat(16) }),
      markers.renderFaultMarker('c'.repeat(16)),
      markers.renderVerificationMarker(SHA),
    ];
    const parsed = (bodies: string[]): unknown[] => {
      const comments = bodies.map((body) => ({ body }));
      return [
        markers.parseReviewMarkers(bodies[0]!)[0]?.findings,
        markers.parseFixMarkers(bodies[1]!)[0]?.round,
        markers.appliedComments(comments)[0],
        markers.acceptedHeads(comments)[0],
        markers.newestReviewRestart(comments)?.counted,
        markers.newestDeclinedKey(comments, 'apply-comment'),
        markers.parseFaultMarker(bodies[6]!),
        markers.verificationHeads(bodies[7]!)[0],
      ];
    };
    assert.deepEqual(parsed(rendered), [2, 1, 7, SHA, 3, 'b'.repeat(16), 'c'.repeat(16), SHA]);
    assert.ok(rendered.every((body) => markers.writtenByLoop(body)), 'the loop recognises each as its own');

    markers.useMarkerPrefix('other');
    assert.deepEqual(parsed(rendered), Array(8).fill(undefined), 'another prefix reads none of them');
  });
});
