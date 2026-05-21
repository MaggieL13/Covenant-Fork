import { describe, it, expect } from 'vitest';
import {
  applyOutputBudget,
  MAX_TOOL_OUTPUT_CHARS,
} from './output-budget.js';

describe('applyOutputBudget', () => {
  it('returns input unchanged when under the cap', () => {
    expect(applyOutputBudget('short text')).toBe('short text');
  });

  it('returns input unchanged when exactly at the cap', () => {
    const text = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(applyOutputBudget(text)).toBe(text);
  });

  it('truncates input over the cap and appends a notice', () => {
    const text = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const out = applyOutputBudget(text);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(out).toContain('[tool output truncated');
    expect(out).toContain('1 chars omitted');
  });

  it('respects a custom max (large enough for notice to fit)', () => {
    const out = applyOutputBudget('a'.repeat(1000), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain('[tool output truncated');
  });

  it('caps strictly even when max is too small to fit the notice (pathological)', () => {
    // Not a production usage — 50KB cap is two orders of magnitude
    // larger than the notice. But the helper still guarantees the
    // output is at most `max` chars; with a tiny max it sacrifices
    // the notice rather than overshoot the cap.
    const out = applyOutputBudget('a'.repeat(1000), 5);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('truncation notice names the cap that fired', () => {
    const text = 'x'.repeat(100);
    const out = applyOutputBudget(text, 50);
    expect(out).toContain('truncated at 50 chars');
  });

  it('truncation notice reports the number of chars omitted', () => {
    const text = 'x'.repeat(60_000);
    const out = applyOutputBudget(text); // default cap
    // 60000 - 50000 = 10000 chars omitted
    expect(out).toContain('10000 chars omitted');
  });

  it('handles inputs much larger than the cap (probe-confirmed 4MB scenario)', () => {
    // Simulates the read_file worst case: 2000 lines × 2000 chars
    // = 4MB. Without the cap, the loop driver would receive all 4MB.
    const text = 'a'.repeat(4 * 1024 * 1024);
    const out = applyOutputBudget(text);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(out).toContain('truncated');
  });
});
