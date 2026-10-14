import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WindowVerdict } from '../core/admission.js';
import type { Tier } from './policy.js';
import { rankOptions, renderChoice, scoreOf, UNREADABLE_RESET_HOURS, weeklyRoom } from './ranking.js';
import type { OptionReport } from './ranking.js';

const tier = (runtime: Tier['runtime'], model: string): Tier => ({ runtime, model, effort: 'high', fiveHourPercent: 1, weeklyPercent: 1, line: `store-config.md:1: ${model}` });

/** A weekly verdict whose room after the run's own bound is `room`, `hours` before the reset. */
function verdict(room: number, hours: number | undefined, over: Partial<WindowVerdict> = {}): WindowVerdict {
  return {
    kind: 'weekly', thresholdPercent: 70, usedPercent: 0, reservedPercent: 0, marginPercent: 5, estimatePercent: 2,
    availablePercent: room + 2, fits: room >= 0, ...(hours !== undefined ? { hoursToReset: hours } : {}), ...over,
  };
}

const report = (runtime: Tier['runtime'], room: number, hours: number | undefined, unavailable?: string): OptionReport => ({
  tier: tier(runtime, runtime === 'claude-local' ? 'claude-m' : 'gpt-m'),
  room: weeklyRoom(verdict(room, hours))!,
  ...(unavailable ? { unavailable } : {}),
});

describe('ranking a stage\'s options by the weekly room that would lapse soonest', () => {
  const cases: Array<[claude: [number, number], codex: [number, number], first: Tier['runtime']]> = [
    [[30, 10], [60, 100], 'claude-local'],
    [[60, 160], [40, 30], 'pi-local'],
    // Codex has more room, but Claude's is about to be lost.
    [[10, 5], [50, 100], 'claude-local'],
  ];
  for (const [claude, codex, first] of cases) {
    it(`Claude ${claude[0]}% in ${claude[1]}h against Codex ${codex[0]}% in ${codex[1]}h runs ${first} first`, () => {
      assert.equal(rankOptions([report('claude-local', ...claude), report('pi-local', ...codex)])[0]?.tier.runtime, first);
    });
  }

  it('gives equal scores to the first row in the table, whichever family it is', () => {
    assert.equal(rankOptions([report('claude-local', 20, 20), report('pi-local', 20, 20)])[0]?.tier.runtime, 'claude-local');
    assert.equal(rankOptions([report('pi-local', 20, 20), report('claude-local', 20, 20)])[0]?.tier.runtime, 'pi-local');
  });

  it('leaves out an option that cannot start and ranks the rest', () => {
    const ranked = rankOptions([report('claude-local', 90, 1, 'not ready'), report('pi-local', 1, 150)]);
    assert.deepEqual(ranked.map((r) => r.tier.runtime), ['pi-local']);
    assert.deepEqual(rankOptions([report('claude-local', 9, 1, 'no authority'), report('pi-local', 1, 1, 'refused')]), []);
  });

  it('ranks an option whose reset time cannot be read as if its reset were 168 hours away', () => {
    const unread = weeklyRoom(verdict(42, undefined))!;
    assert.equal(unread.hoursToReset, UNREADABLE_RESET_HOURS);
    assert.equal(unread.resetKnown, false);
    assert.equal(scoreOf(unread), 42 / 168);
    // 42% over a week scores 0.25 %/h: it beats a window with 20% and 100h to go, and loses to one with 20% and 40h.
    const unreadable: OptionReport = { tier: tier('pi-local', 'gpt-m'), room: unread };
    assert.equal(rankOptions([report('claude-local', 20, 100), unreadable])[0]?.tier.runtime, 'pi-local');
    assert.equal(rankOptions([report('claude-local', 20, 40), unreadable])[0]?.tier.runtime, 'claude-local');
  });

  it('does not divide by zero in the last minutes before a reset', () => {
    assert.ok(Number.isFinite(scoreOf(weeklyRoom(verdict(5, 0))!)));
  });

  it('measures room after the run\'s own bound under the ceiling in force', () => {
    const room = weeklyRoom(verdict(30, 10, { thresholdPercent: 85, rampNote: '24h ramp lifts the ceiling from 70% to 85%: 12.0h to reset' }))!;
    assert.equal(room.roomPercent, 30);
    assert.equal(room.ceilingPercent, 85);
  });
});

describe('the pass-log line a choice writes', () => {
  it('names the chosen option and, for each option, its numbers or the reason it could not start', () => {
    const claude = report('claude-local', -1, 14, 'admission refused on claude-local: Job does not fit the weekly window');
    const codex = report('pi-local', 48, 62.5);
    const line = renderChoice('shape', '#9', codex.tier, [claude, codex]);
    assert.equal(line, [
      'choice shape #9: ran gpt-m·high on pi-local',
      'claude-m·high on claude-local: weekly 0% used under a 70% ceiling with a 5% margin leaves -1% after this run\'s 2% bound, 14.0h to reset, -0.07%/h — could not start: admission refused on claude-local: Job does not fit the weekly window',
      'gpt-m·high on pi-local: weekly 0% used under a 70% ceiling with a 5% margin leaves 48% after this run\'s 2% bound, 62.5h to reset, 0.77%/h',
    ].join(' | '));
  });

  it('says when a reset time was unreadable and 168 hours stood in for it', () => {
    const unread: OptionReport = { tier: tier('pi-local', 'gpt-m'), room: weeklyRoom(verdict(10, undefined))! };
    assert.match(renderChoice('fix', 'PR #3', unread.tier, [unread]), /reset unreadable, 168h assumed/);
  });

  it('gives only the reason for an option that never reached admission, with no numbers to read', () => {
    const noGrant: OptionReport = { tier: tier('pi-local', 'gpt-m'), unavailable: 'no authority on pi-local: no active grant' };
    assert.equal(renderChoice('shape', '#9', undefined, [noGrant]), 'choice shape #9: no option could start | gpt-m·high on pi-local: could not start: no authority on pi-local: no active grant');
  });

  it('says when no option could start', () => {
    const only = report('claude-local', 3, 4, 'no authority on claude-local');
    assert.match(renderChoice('sweep', '#5', undefined, [only]), /^choice sweep #5: no option could start \| .*could not start: no authority on claude-local$/);
  });
});
