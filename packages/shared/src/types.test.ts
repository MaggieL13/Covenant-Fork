import { describe, it, expect } from 'vitest';
import {
  normalizeThinkingSegment,
  normalizeMessageSegments,
  type RawThinkingSegment,
  type MessageSegment,
} from './types.js';

describe('normalizeThinkingSegment', () => {
  it('coerces a legacy thinking segment (no providerShape) to the claude variant', () => {
    const raw: RawThinkingSegment = {
      type: 'thinking',
      content: 'reasoning text',
      summary: 'short summary',
    };
    expect(normalizeThinkingSegment(raw)).toEqual({
      type: 'thinking',
      providerShape: 'claude',
      content: 'reasoning text',
      summary: 'short summary',
    });
  });

  it('fills in an empty summary when a claude segment is missing one (legacy WS frame)', () => {
    const raw: RawThinkingSegment = {
      type: 'thinking',
      content: 'reasoning',
      providerShape: 'claude',
      // no summary
    };
    const out = normalizeThinkingSegment(raw);
    expect(out).toEqual({
      type: 'thinking',
      providerShape: 'claude',
      content: 'reasoning',
      summary: '',
    });
  });

  it('drops summary on codex segments even when the raw input carried one', () => {
    const raw: RawThinkingSegment = {
      type: 'thinking',
      providerShape: 'codex',
      content: 'codex reasoning',
      summary: 'should-be-dropped',
    };
    const out = normalizeThinkingSegment(raw);
    expect(out).toEqual({
      type: 'thinking',
      providerShape: 'codex',
      content: 'codex reasoning',
    });
    expect(out).not.toHaveProperty('summary');
  });

  it('drops summary on generic segments too', () => {
    const raw: RawThinkingSegment = {
      type: 'thinking',
      providerShape: 'generic',
      content: 'from-some-other-provider',
      summary: 'unused',
    };
    const out = normalizeThinkingSegment(raw);
    expect(out).toEqual({
      type: 'thinking',
      providerShape: 'generic',
      content: 'from-some-other-provider',
    });
    expect(out).not.toHaveProperty('summary');
  });
});

describe('normalizeMessageSegments', () => {
  it('returns null for non-array input (no segments stored on the row)', () => {
    expect(normalizeMessageSegments(null)).toBeNull();
    expect(normalizeMessageSegments(undefined)).toBeNull();
    expect(normalizeMessageSegments({})).toBeNull();
    expect(normalizeMessageSegments('not-an-array')).toBeNull();
  });

  it('returns an empty array unchanged', () => {
    expect(normalizeMessageSegments([])).toEqual([]);
  });

  it('normalizes legacy claude thinking segments missing providerShape', () => {
    // This is the load-bearing case for the legacy-read fix: pre-arc
    // companion messages saved their thinking segments without a
    // providerShape field. Defaulting to 'claude' on the read boundary
    // keeps historical messages rendering correctly through
    // ClaudeThinkingBlock instead of falling through to the generic
    // fallback.
    const legacy = [
      { type: 'text', content: 'before' },
      { type: 'thinking', content: 'old claude reasoning', summary: 'old summary' },
      { type: 'text', content: 'after' },
    ];
    const out = normalizeMessageSegments(legacy);
    expect(out).toEqual<MessageSegment[]>([
      { type: 'text', content: 'before' },
      { type: 'thinking', providerShape: 'claude', content: 'old claude reasoning', summary: 'old summary' },
      { type: 'text', content: 'after' },
    ]);
  });

  it('preserves already-normalized segments (idempotent re-read)', () => {
    const already: MessageSegment[] = [
      { type: 'text', content: 'hi' },
      { type: 'thinking', providerShape: 'codex', content: 'codex thought' },
      { type: 'tool', toolId: 't1', toolName: 'read_file', input: 'x', output: 'y' },
    ];
    expect(normalizeMessageSegments(already)).toEqual(already);
  });

  it('leaves text and tool segments untouched while normalizing only thinking segments', () => {
    const mixed = [
      { type: 'tool', toolId: 't1', toolName: 'fetch', output: 'data' },
      { type: 'thinking', content: 'reasoning', summary: 's' },  // legacy
    ];
    const out = normalizeMessageSegments(mixed);
    expect(out![0]).toEqual(mixed[0]);  // tool unchanged
    expect(out![1]).toMatchObject({ type: 'thinking', providerShape: 'claude' });
  });
});
