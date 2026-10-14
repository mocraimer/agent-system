import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { savePolicy } from '../core/admission.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import type { UsageReading } from '../core/usage.js';
import { ceilingLines } from './usage.js';

let box: Sandbox | undefined;
afterEach(() => { box?.cleanup(); box = undefined; });

const NOW = new Date('2026-10-01T10:59:00Z');
const reading = (): UsageReading => ({
  subscriptionId: 'claude-max', observedAt: NOW.toISOString(), source: 'test',
  windows: [
    { kind: 'five-hour', usedPercent: 11, vendorLabel: 'Current session', resetsAt: 'Oct 1, 3:59pm (Europe/Athens)' },
    { kind: 'weekly', usedPercent: 66, vendorLabel: 'Current week (all models)', resetsAt: 'Oct 2, 1:59am (Europe/Athens)' },
    { kind: 'other', usedPercent: 0, vendorLabel: 'Current week (Fable)' },
  ],
});

describe('agentsys usage prints each metered window\'s ceiling now and the room under it', () => {
  it('shows the base ceiling and room when no ramp is set', () => {
    box = sandbox();
    savePolicy({ subscriptionId: 'claude-max', fiveHourThresholdPercent: 60, weeklyThresholdPercent: 70, safetyMarginPercent: 5, maxReadingAgeSeconds: 300, applicableWindows: ['five-hour', 'weekly'] });
    assert.deepEqual(ceilingLines(reading(), NOW), [
      '  ceiling    five-hour 60% now, 44% room after 11% used, 0% reserved and a 5% margin; resets in 2.0h',
      '  ceiling    weekly    70% now, -1% room after 66% used, 0% reserved and a 5% margin; resets in 12.0h',
    ]);
  });

  it('shows the ceiling the 24-hour ramp gives at that instant, and the room it leaves', () => {
    box = sandbox();
    savePolicy({ subscriptionId: 'claude-max', fiveHourThresholdPercent: 60, weeklyThresholdPercent: 70, safetyMarginPercent: 5, maxReadingAgeSeconds: 300, applicableWindows: ['five-hour', 'weekly'], weeklyRampHours: 24 });
    const lines = ceilingLines(reading(), NOW);
    // 12h before the reset the ceiling is halfway from 70% to 100%: 85%, leaving 85 - 66 - 5 = 14%.
    assert.equal(lines[1], '  ceiling    weekly    85% now, 14% room after 66% used, 0% reserved and a 5% margin; resets in 12.0h; 24h ramp lifts the ceiling from 70% to 85.0%: 12.0h to reset');
    assert.match(lines[0]!, /five-hour 60% now/, 'the five-hour ceiling does not move');
  });

  it('says so when a ramp is set but the reset time is unreadable', () => {
    box = sandbox();
    savePolicy({ subscriptionId: 'claude-max', fiveHourThresholdPercent: 60, weeklyThresholdPercent: 70, safetyMarginPercent: 5, maxReadingAgeSeconds: 300, applicableWindows: ['five-hour', 'weekly'], weeklyRampHours: 24 });
    const r = reading();
    r.windows[1]!.resetsAt = 'next Tuesday';
    assert.match(ceilingLines(r, NOW)[1]!, /weekly {4}70% now.*24h ramp not applied: the reset time is unreadable/);
  });
});
