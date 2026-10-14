/**
 * Subscription usage readings.
 *
 * A "subscription" is an account allowance, not a runtime. Two runtimes backed by
 * the same account share one subscription id and therefore one admission state —
 * which is why the id lives here rather than on the adapter.
 */
export type WindowKind = 'five-hour' | 'weekly' | 'other';

export interface UsageWindow {
  kind: WindowKind;
  /** Percent of the whole account allowance already consumed, 0-100. */
  usedPercent: number;
  /** Nominal window length. Absent when the vendor does not report one. */
  windowDurationMins?: number;
  resetsAt?: string;
  /** Vendor's own name for this bucket, kept verbatim for auditing. */
  vendorLabel: string;
}

/**
 * Which account a reading came from.
 *
 * Present so an operator can see that the allowance being read is the allowance
 * the runs will spend, rather than a second account that happens to be signed in
 * on this machine. Identifiers only — never a token, and never anything that
 * would let a reader authenticate as the account.
 */
export interface AccountIdentity {
  /** Stable account or organisation id, as the vendor reports it. */
  id: string;
  /** Plan or subscription tier, when the vendor names one. */
  plan?: string;
  /** The supported interface this identity came from. */
  source: string;
}

export interface UsageReading {
  subscriptionId: string;
  observedAt: string;
  /** The supported interface this came from, named so a reader can re-run it. */
  source: string;
  windows: UsageWindow[];
  /** Absent when the runtime exposes no supported way to name its account. */
  account?: AccountIdentity;
}

/**
 * Why a reading could not be taken. Kept as data rather than thrown, because
 * "we could not read usage" must reach the operator as a decision with a next
 * action, not as an exception that some caller might smother into a zero.
 */
export interface UsageUnavailable {
  subscriptionId: string;
  attemptedAt: string;
  source: string;
  reason: string;
  /** What the operator would do about it. */
  operatorAction: string;
}

export type UsageResult =
  | { ok: true; reading: UsageReading }
  | { ok: false; unavailable: UsageUnavailable };

/**
 * Classify a vendor bucket into the two windows the thresholds are written against.
 *
 * Duration decides, never position. The Manifest's own evidence warns that a
 * vendor's `primary`/`secondary` ordering does not reliably mean five-hour and
 * weekly, so an adapter that mapped by position would silently compare a weekly
 * reading against the five-hour threshold.
 */
export function classifyWindow(durationMins: number | undefined, vendorLabel: string): WindowKind {
  if (durationMins !== undefined) {
    // Bands, not equality: vendors report 300 and 10080 but need not be exact.
    if (durationMins >= 60 && durationMins <= 24 * 60) return 'five-hour';
    if (durationMins > 24 * 60) return 'weekly';
    return 'other';
  }
  const l = vendorLabel.toLowerCase();
  if (l.includes('five_hour') || l.includes('5h') || l.includes('session')) return 'five-hour';
  if (l.includes('seven_day') || l.includes('week')) return 'weekly';
  return 'other';
}

/** Pick the window a threshold applies to, or undefined when the vendor did not report it. */
export function windowOf(reading: UsageReading, kind: WindowKind): UsageWindow | undefined {
  return reading.windows.find((w) => w.kind === kind);
}

export function ageSeconds(reading: UsageReading, now = Date.now()): number {
  return Math.max(0, (now - Date.parse(reading.observedAt)) / 1000);
}

/**
 * The instant a window resets, read from its `resetsAt` text.
 *
 * Codex readings carry an ISO instant, which is used as is. Claude readings carry
 * the report's own words — `Oct 2, 1:59am (Europe/Athens)`, or only the time
 * (`3pm (Europe/Athens)`) for a reset within the day — in the zone named in the
 * parenthesis. The text carries no year, so it is taken from the reading's own
 * `observedAt`, rolling into the next year when the date has already passed by
 * more than a month. Text that fits neither form yields no instant: a reset
 * nobody can read is reported as unreadable, never guessed.
 */
export function resetInstant(resetsAt: string, observedAt: string): Date | undefined {
  const text = resetsAt.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const iso = new Date(text);
    return Number.isNaN(iso.getTime()) ? undefined : iso;
  }
  const m = RESET_TEXT.exec(text);
  const observed = Date.parse(observedAt);
  if (!m || Number.isNaN(observed)) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = m;
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const local = localParts(zone!, observed);
  if (!local) return undefined;

  if (monthName === undefined) {
    // Time only: the next such time on the wall clock of the named zone.
    const today = zonedInstant(zone!, local.year, local.month, local.day, hour, minute);
    if (today === undefined) return undefined;
    if (today >= observed - 60_000) return new Date(today);
    const tomorrow = zonedInstant(zone!, local.year, local.month, local.day + 1, hour, minute);
    return tomorrow === undefined ? undefined : new Date(tomorrow);
  }
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  const day = Number(dayText);
  if (month === -1 || day < 1 || day > 31) return undefined;
  let year = local.year;
  let instant = zonedInstant(zone!, year, month, day, hour, minute);
  if (instant !== undefined && instant < observed - 30 * 24 * 3_600_000) {
    year += 1;
    instant = zonedInstant(zone!, year, month, day, hour, minute);
  }
  // A date the month does not have (Feb 30) rolled into the next month; it is not a reset time.
  if (instant === undefined || localParts(zone!, instant)?.day !== day) return undefined;
  return new Date(instant);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_TEXT = /^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i;

interface LocalParts { year: number; month: number; day: number; offsetMs: number }

/** The wall-clock date in `zone` at an instant, and the zone's offset from UTC then; undefined for a zone name the runtime does not know. */
function localParts(zone: string, at: number): LocalParts | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(at));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return { year: get('year'), month: get('month') - 1, day: get('day'), offsetMs: wallAsUtc - Math.floor(at / 1000) * 1000 };
  } catch {
    return undefined;
  }
}

/** The instant at which `zone`'s wall clock reads this date and time. Settles the offset twice, so a time near a clock change lands on the right side of it. */
function zonedInstant(zone: string, year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  const wall = Date.UTC(year, month, day, hour, minute);
  const first = localParts(zone, wall);
  if (!first) return undefined;
  const guess = wall - first.offsetMs;
  const second = localParts(zone, guess);
  return second ? wall - second.offsetMs : undefined;
}
