import { describe, it, expect } from 'vitest';
import { compareVersions } from './runtime-health.js';

/**
 * Regression suite for runtime-health version comparison and helpers.
 *
 * The critical invariant: `compareVersions("2.1.98", "2.1.111")` must
 * return -1, not 1. String/lexicographic comparison gets this wrong
 * (because '9' > '1' at position 4) — the helper splits on '.' and
 * compares numerically per component to fix this. If this test ever
 * starts reporting a positive number for "2.1.98" vs "2.1.111", the
 * helper has regressed to lex comparison and any model with a
 * minimum-CC-version requirement past 2.1.99 will be wrongly judged
 * "satisfied" by older bundled runtimes.
 */

describe('compareVersions', () => {
  it('returns -1 when a < b at the patch level (multi-digit critical case)', () => {
    // The headline case. Lexically '9' > '1', but 98 < 111 numerically.
    expect(compareVersions('2.1.98', '2.1.111')).toBe(-1);
  });

  it('returns 1 when a > b at the patch level (multi-digit critical case)', () => {
    expect(compareVersions('2.1.111', '2.1.98')).toBe(1);
  });

  it('returns 0 for identical versions', () => {
    expect(compareVersions('2.1.111', '2.1.111')).toBe(0);
  });

  it('compares minor versions correctly', () => {
    expect(compareVersions('2.0.0', '2.1.0')).toBe(-1);
    expect(compareVersions('2.1.0', '2.0.0')).toBe(1);
  });

  it('compares major versions correctly (and dominates over lower components)', () => {
    expect(compareVersions('3.0.0', '2.99.99')).toBe(1);
    expect(compareVersions('2.99.99', '3.0.0')).toBe(-1);
  });

  it('treats missing components as 0', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1', '2.1.5')).toBe(-1);
    expect(compareVersions('2.1.5', '2.1')).toBe(1);
  });

  it('handles zero-padded-looking components numerically', () => {
    // No actual zero-padding in practice (Anthropic uses plain integers),
    // but this confirms the Number() conversion does the right thing.
    expect(compareVersions('2.1.10', '2.1.9')).toBe(1);
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1);
  });

  it('compares Opus 4.7 minimum (2.1.111) against bundled (2.1.98) — the actual real-world case', () => {
    // This is the comparison the panel makes for an Opus 4.7 user with
    // the current bundled SDK. Active < required → status 'outdated'.
    const active = '2.1.98';
    const required = '2.1.111';
    expect(compareVersions(active, required)).toBeLessThan(0);
  });
});
