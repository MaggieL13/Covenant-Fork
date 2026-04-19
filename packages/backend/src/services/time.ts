/**
 * Timezone sovereignty layer.
 *
 * Every date/time calculation that matters for user-facing behavior
 * (agent context, Scribe digests, orchestrator scheduling, greetings,
 * DND checks, thread-name generation) MUST route through this module.
 *
 * Rationale: Node's bundled ICU ships tzdata that can be months behind
 * the current IANA releases. When IANA updates rules (e.g. Paraguay
 * abolishing DST in 2024), Node's `Intl.DateTimeFormat` and
 * `Date.prototype.toLocaleString` return stale offsets until Node
 * releases a minor that bumps ICU — often weeks or months later.
 *
 * `moment-timezone` ships its own tzdata as data files. When IANA
 * updates, `npm update moment-timezone` gives us the new rules
 * immediately, independent of the Node binary.
 *
 * DO NOT import `Intl.DateTimeFormat` or `toLocaleString` with a
 * `timeZone` option anywhere user-visible. Route through these helpers.
 */
import moment from 'moment-timezone';

/** "now" — an injection seam so tests can freeze time. */
export function now(): Date {
  return new Date();
}

/**
 * Local YYYY-MM-DD in the given zone. Used for day-keyed ledgers
 * (digests, hook scheduling, daily_wins).
 */
export function todayLocal(tz: string, at?: Date): string {
  return moment.tz(at ?? now(), tz).format('YYYY-MM-DD');
}

/** HH:mm 24-hour local time in the given zone. */
export function localTimeStr(tz: string, at?: Date): string {
  return moment.tz(at ?? now(), tz).format('HH:mm');
}

/** Full local datestamp: "Sunday, 19 Apr". */
export function localDateStr(tz: string, at?: Date): string {
  return moment.tz(at ?? now(), tz).format('dddd, D MMM');
}

/** Combined "HH:mm DD/MM/YYYY" style for logs/digests. */
export function localFullStr(tz: string, at?: Date): string {
  return moment.tz(at ?? now(), tz).format('DD/MM/YYYY, HH:mm:ss');
}

/** Local hour (0-23) as integer. Used for DND, quiet hours, scheduling. */
export function localHour(tz: string, at?: Date): number {
  return moment.tz(at ?? now(), tz).hour();
}

/** Local minute (0-59) as integer. */
export function localMinute(tz: string, at?: Date): number {
  return moment.tz(at ?? now(), tz).minute();
}

/**
 * Offset string like "-03:00" for the given zone at the given instant.
 * Use this when a label needs to surface the current offset correctly.
 */
export function offsetString(tz: string, at?: Date): string {
  return moment.tz(at ?? now(), tz).format('Z');
}

/**
 * Offset from UTC in MINUTES for the given zone at the given instant.
 * Positive = ahead of UTC, negative = behind. Useful for SQLite
 * `date(col, '+N minutes')` modifiers where day boundaries must be
 * computed in a specific zone.
 */
export function offsetMinutes(tz: string, at?: Date): number {
  return moment.tz(at ?? now(), tz).utcOffset();
}

/**
 * UTC hour for a given moment — useful when an orchestrator check wants
 * the UTC wall time to compare against a configured UTC schedule.
 */
export function utcHour(at?: Date): number {
  return moment.utc(at ?? now()).hour();
}

/**
 * The runtime's local IANA zone id (browser or process default).
 * Used as a fallback when no explicit timezone is configured.
 */
export function systemTimezone(): string {
  return moment.tz.guess();
}

/**
 * Is `tz` a recognized IANA zone? Defensive guard before formatting
 * user-supplied zone strings.
 */
export function isValidTimezone(tz: string): boolean {
  return moment.tz.zone(tz) !== null;
}

/** Raw moment-timezone version + tzdata version, for diagnostics. */
export function tzdataInfo(): { momentVersion: string; dataVersion: string } {
  return {
    momentVersion: moment.version,
    dataVersion: String(moment.tz.dataVersion ?? 'unknown'),
  };
}
