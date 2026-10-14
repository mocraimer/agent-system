import type { WindowVerdict } from '../core/admission.js';
import { tierLabel } from './policy.js';
import type { Tier } from './policy.js';

/**
 * Choosing between a stage's options by the weekly room that would lapse soonest.
 *
 * A window's unspent room is lost when it resets, so the option whose room is
 * largest *per hour left before its reset* is the one to spend first. This file
 * holds the arithmetic and the wording and touches no coordinator path, so the
 * ranking is testable on numbers alone.
 */

/** Hours a window is taken to have left when its reset time cannot be read: a week, so an unreadable reset neither favours nor starves its family. */
export const UNREADABLE_RESET_HOURS = 168;

/** The floor under hours-to-reset in a score: a window about to reset ranks very high, not infinite. */
const MIN_HOURS = 0.25;

/** One option's weekly window, as admission read it for this run. */
export interface WeeklyRoom {
  /** What the window has left under the ceiling, after used, reserved, the margin and this run's own bound. */
  roomPercent: number;
  /** The ceiling in force now: the policy's, or the ramp's. */
  ceilingPercent: number;
  usedPercent: number;
  reservedPercent: number;
  marginPercent: number;
  /** This run's own bound, with the uncertainty admission adds to it. */
  boundPercent: number;
  hoursToReset: number;
  /** False when the reset time was unreadable and `UNREADABLE_RESET_HOURS` stands in for it. */
  resetKnown: boolean;
  rampNote?: string;
}

export function weeklyRoom(verdict: WindowVerdict | undefined): WeeklyRoom | undefined {
  if (!verdict) return undefined;
  return {
    roomPercent: verdict.availablePercent - verdict.estimatePercent,
    ceilingPercent: verdict.thresholdPercent,
    usedPercent: verdict.usedPercent,
    reservedPercent: verdict.reservedPercent,
    marginPercent: verdict.marginPercent,
    boundPercent: verdict.estimatePercent,
    hoursToReset: verdict.hoursToReset ?? UNREADABLE_RESET_HOURS,
    resetKnown: verdict.hoursToReset !== undefined,
    ...(verdict.rampNote !== undefined ? { rampNote: verdict.rampNote } : {}),
  };
}

/** Percent of the allowance per hour until reset: how fast this room is being lost. */
export function scoreOf(room: WeeklyRoom): number {
  return room.roomPercent / Math.max(room.hoursToReset, MIN_HOURS);
}

export interface OptionReport {
  tier: Tier;
  /** Why it could not start now; absent when it can. */
  unavailable?: string;
  room?: WeeklyRoom;
}

/**
 * The options that can start, best first. Equal scores keep table order, and an
 * option whose weekly window was not metered scores 0 rather than dropping out.
 */
export function rankOptions(reports: readonly OptionReport[]): OptionReport[] {
  return reports
    .map((report, index) => ({ report, index, score: report.room ? scoreOf(report.room) : 0 }))
    .filter(({ report }) => report.unavailable === undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ report }) => report);
}

const pct = (n: number): string => `${Number(n.toFixed(1))}%`;

function describe(report: OptionReport): string {
  const { room } = report;
  const numbers = room
    ? `weekly ${pct(room.usedPercent)} used${room.reservedPercent > 0 ? ` and ${pct(room.reservedPercent)} reserved` : ''} under a ${pct(room.ceilingPercent)} ceiling with a ${pct(room.marginPercent)} margin leaves ${pct(room.roomPercent)} after this run's ${pct(room.boundPercent)} bound, `
      + `${room.resetKnown ? `${room.hoursToReset.toFixed(1)}h to reset` : `reset unreadable, ${UNREADABLE_RESET_HOURS}h assumed`}, ${Number(scoreOf(room).toFixed(2))}%/h`
    : report.unavailable === undefined ? 'no weekly window metered' : undefined;
  return `${tierLabel(report.tier)}:${numbers === undefined ? '' : ` ${numbers}`}${report.unavailable ? `${numbers === undefined ? '' : ' —'} could not start: ${report.unavailable}` : ''}`;
}

/** The one pass-log line a choice writes: what ran, and every option's numbers or reason. */
export function renderChoice(stage: string, subject: string, chosen: Tier | undefined, reports: readonly OptionReport[]): string {
  return `choice ${stage} ${subject}: ${chosen ? `ran ${tierLabel(chosen)}` : 'no option could start'} | ${reports.map(describe).join(' | ')}`;
}
