import { activeReservations, getPolicy, reservedPercent, windowRoom } from '../core/admission.js';
import type { UsageReading } from '../core/usage.js';
import { windowOf } from '../core/usage.js';

/** Each metered window's ceiling in force at `now` and the room left under it, worked out as admission works it out. */
export function ceilingLines(reading: UsageReading, now = new Date()): string[] {
  const policy = getPolicy(reading.subscriptionId);
  const held = activeReservations(reading.subscriptionId);
  const lines: string[] = [];
  for (const kind of ['five-hour', 'weekly'] as const) {
    const window = windowOf(reading, kind);
    if (!window || !policy.applicableWindows.includes(kind)) continue;
    const room = windowRoom(policy, kind, window, reading.observedAt, reservedPercent(held, kind), now);
    const ceiling = Number(room.ceilingPercent.toFixed(1));
    lines.push(
      `  ceiling    ${kind.padEnd(9)} ${ceiling}% now, ${Number(room.availablePercent.toFixed(1))}% room after ${room.usedPercent}% used, ${Number(room.reservedPercent.toFixed(1))}% reserved and a ${room.marginPercent}% margin`
      + `${room.hoursToReset !== undefined ? `; resets in ${room.hoursToReset.toFixed(1)}h` : ''}${room.rampNote ? `; ${room.rampNote}` : ''}`,
    );
  }
  return lines;
}

