import { describe, it, expect } from 'vitest';
import {
  todayLocal,
  localTimeStr,
  localDateStr,
  localFullStr,
  localHour,
  localMinute,
  offsetString,
  utcHour,
  isValidTimezone,
  tzdataInfo,
  parseCron,
  cronNextFireTime,
  isCronSupported,
  parseLocalDateTime,
} from './time.js';

/**
 * Regression suite for the timezone sovereignty layer.
 *
 * The critical invariant under test: Paraguay is UTC−3 year-round (DST
 * abolished 2024). Node's bundled ICU (2024b in Node 22.14 at time of
 * adoption) returns UTC−4 for the same queries — if this suite ever
 * starts reporting UTC−4 for Asuncion, `moment-timezone` has regressed
 * or our routing through Intl has leaked back in.
 */

const ASUNCION = 'America/Asuncion';
// Reference instant: 2026-04-19T22:54:00Z. Used to force deterministic
// offset checks without coupling to wall-clock. At this instant:
//   Paraguay (actual, UTC−3): 19:54 local, Sunday 19 Apr
//   Node's stale ICU (UTC−4): 18:54 local — WRONG
const REF = new Date('2026-04-19T22:54:00Z');

describe('time.ts — timezone sovereignty', () => {
  it('pins Paraguay to UTC-3 year-round (no DST)', () => {
    // Winter (southern hemisphere winter = northern summer)
    expect(offsetString(ASUNCION, new Date('2026-07-15T12:00:00Z'))).toBe('-03:00');
    // Summer
    expect(offsetString(ASUNCION, new Date('2026-01-15T12:00:00Z'))).toBe('-03:00');
  });

  it('produces the correct local time for the bug-repro instant', () => {
    // At 22:54 UTC, Paraguay is 19:54 — matches the browser display
    // Maggie caught in the screenshot. Before this layer existed, the
    // backend returned 18:54 because Node's tzdata was stale.
    expect(localTimeStr(ASUNCION, REF)).toBe('19:54');
  });

  it('produces a correct weekday/day/month label', () => {
    expect(localDateStr(ASUNCION, REF)).toBe('Sunday, 19 Apr');
  });

  it('returns local hour and minute as integers', () => {
    expect(localHour(ASUNCION, REF)).toBe(19);
    expect(localMinute(ASUNCION, REF)).toBe(54);
  });

  it('produces YYYY-MM-DD for day-keyed ledgers', () => {
    expect(todayLocal(ASUNCION, REF)).toBe('2026-04-19');
    // Crossing midnight UTC vs Asuncion: at 02:00 UTC Apr 20, Paraguay
    // (UTC−3) is still 23:00 on Apr 19.
    expect(todayLocal(ASUNCION, new Date('2026-04-20T02:00:00Z'))).toBe('2026-04-19');
  });

  it('produces a full "DD/MM/YYYY, HH:mm:ss" timestamp', () => {
    expect(localFullStr(ASUNCION, REF)).toBe('19/04/2026, 19:54:00');
  });

  it('reports UTC hour independently of local zone', () => {
    expect(utcHour(REF)).toBe(22);
  });

  it('validates known IANA zones', () => {
    expect(isValidTimezone('America/Asuncion')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/A/Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('exposes moment-timezone + tzdata version for diagnostics', () => {
    const info = tzdataInfo();
    expect(info.momentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.dataVersion).toBeTruthy();
  });

  // Sanity cross-check: other zones we expect to still work normally
  // (Europe/London, America/New_York) should agree with common knowledge
  // at the reference instant.
  it('handles non-Paraguay zones correctly as a sanity cross-check', () => {
    // 22:54 UTC on 19 Apr 2026 = 23:54 BST in London (DST is active)
    expect(localTimeStr('Europe/London', REF)).toBe('23:54');
    // 22:54 UTC = 18:54 EDT in New York (DST is active)
    expect(localTimeStr('America/New_York', REF)).toBe('18:54');
  });
});

describe('cron parser + next-fire computation (sovereignty for scheduling)', () => {
  // The core regression: under croner, `0 8 * * *` in America/Asuncion
  // resolves via Node's ICU. Node 22.14 thinks Asunción is UTC−4 (stale
  // tzdata), so croner's computed next-fire is 12:00 UTC ≈ 9 AM local.
  // Reality: Paraguay is UTC−3, so 8 AM local = 11:00 UTC. Our
  // cronNextFireTime uses moment-timezone's tzdata and returns 11:00
  // UTC, which is the correct wall-clock 8 AM.
  it('fires at the correct local wall-clock time even when Node ICU disagrees', () => {
    // Reference moment: 07:30 UTC on 24 Apr 2026 = 04:30 Asunción (UTC−3).
    // Next "0 8 * * *" local fire is 11:00 UTC the same day.
    const from = new Date('2026-04-24T07:30:00.000Z');
    const next = cronNextFireTime('0 8 * * *', 'America/Asuncion', from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-04-24T11:00:00.000Z');
  });

  it('rolls to tomorrow when today\'s fire has already passed', () => {
    // Reference 14:00 UTC = 11:00 Asunción; today's 8 AM already fired.
    const from = new Date('2026-04-24T14:00:00.000Z');
    const next = cronNextFireTime('0 8 * * *', 'America/Asuncion', from);
    expect(next!.toISOString()).toBe('2026-04-25T11:00:00.000Z');
  });

  it('handles fixed minute+hour in a non-DST zone', () => {
    const from = new Date('2026-04-24T10:00:00.000Z');
    const next = cronNextFireTime('30 14 * * *', 'UTC', from);
    expect(next!.toISOString()).toBe('2026-04-24T14:30:00.000Z');
  });

  it('supports step values in the minute field (every 15 min)', () => {
    // 10:07 UTC → next */15 fire is 10:15 UTC
    const from = new Date('2026-04-24T10:07:00.000Z');
    const next = cronNextFireTime('*/15 * * * *', 'UTC', from);
    expect(next!.toISOString()).toBe('2026-04-24T10:15:00.000Z');
  });

  it('supports step values in the hour field (every 6 hours)', () => {
    // 10:00 UTC on the hour → next "0 */6 * * *" is 12:00 UTC
    const from = new Date('2026-04-24T10:00:30.000Z');
    const next = cronNextFireTime('0 */6 * * *', 'UTC', from);
    expect(next!.toISOString()).toBe('2026-04-24T12:00:00.000Z');
  });

  it('supports ranges and lists for fire-time matching', () => {
    // Weekday 2 PM — Tue 21 Apr 2026 at 13:00 UTC → next Wed 22 Apr 14:00 UTC
    const from = new Date('2026-04-21T13:00:00.000Z');
    const weekdays = cronNextFireTime('0 14 * * 1-5', 'UTC', from);
    expect(weekdays!.toISOString()).toBe('2026-04-21T14:00:00.000Z');

    // List: fire at minute 0, 15, 30, or 45 of the hour
    const quarters = cronNextFireTime('0,15,30,45 * * * *', 'UTC', new Date('2026-04-24T10:07:00.000Z'));
    expect(quarters!.toISOString()).toBe('2026-04-24T10:15:00.000Z');
  });

  it('returns null for genuinely unsupported or malformed patterns', () => {
    expect(cronNextFireTime('not-a-cron', 'UTC')).toBeNull();
    expect(cronNextFireTime('0 8 * *', 'UTC')).toBeNull(); // 4 fields
    expect(cronNextFireTime('1-5/2 * * * *', 'UTC')).toBeNull(); // step within range (not supported)
    expect(cronNextFireTime('60 * * * *', 'UTC')).toBeNull(); // out-of-range minute
    expect(cronNextFireTime('0 24 * * *', 'UTC')).toBeNull(); // out-of-range hour
    expect(cronNextFireTime('0 0 32 * *', 'UTC')).toBeNull(); // out-of-range day
  });

  it('parseCron exposes structured fields for introspection', () => {
    expect(parseCron('0 8 * * *')).toEqual({
      minute: { kind: 'fixed', value: 0 },
      hour: { kind: 'fixed', value: 8 },
      dayOfMonth: { kind: 'wildcard' },
      month: { kind: 'wildcard' },
      dayOfWeek: { kind: 'wildcard' },
    });
    expect(parseCron('*/15 * * * *')?.minute).toEqual({ kind: 'step', value: 15 });
    expect(parseCron('0 8 * * 1-5')?.dayOfWeek).toEqual({ kind: 'range', min: 1, max: 5 });
    expect(parseCron('0,30 * * * *')?.minute).toEqual({ kind: 'list', values: [0, 30] });
    expect(parseCron('60 * * * *')).toBeNull(); // out-of-range rejected at parse time
  });

  it('isCronSupported returns true for every supported pattern', () => {
    expect(isCronSupported('0 8 * * *')).toBe(true);
    expect(isCronSupported('*/15 * * * *')).toBe(true);
    expect(isCronSupported('50 23 * * *')).toBe(true);
    expect(isCronSupported('0 14 * * 1-5')).toBe(true); // weekday range
    expect(isCronSupported('0,15,30,45 * * * *')).toBe(true); // list
    expect(isCronSupported('0-10 * * * *')).toBe(true); // range
    expect(isCronSupported('garbage')).toBe(false);
    expect(isCronSupported('60 * * * *')).toBe(false);
    expect(isCronSupported('1-5/2 * * * *')).toBe(false);
  });
});

describe('parseLocalDateTime — intent-aware date/time parsing', () => {
  // Regression: timer creation passed user input directly to `new
  // Date(...)`, which interprets offsetless strings using the SERVER
  // process timezone (Node's bundled ICU). That meant a Caelir-set
  // "2026-04-26 09:00" reminder could fire 1+ hours off depending on
  // where the host thinks Asunción is. parseLocalDateTime resolves
  // offsetless inputs in the explicit identity timezone via moment-tz.

  it('parses offsetless wall-clock in the given timezone (the agent-intent path)', () => {
    // 09:00 wall-clock in Asunción (UTC-3) on 26 Apr 2026 → 12:00 UTC
    expect(
      parseLocalDateTime('America/Asuncion', '2026-04-26T09:00:00')!.toISOString(),
    ).toBe('2026-04-26T12:00:00.000Z');
    // Same wall-clock, different zone — must give a different UTC instant
    expect(
      parseLocalDateTime('Asia/Tokyo', '2026-04-26T09:00:00')!.toISOString(),
    ).toBe('2026-04-26T00:00:00.000Z');
  });

  it('honors explicit Z as absolute UTC regardless of the tz arg', () => {
    expect(
      parseLocalDateTime('America/Asuncion', '2026-04-26T12:00:00Z')!.toISOString(),
    ).toBe('2026-04-26T12:00:00.000Z');
    expect(
      parseLocalDateTime('Asia/Tokyo', '2026-04-26T12:00:00Z')!.toISOString(),
    ).toBe('2026-04-26T12:00:00.000Z');
  });

  it('honors explicit ±HH:MM offset regardless of the tz arg', () => {
    // 09:00-03:00 = 12:00 UTC; the tz parameter must NOT shift it again.
    expect(
      parseLocalDateTime('Europe/London', '2026-04-26T09:00:00-03:00')!.toISOString(),
    ).toBe('2026-04-26T12:00:00.000Z');
  });

  it('accepts "YYYY-MM-DD HH:mm" (space) shape', () => {
    expect(
      parseLocalDateTime('America/Asuncion', '2026-04-26 09:00')!.toISOString(),
    ).toBe('2026-04-26T12:00:00.000Z');
  });

  it('accepts a date-only "YYYY-MM-DD" as midnight in the given zone', () => {
    expect(
      parseLocalDateTime('America/Asuncion', '2026-04-26')!.toISOString(),
    ).toBe('2026-04-26T03:00:00.000Z'); // 00:00 -03 → 03:00 UTC
  });

  it('returns null for malformed or empty input', () => {
    expect(parseLocalDateTime('UTC', '')).toBeNull();
    expect(parseLocalDateTime('UTC', '   ')).toBeNull();
    expect(parseLocalDateTime('UTC', 'tomorrow at 9')).toBeNull();
    expect(parseLocalDateTime('UTC', '2026-13-40')).toBeNull(); // out-of-range
    expect(parseLocalDateTime('UTC', '26 Apr 2026 09:00')).toBeNull(); // unsupported shape
  });
});
