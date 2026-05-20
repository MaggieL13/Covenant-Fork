import { describe, it, expect } from 'vitest';
import { resolveEffortForModel, getEffortOptionsForProvider, coerceEffortForProvider, type ThinkingEffort } from './thinking-effort.js';

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

  describe('Codex-specific effort values (none / minimal)', () => {
    // Added Rev 2.2 — the widened ThinkingEffort union includes `'none'`
    // and `'minimal'` (Codex-only). The resolver passes them through
    // verbatim; UI gating is the safeguard against picking them on
    // Claude.

    it('passes `none` through verbatim', () => {
      expect(resolveEffortForModel('gpt-5.5', 'none')).toBe('none');
    });

    it('passes `minimal` through verbatim', () => {
      expect(resolveEffortForModel('gpt-5.5', 'minimal')).toBe('minimal');
    });

    it('still passes `none`/`minimal` through on Claude models — the dropdown is the gate, not the resolver', () => {
      // Documented invariant: if a Claude config somehow contains
      // `'minimal'` (manual YAML edit), the resolver does NOT silently
      // remap it. Sending to the Claude SDK will fail at the wire;
      // operator sees a clear error rather than a silent downgrade.
      expect(resolveEffortForModel('claude-opus-4-7', 'minimal')).toBe('minimal');
      expect(resolveEffortForModel('claude-haiku-4-5', 'none')).toBe('none');
    });
  });
});

describe('getEffortOptionsForProvider', () => {
  it('Claude returns Claude vocabulary (includes max, excludes none/minimal)', () => {
    const options = getEffortOptionsForProvider('claude');
    const values = options.map((o) => o.value);
    expect(values).toContain('max');
    expect(values).toContain('xhigh');
    expect(values).toContain('high');
    expect(values).toContain('medium');
    expect(values).toContain('low');
    expect(values).toContain('auto');
    expect(values).not.toContain('none');
    expect(values).not.toContain('minimal');
  });

  it('Codex returns Codex vocabulary (includes none/minimal, excludes max)', () => {
    const options = getEffortOptionsForProvider('openai-codex');
    const values = options.map((o) => o.value);
    expect(values).toContain('none');
    expect(values).toContain('minimal');
    expect(values).toContain('low');
    expect(values).toContain('medium');
    expect(values).toContain('high');
    expect(values).toContain('xhigh');
    expect(values).toContain('auto');
    expect(values).not.toContain('max');
  });

  it('OpenRouter and Ollama return the generic fallback', () => {
    const orOptions = getEffortOptionsForProvider('openrouter');
    const ollamaOptions = getEffortOptionsForProvider('ollama');
    expect(orOptions).toEqual(ollamaOptions);
    const values = orOptions.map((o) => o.value);
    expect(values).toEqual(['auto', 'high', 'medium', 'low']);
  });

  it('every option has a non-empty human-facing label', () => {
    const providers = ['claude', 'openai-codex', 'openrouter', 'ollama'] as const;
    for (const p of providers) {
      for (const opt of getEffortOptionsForProvider(p)) {
        expect(opt.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('coerceEffortForProvider — provider-mismatch safety belt', () => {
  // Closes two real bugs flagged in Codex review:
  //   1. Switching chat model from Claude → Codex left `max` lingering;
  //      a subsequent save sent `max` to Codex which silently coerced.
  //   2. Autonomous "Match Chat" inherited chat's effort verbatim; a
  //      Codex chat with `none` could feed into a Claude autonomous turn
  //      that would error at the SDK wire.

  it('returns auto for null/undefined/empty input', () => {
    expect(coerceEffortForProvider('claude', undefined)).toBe('auto');
    expect(coerceEffortForProvider('claude', null)).toBe('auto');
    expect(coerceEffortForProvider('claude', '')).toBe('auto');
  });

  it('returns auto when the input is auto', () => {
    expect(coerceEffortForProvider('claude', 'auto')).toBe('auto');
    expect(coerceEffortForProvider('openai-codex', 'auto')).toBe('auto');
  });

  it('passes valid Claude values through on Claude', () => {
    for (const v of ['low', 'medium', 'high', 'xhigh', 'max'] as ThinkingEffort[]) {
      expect(coerceEffortForProvider('claude', v)).toBe(v);
    }
  });

  it('passes valid Codex values through on Codex', () => {
    for (const v of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as ThinkingEffort[]) {
      expect(coerceEffortForProvider('openai-codex', v)).toBe(v);
    }
  });

  it('downgrades Claude-only `max` to auto when target is Codex (Bug 1)', () => {
    expect(coerceEffortForProvider('openai-codex', 'max')).toBe('auto');
  });

  it('downgrades Codex-only `none` / `minimal` to auto when target is Claude (Bug 2)', () => {
    expect(coerceEffortForProvider('claude', 'none')).toBe('auto');
    expect(coerceEffortForProvider('claude', 'minimal')).toBe('auto');
  });

  it('downgrades anything outside the generic-fallback short list when target is OR/Ollama', () => {
    // OR/Ollama list is auto/high/medium/low — xhigh/max/none/minimal all fall to auto.
    for (const v of ['xhigh', 'max', 'none', 'minimal'] as ThinkingEffort[]) {
      expect(coerceEffortForProvider('openrouter', v)).toBe('auto');
      expect(coerceEffortForProvider('ollama', v)).toBe('auto');
    }
  });

  it('treats unrecognized strings as invalid → auto (defensive)', () => {
    expect(coerceEffortForProvider('claude', 'frenzied')).toBe('auto');
    expect(coerceEffortForProvider('openai-codex', 'turbo')).toBe('auto');
  });
});
