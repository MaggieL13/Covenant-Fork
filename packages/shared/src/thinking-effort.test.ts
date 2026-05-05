import { describe, it, expect } from 'vitest';
import { resolveEffortForModel, type ThinkingEffort } from './thinking-effort.js';

describe('resolveEffortForModel', () => {
  describe('explicit override (configured !== auto)', () => {
    it.each<[ThinkingEffort, string]>([
      ['low', 'claude-opus-4-7'],
      ['medium', 'claude-opus-4-7'],
      ['high', 'claude-opus-4-7'],
      ['xhigh', 'claude-opus-4-7'],
      ['max', 'claude-opus-4-7'],
      ['low', 'claude-haiku-4-5'],
      ['max', 'claude-sonnet-4-6'],
    ])('returns %s verbatim regardless of model %s', (configured, model) => {
      expect(resolveEffortForModel(model, configured)).toBe(configured);
    });

    it('respects explicit max even on Haiku (no second-guessing)', () => {
      // Even though Haiku doesn't actually support max — that's the SDK's
      // problem, not the resolver's. User intent wins.
      expect(resolveEffortForModel('claude-haiku-4-5', 'max')).toBe('max');
    });
  });

  describe('auto resolution', () => {
    it.each([
      ['claude-opus-4-7', 'high'],
      ['claude-opus-4-6', 'high'],
      ['claude-opus-4-5', 'high'],
      ['opus', 'high'],
      ['claude-sonnet-4-6', 'high'],
      ['claude-sonnet-4-5', 'high'],
      ['sonnet', 'high'],
    ])('Opus/Sonnet model %s resolves auto → %s', (model, expected) => {
      expect(resolveEffortForModel(model, 'auto')).toBe(expected);
    });

    it.each([
      ['claude-haiku-4-5', 'medium'],
      ['haiku', 'medium'],
      ['claude-haiku-4', 'medium'],     // future variant
      ['CLAUDE-HAIKU-5-0', 'medium'],   // case-insensitive guard
    ])('Haiku-family %s resolves auto → %s', (model, expected) => {
      expect(resolveEffortForModel(model, 'auto')).toBe(expected);
    });

    it('falls through to high for unknown future model IDs', () => {
      // Defensive: a model class we don't know about yet shouldn't get
      // medium (the lightweight default). 'high' is the safe baseline.
      expect(resolveEffortForModel('claude-mythos-preview', 'auto')).toBe('high');
      expect(resolveEffortForModel('claude-something-new-1', 'auto')).toBe('high');
    });
  });

  describe('missing / invalid configured value', () => {
    it('treats undefined as auto', () => {
      expect(resolveEffortForModel('claude-opus-4-7', undefined)).toBe('high');
      expect(resolveEffortForModel('claude-haiku-4-5', undefined)).toBe('medium');
    });

    it('treats unknown string as auto (no surprise passthrough)', () => {
      // Defensive: a stale config with a typo or removed value should
      // fall back to safe defaults, not be sent verbatim to the SDK.
      expect(resolveEffortForModel('claude-opus-4-7', 'frenzied')).toBe('high');
      expect(resolveEffortForModel('claude-opus-4-7', '')).toBe('high');
    });
  });

  describe('conservative-by-default invariants', () => {
    it('auto never returns xhigh or max for any current model', () => {
      const models = [
        'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
        'claude-sonnet-4-6', 'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'opus', 'sonnet', 'haiku',
      ];
      for (const model of models) {
        const resolved = resolveEffortForModel(model, 'auto');
        expect(resolved).not.toBe('xhigh');
        expect(resolved).not.toBe('max');
      }
    });
  });
});
