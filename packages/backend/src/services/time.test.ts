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
