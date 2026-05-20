import { describe, it, expect } from 'vitest';
import { resolveProviderShape, buildSegments, buildCompanionMessageMetadata } from './agent.js';
import { normalizeModelRef, type RuntimeId, type MessageSegment, type MessageProvenance } from '@resonant/shared';

// ─────────────────────────────────────────────────────────────────────────
// Scope: the two pure functions that carry the providerShape invariant
// between the streaming WS broadcast and the persisted message metadata.
// Higher-level integration of the invariant (same Codex turn → codex shape
// on both sides) is enforced by code structure — both broadcast and push
// sites read the same `providerShape` variable computed via this helper.
// We test the helper + the persistence-side segment builder here.
// ─────────────────────────────────────────────────────────────────────────

describe('resolveProviderShape', () => {
  it.each<[RuntimeId, 'claude' | 'codex' | 'generic']>([
    ['claude-sdk', 'claude'],
    ['codex', 'codex'],
    ['openai-compat', 'generic'],
    ['ollama-native', 'generic'],
  ])('maps %s runtime → %s shape', (runtime, expected) => {
    expect(resolveProviderShape(runtime)).toBe(expected);
  });
});

describe('buildSegments — providerShape carrying through to MessageSegment', () => {
  function findThinking(segments: MessageSegment[]) {
    return segments.find((s) => s.type === 'thinking');
  }

  it('claude insertion produces a claude variant with summary preserved', () => {
    const segments = buildSegments('answer text', [], [{
      textOffset: 0,
      content: 'reasoning content',
      summary: 'short surfaced summary',
      providerShape: 'claude',
    }]);
    const thinking = findThinking(segments);
    expect(thinking).toEqual({
      type: 'thinking',
      providerShape: 'claude',
      content: 'reasoning content',
      summary: 'short surfaced summary',
    });
  });

  it('codex insertion produces a codex variant and DROPS summary (Codex has none)', () => {
    const segments = buildSegments('answer text', [], [{
      textOffset: 0,
      content: 'codex reasoning',
      summary: 'would-be-dropped',  // shouldn't appear in output
      providerShape: 'codex',
    }]);
    const thinking = findThinking(segments);
    expect(thinking).toEqual({
      type: 'thinking',
      providerShape: 'codex',
      content: 'codex reasoning',
    });
    // The codex variant of ThinkingSegment has no summary field at all;
    // verifying explicitly so a future regression that re-adds it gets
    // caught here.
    expect(thinking).not.toHaveProperty('summary');
  });

  it('generic insertion drops summary too', () => {
    const segments = buildSegments('answer', [], [{
      textOffset: 0,
      content: 'or-thought',
      summary: 'should-be-dropped',
      providerShape: 'generic',
    }]);
    const thinking = findThinking(segments);
    expect(thinking).toEqual({
      type: 'thinking',
      providerShape: 'generic',
      content: 'or-thought',
    });
    expect(thinking).not.toHaveProperty('summary');
  });

  it('interleaves thinking and text segments at the right offsets regardless of providerShape', () => {
    const segments = buildSegments(
      'Hello world.',
      [],
      [{
        textOffset: 6,
        content: 'reasoning at offset 6',
        summary: 's',
        providerShape: 'codex',
      }],
    );
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: 'text', content: 'Hello ' });
    expect(segments[1]).toMatchObject({ type: 'thinking', providerShape: 'codex' });
    expect(segments[2]).toEqual({ type: 'text', content: 'world.' });
  });

  it('returns empty when there are no insertions (no segments needed)', () => {
    const segments = buildSegments('just text', [], []);
    expect(segments).toEqual([]);
  });
});

describe('buildCompanionMessageMetadata — provenance persistence', () => {
  it('stamps claude provenance on companion messages from a Claude turn', () => {
    const modelRef = normalizeModelRef('claude/claude-sonnet-4-6');
    const meta = buildCompanionMessageMetadata(modelRef, []);
    expect(meta.provenance).toEqual<MessageProvenance>({
      runtimeId: 'claude-sdk',
      providerId: 'claude',
      modelRef: 'claude/claude-sonnet-4-6',
    });
  });

  it('stamps codex provenance on companion messages from a Codex turn', () => {
    const modelRef = normalizeModelRef('openai-codex/gpt-5.5');
    const meta = buildCompanionMessageMetadata(modelRef, []);
    expect(meta.provenance).toEqual<MessageProvenance>({
      runtimeId: 'codex',
      providerId: 'openai-codex',
      modelRef: 'openai-codex/gpt-5.5',
    });
  });

  it('includes segments alongside provenance when there are insertions', () => {
    const modelRef = normalizeModelRef('openai-codex/gpt-5.5');
    const segments: MessageSegment[] = [
      { type: 'text', content: 'hello' },
      { type: 'thinking', providerShape: 'codex', content: 'reasoned' },
    ];
    const meta = buildCompanionMessageMetadata(modelRef, segments);
    expect(meta.segments).toBe(segments);
    expect(meta.provenance).toBeDefined();
  });

  it('omits the segments key entirely when there are no insertions (preserves the previous behavior)', () => {
    const modelRef = normalizeModelRef('claude/claude-sonnet-4-6');
    const meta = buildCompanionMessageMetadata(modelRef, []);
    expect(meta).not.toHaveProperty('segments');
    // Provenance is still always present — that's the load-bearing change.
    expect(meta.provenance).toBeDefined();
  });
});
