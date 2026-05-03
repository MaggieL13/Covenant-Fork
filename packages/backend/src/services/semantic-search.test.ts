import { describe, it, expect } from 'vitest';
import { normalizeSemanticSearchDateFilters } from './semantic-search.js';

/**
 * Regression suite for the date-filter normalization that backs
 * /search-semantic across both the public route and the internal
 * (localhost-only) route. The compensated bug: date-only filters
 * (`YYYY-MM-DD`) used to be compared lex-wise against UTC ISO
 * timestamps in vector-cache, off-by-one for ~3 hours every night
 * around local midnight in any non-UTC timezone.
 *
 * Critical invariants:
 * - Date-only `after` snaps to start of local day in the supplied tz
 * - Date-only `before` snaps to LAST MILLISECOND of local day
 *   (pairs with vector-cache's strict `>` comparison)
 * - Date+time inputs (with or without offset) are not day-expanded
 * - Type validation is internal: non-string filters return error
 *   for the caller to surface as 400
 */

const ASUNCION = 'America/Asuncion';     // UTC−3, no DST
const TOKYO = 'Asia/Tokyo';              // UTC+9, no DST, large positive offset
const LOS_ANGELES = 'America/Los_Angeles'; // UTC−7/−8, observes DST

describe('normalizeSemanticSearchDateFilters', () => {
  it('returns empty result when neither filter is provided', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, {});
    expect(result).toEqual({});
  });

  it('snaps date-only after to start of local day in Asuncion', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { after: '2026-04-21' });
    // Midnight April 21 in Asuncion (UTC−3) = 03:00 UTC
    expect(result).toEqual({ after: '2026-04-21T03:00:00.000Z' });
  });

  it('snaps date-only before to LAST MILLISECOND of local day in Asuncion', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { before: '2026-04-21' });
    // 23:59:59.999 April 21 in Asuncion (UTC−3) = 02:59:59.999 April 22 UTC
    expect(result).toEqual({ before: '2026-04-22T02:59:59.999Z' });
  });

  it('produces a single coherent local-day window when after and before are supplied together', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, {
      after: '2026-04-21',
      before: '2026-04-21',
    });
    expect(result).toEqual({
      after: '2026-04-21T03:00:00.000Z',
      before: '2026-04-22T02:59:59.999Z',
    });
  });

  it('respects a large positive offset (Tokyo, UTC+9)', () => {
    const result = normalizeSemanticSearchDateFilters(TOKYO, {
      after: '2026-04-21',
      before: '2026-04-21',
    });
    // Midnight April 21 Tokyo = 15:00 UTC April 20
    // 23:59:59.999 April 21 Tokyo = 14:59:59.999 UTC April 21
    expect(result).toEqual({
      after: '2026-04-20T15:00:00.000Z',
      before: '2026-04-21T14:59:59.999Z',
    });
  });

  it('handles DST spring-forward correctly via moment endOf(day) (Los Angeles, second Sunday of March)', () => {
    // 2026-03-08 is the US DST spring-forward day. Local clock jumps
    // 02:00 → 03:00, so the local day is 23 hours long. moment.tz
    // endOf('day') still correctly returns 23:59:59.999 of that day.
    const result = normalizeSemanticSearchDateFilters(LOS_ANGELES, {
      after: '2026-03-08',
      before: '2026-03-08',
    });
    // Midnight March 8 LA (PST UTC−8) = 08:00 UTC
    // 23:59:59.999 March 8 LA (PDT UTC−7 after spring-forward) = 06:59:59.999 March 9 UTC
    expect(result).toEqual({
      after: '2026-03-08T08:00:00.000Z',
      before: '2026-03-09T06:59:59.999Z',
    });
  });

  it('passes through a full ISO string with Z without day expansion', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, {
      after: '2026-04-21T15:30:00Z',
      before: '2026-04-21T18:00:00Z',
    });
    expect(result).toEqual({
      after: '2026-04-21T15:30:00.000Z',
      before: '2026-04-21T18:00:00.000Z',
    });
  });

  it('interprets offsetless date+time as wall-clock in the supplied timezone', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, {
      after: '2026-04-21 09:00',
    });
    // 09:00 April 21 Asuncion = 12:00 UTC
    expect(result).toEqual({ after: '2026-04-21T12:00:00.000Z' });
  });

  it('trims surrounding whitespace before detecting date-only shape', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { before: '  2026-04-21  ' });
    // Without trim, the regex would miss and the input would fall through
    // to parseLocalDateTime which returns start-of-day, not end-of-day.
    expect(result).toEqual({ before: '2026-04-22T02:59:59.999Z' });
  });

  it('returns error for non-string after', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { after: 12345 });
    expect(result).toEqual({ error: `'after' must be a string, got number` });
  });

  it('returns error for non-string before', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { before: { day: 21 } });
    expect(result).toEqual({ error: `'before' must be a string, got object` });
  });

  it('reports array-typed filters as "array" rather than "object"', () => {
    // typeof [] returns "object" in JS — distinguish in error messages so
    // a caller sending after: ["2026-04-21"] gets a useful diagnostic.
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { after: ['2026-04-21'] });
    expect(result).toEqual({ error: `'after' must be a string, got array` });
  });

  it('reports null-typed filters as "null" rather than "object"', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { before: null });
    expect(result).toEqual({ error: `'before' must be a string, got null` });
  });

  it('returns error for empty/whitespace-only string', () => {
    expect(normalizeSemanticSearchDateFilters(ASUNCION, { after: '' })).toEqual({
      error: `'after' is empty or whitespace`,
    });
    expect(normalizeSemanticSearchDateFilters(ASUNCION, { before: '   ' })).toEqual({
      error: `'before' is empty or whitespace`,
    });
  });

  it('returns error for unparseable string', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { after: 'not-a-date' });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/Invalid 'after'/);
  });

  it('returns error for malformed date-only string (e.g. invalid month)', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, { after: '2026-13-45' });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/Invalid 'after'/);
  });

  it('treats undefined filters as not provided (no error, no entry in result)', () => {
    const result = normalizeSemanticSearchDateFilters(ASUNCION, {
      after: undefined,
      before: '2026-04-21',
    });
    expect(result).toEqual({ before: '2026-04-22T02:59:59.999Z' });
    expect(result).not.toHaveProperty('after');
  });
});
