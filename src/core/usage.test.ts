import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetInstant } from './usage.js';

describe('resetInstant', () => {
  const rows: Array<[observed: string, text: string, instant: string]> = [
    ['2026-10-01T07:57:49Z', 'Oct 2, 1:59am (Europe/Athens)', '2026-10-01T22:59:00.000Z'],
    ['2026-10-01T07:57:49Z', 'Oct 2, 2am (Europe/Athens)', '2026-10-01T23:00:00.000Z'],
    ['2026-10-01T07:57:49Z', 'Oct 1, 2pm (Europe/Athens)', '2026-10-01T11:00:00.000Z'],
    // The report names no year: the new one is read from where the reading was taken.
    ['2026-12-31T20:00:00Z', 'Jan 1, 5am (Europe/Athens)', '2027-01-01T03:00:00.000Z'],
  ];
  for (const [observed, text, instant] of rows) {
    it(`reads "${text}" seen at ${observed} as ${instant}`, () => {
      assert.equal(resetInstant(text, observed)?.toISOString(), instant);
    });
  }

  it('uses the zone named in the text, daylight saving included', () => {
    // Athens is at +3 until the clock change on 2026-10-25 and at +2 after it.
    assert.equal(resetInstant('Oct 24, 12am (Europe/Athens)', '2026-10-20T00:00:00Z')?.toISOString(), '2026-10-23T21:00:00.000Z');
    assert.equal(resetInstant('Oct 26, 12am (Europe/Athens)', '2026-10-20T00:00:00Z')?.toISOString(), '2026-10-25T22:00:00.000Z');
    assert.equal(resetInstant('Oct 2, 12pm (America/New_York)', '2026-10-01T07:57:49Z')?.toISOString(), '2026-10-02T16:00:00.000Z');
  });

  it('reads a reset given as a time of day as the next such time', () => {
    assert.equal(resetInstant('1:59pm (Europe/Athens)', '2026-10-01T07:57:49Z')?.toISOString(), '2026-10-01T10:59:00.000Z');
    assert.equal(resetInstant('9am (Europe/Athens)', '2026-10-01T07:57:49Z')?.toISOString(), '2026-10-02T06:00:00.000Z');
  });

  it('keeps a Codex ISO instant as it is', () => {
    assert.equal(resetInstant('2026-10-03T17:13:38.000Z', '2026-10-01T07:57:49Z')?.toISOString(), '2026-10-03T17:13:38.000Z');
  });

  it('returns no instant for text it cannot read, without throwing', () => {
    for (const text of ['', 'soon', 'Oct 2, 1:59am', 'Oct 2, 1:59am (Not/AZone)', 'Oct 32, 1:59am (Europe/Athens)', 'Feb 30, 1am (Europe/Athens)', 'Oct 2, 13pm (Europe/Athens)', '2026-13-45T99:00:00Z']) {
      assert.equal(resetInstant(text, '2026-10-01T07:57:49Z'), undefined, `"${text}"`);
    }
    assert.equal(resetInstant('Oct 2, 1:59am (Europe/Athens)', 'not a date'), undefined);
  });
});
