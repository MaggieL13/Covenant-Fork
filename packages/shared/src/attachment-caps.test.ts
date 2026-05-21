import { describe, it, expect } from 'vitest';
import {
  MAX_BINARY_BYTES_PER_IMAGE,
  MAX_ENCODED_BYTES_PER_TURN,
  MAX_IMAGES_PER_MESSAGE,
  estimateBase64Length,
} from './attachment-caps.js';

describe('attachment-caps — constants', () => {
  it('exposes the documented binary per-image cap (5MB)', () => {
    expect(MAX_BINARY_BYTES_PER_IMAGE).toBe(5 * 1024 * 1024);
  });

  it('exposes the documented encoded per-turn cap (15MB)', () => {
    expect(MAX_ENCODED_BYTES_PER_TURN).toBe(15 * 1024 * 1024);
  });

  it('exposes the documented per-message image count cap (10)', () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBe(10);
  });

  it('caps are internally consistent — 2× per-image binary fits inside per-turn encoded', () => {
    // Two 5MB binary images encode to ~13.34MB — must fit under 15MB.
    const twoMaxImages = estimateBase64Length(2 * MAX_BINARY_BYTES_PER_IMAGE);
    expect(twoMaxImages).toBeLessThan(MAX_ENCODED_BYTES_PER_TURN);
  });
});

describe('estimateBase64Length', () => {
  it('returns 0 for empty input', () => {
    expect(estimateBase64Length(0)).toBe(0);
  });

  it('matches the standard ceil(n/3)*4 formula', () => {
    // Hand-checked cases from the base64 spec.
    expect(estimateBase64Length(1)).toBe(4);   // 1 byte → "XX==" (4 chars)
    expect(estimateBase64Length(2)).toBe(4);   // 2 bytes → "XXX=" (4 chars)
    expect(estimateBase64Length(3)).toBe(4);   // 3 bytes → "XXXX" (4 chars, no padding)
    expect(estimateBase64Length(4)).toBe(8);   // 4 bytes → 8 chars
    expect(estimateBase64Length(9)).toBe(12);  // 9 bytes → 12 chars (no padding)
  });

  it('matches Buffer.toString("base64").length for realistic sizes', () => {
    // Cross-check against Node's actual base64 implementation —
    // protects against drift if anyone "optimizes" the helper.
    for (const size of [100, 1024, 12345, 1024 * 1024]) {
      const actual = Buffer.alloc(size).toString('base64').length;
      expect(estimateBase64Length(size)).toBe(actual);
    }
  });

  it('treats invalid input as zero (defensive — caller passed a NaN file.size)', () => {
    expect(estimateBase64Length(Number.NaN)).toBe(0);
    expect(estimateBase64Length(-1)).toBe(0);
    expect(estimateBase64Length(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
