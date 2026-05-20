import { describe, it, expect } from 'vitest';
import {
  MODELS,
  MODEL_MIN_CC,
  normalizeModelRef,
  parseModelRef,
  findModelByRef,
  getModelsForTier,
  providerToRuntime,
  unwrapModelRefForClaudeSdk,
  type ProviderId,
  type RuntimeId,
  type TierHint,
} from './model-manifest.js';

describe('model manifest — shape', () => {
  it('every entry has a populated ref matching <provider>/<id>', () => {
    for (const m of MODELS) {
      expect(m.ref).toBe(`${m.provider}/${m.id}`);
    }
  });

  it('every entry has runtime consistent with provider', () => {
    for (const m of MODELS) {
      expect(m.runtime).toBe(providerToRuntime(m.provider));
    }
  });

  it('every entry declares at least one tier hint', () => {
    for (const m of MODELS) {
      expect(m.tierHints.length).toBeGreaterThan(0);
    }
  });

  it('every Claude entry has full Claude-SDK capabilities', () => {
    for (const m of MODELS.filter((e) => e.provider === 'claude')) {
      expect(m.capabilities).toEqual({
        tools: true,
        vision: true,
        reasoning: true,
        mcp: true,
        sessionResume: true,
        fileCheckpointing: true,
      });
      expect(m.auth.type).toBe('claude-sdk');
    }
  });

  it('MODEL_MIN_CC keys are raw native ids, not canonical refs', () => {
    // Sticky-note safety: runtime-health looks up by raw model id, not
    // by canonical ref. If this map ever flips to canonical, runtime-
    // health silently stops finding minimums.
    for (const key of MODEL_MIN_CC.keys()) {
      expect(key).not.toContain('/');
    }
  });

  it('MODEL_MIN_CC values are non-empty version strings', () => {
    for (const v of MODEL_MIN_CC.values()) {
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe('providerToRuntime', () => {
  it.each<[ProviderId, RuntimeId]>([
    ['claude', 'claude-sdk'],
    ['openai-codex', 'codex'],
    ['openrouter', 'openai-compat'],
    ['ollama', 'ollama-native'],
  ])('maps %s → %s', (provider, runtime) => {
    expect(providerToRuntime(provider)).toBe(runtime);
  });
});

describe('parseModelRef — canonical form', () => {
  it('parses claude/claude-sonnet-4-6', () => {
    expect(parseModelRef('claude/claude-sonnet-4-6')).toEqual({
      canonical: 'claude/claude-sonnet-4-6',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      runtime: 'claude-sdk',
    });
  });

  it('parses family alias claude/sonnet', () => {
    expect(parseModelRef('claude/sonnet')).toEqual({
      canonical: 'claude/sonnet',
      provider: 'claude',
      model: 'sonnet',
      runtime: 'claude-sdk',
    });
  });

  it('parses openai-codex/gpt-5-1 even though no manifest entry exists yet', () => {
    expect(parseModelRef('openai-codex/gpt-5-1')).toEqual({
      canonical: 'openai-codex/gpt-5-1',
      provider: 'openai-codex',
      model: 'gpt-5-1',
      runtime: 'codex',
    });
  });

  it('splits on first slash for nested model ids like openrouter/anthropic/claude-sonnet-4-6', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4-6')).toEqual({
      canonical: 'openrouter/anthropic/claude-sonnet-4-6',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-6',
      runtime: 'openai-compat',
    });
  });

  it('parses ollama/qwen3:latest (colon in model id is fine)', () => {
    expect(parseModelRef('ollama/qwen3:latest')).toEqual({
      canonical: 'ollama/qwen3:latest',
      provider: 'ollama',
      model: 'qwen3:latest',
      runtime: 'ollama-native',
    });
  });

  it('returns null for input without a slash (legacy form path)', () => {
    expect(parseModelRef('claude-sonnet-4-6')).toBeNull();
    expect(parseModelRef('sonnet')).toBeNull();
  });

  it('returns null for unknown provider prefix', () => {
    expect(parseModelRef('mistral/large')).toBeNull();
    expect(parseModelRef('foo/bar')).toBeNull();
  });

  it('returns null for empty model portion', () => {
    expect(parseModelRef('claude/')).toBeNull();
  });
});

describe('normalizeModelRef — accepts both legacy and canonical', () => {
  it('round-trips legacy claude-sonnet-4-6 → claude/claude-sonnet-4-6 → back', () => {
    const normalized = normalizeModelRef('claude-sonnet-4-6');
    expect(normalized.canonical).toBe('claude/claude-sonnet-4-6');
    expect(normalized.model).toBe('claude-sonnet-4-6');

    // The crucial property for Codex's sticky note: round-tripping
    // through the canonical form gets back the same raw native id.
    const reparsed = normalizeModelRef(normalized.canonical);
    expect(reparsed.model).toBe('claude-sonnet-4-6');
  });

  it.each([
    ['claude-sonnet-4-6', 'claude/claude-sonnet-4-6'],
    ['claude-opus-4-7', 'claude/claude-opus-4-7'],
    ['claude-haiku-4-5', 'claude/claude-haiku-4-5'],
    ['sonnet', 'claude/sonnet'],
    ['opus', 'claude/opus'],
    ['haiku', 'claude/haiku'],
  ])('normalizes legacy %s → canonical %s', (legacy, canonical) => {
    const ref = normalizeModelRef(legacy);
    expect(ref.canonical).toBe(canonical);
    expect(ref.provider).toBe('claude');
    expect(ref.runtime).toBe('claude-sdk');
    expect(ref.model).toBe(legacy);
  });

  it('accepts canonical refs unchanged', () => {
    const ref = normalizeModelRef('claude/claude-sonnet-4-6');
    expect(ref.canonical).toBe('claude/claude-sonnet-4-6');
    expect(ref.model).toBe('claude-sonnet-4-6');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeModelRef('  sonnet  ').canonical).toBe('claude/sonnet');
    expect(normalizeModelRef('\tclaude/sonnet\n').canonical).toBe('claude/sonnet');
  });

  it('handles a legacy id that contains no slash but is unknown (typo path)', () => {
    // Liberal back-compat: a bare unknown id is treated as a (probably
    // typoed) Claude id. The SDK boundary catches invalid model names,
    // not the normalizer. Pre-PR-A behavior preserved.
    const ref = normalizeModelRef('claude-opus-99');
    expect(ref.provider).toBe('claude');
    expect(ref.model).toBe('claude-opus-99');
    expect(ref.canonical).toBe('claude/claude-opus-99');
  });

  it('looks up bare ids in the manifest BEFORE falling back to Claude (PR E0 smoke catch)', () => {
    // PR E0 live smoke caught: selecting "GPT-5 (Codex preview)" in
    // the UI sent the bare id `gpt-5` to the resolver. The legacy
    // fallback wrapped it as `claude/gpt-5` (provider=claude,
    // runtime=claude-sdk), `unwrapModelRefForClaudeSdk` happily
    // unwrapped it (runtime was claude-sdk after all), and the Claude
    // SDK got called with model `gpt-5` — bypassing the friendly-error
    // guard that should have surfaced "requires codex runtime."
    //
    // Fix: bare-id lookup checks the manifest first. If the id matches
    // a known entry, use that entry's provider/runtime (so `gpt-5`
    // correctly resolves to openai-codex). Falls back to Claude only
    // when no manifest entry matches (preserves the typo path above).

    // Codex bare id should resolve to the codex provider, NOT Claude
    const gpt55 = normalizeModelRef('gpt-5.5');
    expect(gpt55.provider).toBe('openai-codex');
    expect(gpt55.runtime).toBe('codex');
    expect(gpt55.canonical).toBe('openai-codex/gpt-5.5');

    const gpt54Mini = normalizeModelRef('gpt-5.4-mini');
    expect(gpt54Mini.provider).toBe('openai-codex');
    expect(gpt54Mini.runtime).toBe('codex');

    const gpt52 = normalizeModelRef('gpt-5.2');
    expect(gpt52.provider).toBe('openai-codex');
    expect(gpt52.runtime).toBe('codex');

    // Claude bare ids still resolve to Claude (back-compat unaffected)
    const sonnet = normalizeModelRef('claude-sonnet-4-6');
    expect(sonnet.provider).toBe('claude');
    expect(sonnet.runtime).toBe('claude-sdk');

    // Family alias still resolves via manifest match
    const sonnetAlias = normalizeModelRef('sonnet');
    expect(sonnetAlias.provider).toBe('claude');
    expect(sonnetAlias.runtime).toBe('claude-sdk');

    // Unknown bare id falls back to Claude (typo path preserved)
    const typo = normalizeModelRef('claude-opus-99');
    expect(typo.provider).toBe('claude');
    expect(typo.runtime).toBe('claude-sdk');
  });

  it('downstream: selecting a Codex bare id from the UI now correctly triggers unwrapModelRefForClaudeSdk to throw', () => {
    // The end-to-end regression: bare Codex id → normalizeModelRef →
    // unwrap should throw the friendly "codex runtime not wired up yet"
    // error, surfacing as the inline chat error users see. Before the
    // fix this silently went to the Claude SDK with `gpt-5.5` as the
    // model name.
    const gpt5 = normalizeModelRef('gpt-5.5');
    expect(() => unwrapModelRefForClaudeSdk(gpt5, 'interactive')).toThrow(
      /requires the codex runtime/,
    );
    expect(() => unwrapModelRefForClaudeSdk(gpt5, 'interactive')).toThrow(
      /interactive tier/,
    );
  });

  it('maps legacy Codex bare ids to current equivalents (E0 preview + brief-window E2 ids)', () => {
    // PR E0 shipped placeholder ids (gpt-5, gpt-5-mini, o3). PR E2's
    // initial commit moved to gpt-5.1 / gpt-5.1-codex-mini. The post-
    // review fix bumped again to match the current Codex UI
    // (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2). Anyone whose
    // config still names ANY of those older ids would otherwise fall
    // through to the Claude fallback. Verify the alias map catches
    // each one and re-routes to a current Codex equivalent.

    const oldGpt5 = normalizeModelRef('gpt-5');
    expect(oldGpt5.provider).toBe('openai-codex');
    expect(oldGpt5.canonical).toBe('openai-codex/gpt-5.5');

    const oldGpt5Mini = normalizeModelRef('gpt-5-mini');
    expect(oldGpt5Mini.provider).toBe('openai-codex');
    expect(oldGpt5Mini.canonical).toBe('openai-codex/gpt-5.4-mini');

    const oldO3 = normalizeModelRef('o3');
    expect(oldO3.provider).toBe('openai-codex');
    expect(oldO3.canonical).toBe('openai-codex/gpt-5.5');

    // Brief-window E2 ids (initial commit, before the post-review bump).
    const oldGpt51 = normalizeModelRef('gpt-5.1');
    expect(oldGpt51.canonical).toBe('openai-codex/gpt-5.5');

    const oldGpt51Mini = normalizeModelRef('gpt-5.1-codex-mini');
    expect(oldGpt51Mini.canonical).toBe('openai-codex/gpt-5.4-mini');
  });

  it('throws a friendly error for empty input', () => {
    expect(() => normalizeModelRef('')).toThrow(/empty model reference/);
    expect(() => normalizeModelRef('   ')).toThrow(/empty model reference/);
  });

  it('throws a friendly error for unknown provider prefix in canonical form', () => {
    expect(() => normalizeModelRef('mistral/large')).toThrow(
      /unknown provider "mistral"/,
    );
    expect(() => normalizeModelRef('mistral/large')).toThrow(
      /Known providers:/,
    );
  });
});

describe('findModelByRef', () => {
  it('finds claude-sonnet-4-6 by legacy id', () => {
    const entry = findModelByRef('claude-sonnet-4-6');
    expect(entry?.id).toBe('claude-sonnet-4-6');
    expect(entry?.label).toBe('Sonnet 4.6');
  });

  it('finds claude-sonnet-4-6 by canonical ref', () => {
    const entry = findModelByRef('claude/claude-sonnet-4-6');
    expect(entry?.id).toBe('claude-sonnet-4-6');
  });

  it('finds family alias sonnet by both forms', () => {
    expect(findModelByRef('sonnet')?.id).toBe('sonnet');
    expect(findModelByRef('claude/sonnet')?.id).toBe('sonnet');
  });

  it('finds a Codex model by both bare id and canonical ref (regression — P1 from PR #22 review)', () => {
    // Pins the exact lookup shape behind the per-provider rendering arc's
    // P1 bugs: the frontend vision gate + effort coercion path stores
    // `agent.model` as either form, and a bare-id-only lookup silently
    // fell back to defaults for canonical refs. findModelByRef must
    // resolve both forms to the same Codex entry with the right provider
    // and capabilities — otherwise vision gating becomes inert and
    // Codex configs see Claude effort options.
    const byBare = findModelByRef('gpt-5.5');
    const byCanonical = findModelByRef('openai-codex/gpt-5.5');
    expect(byBare?.id).toBe('gpt-5.5');
    expect(byBare?.provider).toBe('openai-codex');
    expect(byBare?.ref).toBe('openai-codex/gpt-5.5');
    expect(byCanonical).toEqual(byBare);
    // T18 manifest fix — Codex vision is false until E3a wires image bytes.
    expect(byCanonical?.capabilities.vision).toBe(false);
  });

  it('returns undefined for unknown model ids', () => {
    expect(findModelByRef('claude-opus-99')).toBeUndefined();
    expect(findModelByRef('claude/claude-opus-99')).toBeUndefined();
  });

  it('returns undefined gracefully for invalid input', () => {
    expect(findModelByRef('')).toBeUndefined();
    expect(findModelByRef('mistral/large')).toBeUndefined();
  });
});

describe('getModelsForTier', () => {
  it.each<TierHint>(['interactive', 'autonomous', 'pulse', 'memory'])(
    'returns at least one Claude model for tier %s',
    (tier) => {
      const tierModels = getModelsForTier(tier);
      expect(tierModels.length).toBeGreaterThan(0);
      // Every returned model genuinely declares the tier
      for (const m of tierModels) {
        expect(m.tierHints).toContain(tier);
      }
    },
  );

  it('pulse tier contains only haiku-family models (cheap + reliable invariant)', () => {
    // Pulse must be cheap and PULSE_OK-reliable; Opus/Sonnet do not
    // belong here. If a future change adds a non-haiku to pulse, this
    // test forces an explicit decision.
    const pulseModels = getModelsForTier('pulse');
    for (const m of pulseModels) {
      expect(m.id.toLowerCase()).toMatch(/haiku/);
    }
  });

  it('memory tier excludes opus (overkill for digest summarization)', () => {
    const memoryModels = getModelsForTier('memory');
    for (const m of memoryModels) {
      expect(m.id.toLowerCase()).not.toMatch(/opus/);
    }
  });
});

describe('Codex (openai-codex) entries (PR E2: runtime wired)', () => {
  // PR E0 added these as preview-only (selecting them threw the friendly
  // "codex runtime not wired up" error). PR E2 wires CodexRuntime, so
  // the entries are now functional (subject to OAuth login). These tests
  // pin the shape so a future regression cannot accidentally
  // (a) drop the entries, (b) put Codex in the pulse tier, or (c) flip
  // the auth/runtime/provider fields out of alignment with pi-ai's
  // openai-codex registry.

  it('exposes the current Codex tier (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2)', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    expect(codexModels.length).toBeGreaterThanOrEqual(5);
    const ids = codexModels.map((m) => m.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.4');
    expect(ids).toContain('gpt-5.4-mini');
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.2');
  });

  it('does NOT expose stale Codex ids (5.1) — they are migration-only aliases', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    const ids = codexModels.map((m) => m.id);
    // gpt-5.1 + gpt-5.1-codex-mini were the initial PR E2 picks; the
    // post-review update bumped to 5.5/5.4/... to match the current
    // Codex UI. Stale ids stay reachable via LEGACY_BARE_ID_ALIASES
    // but must not clutter the visible picker.
    expect(ids).not.toContain('gpt-5.1');
    expect(ids).not.toContain('gpt-5.1-codex-mini');
  });

  it('every Codex entry uses provider=openai-codex + runtime=codex + auth=codex-oauth', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    for (const m of codexModels) {
      expect(m.provider).toBe('openai-codex');
      expect(m.runtime).toBe('codex');
      expect(m.auth.type).toBe('codex-oauth');
      // Canonical ref format
      expect(m.ref).toBe(`openai-codex/${m.id}`);
    }
  });

  it('Codex entries are NOT in the pulse tier (pulse needs PULSE_OK reliability; Haiku stays default)', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    for (const m of codexModels) {
      expect(m.tierHints).not.toContain('pulse');
    }
  });

  it('Codex entries declare reasoning: true (pi-ai openai-codex models are reasoning-capable)', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    for (const m of codexModels) {
      expect(m.capabilities.reasoning).toBe(true);
    }
  });

  it('Codex entries declare mcp: false + tools: false + fileCheckpointing: false (Claude-SDK-only features)', () => {
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    for (const m of codexModels) {
      expect(m.capabilities.mcp).toBe(false);
      expect(m.capabilities.tools).toBe(false);
      expect(m.capabilities.fileCheckpointing).toBe(false);
    }
  });

  it('Codex labels look like GPT-x.y model names (concise, no provider suffix clutter)', () => {
    // Post-review: labels match the actual model name as Codex/ChatGPT
    // shows them — "GPT-5.5", not "GPT-5.5 (Codex)". The dropdown
    // groups them under the Codex section, so the label doesn't need
    // to repeat the provider. Pin the GPT-x.y shape so a future
    // regression can't slip in lowercase / wrong-version labels.
    const codexModels = MODELS.filter((m) => m.provider === 'openai-codex');
    for (const m of codexModels) {
      expect(m.label).toMatch(/^GPT-\d+(\.\d+)?/i);
    }
  });
});

describe('unwrapModelRefForClaudeSdk — the SDK-boundary sticky note', () => {
  // The crucial PR-A guarantee: canonical refs (`claude/claude-sonnet-4-6`)
  // never reach the Claude Agent SDK; they're unwrapped to the raw native
  // id (`claude-sonnet-4-6`) at the boundary. Non-Claude runtimes throw
  // friendly errors instead of being silently passed through.

  it('returns raw native id for a Claude legacy input', () => {
    const ref = normalizeModelRef('claude-sonnet-4-6');
    expect(unwrapModelRefForClaudeSdk(ref)).toBe('claude-sonnet-4-6');
  });

  it('returns raw native id for a Claude canonical input', () => {
    const ref = normalizeModelRef('claude/claude-sonnet-4-6');
    expect(unwrapModelRefForClaudeSdk(ref)).toBe('claude-sonnet-4-6');
  });

  it('returns raw family-alias id (sonnet/opus/haiku) for canonical input', () => {
    expect(unwrapModelRefForClaudeSdk(normalizeModelRef('claude/sonnet'))).toBe('sonnet');
    expect(unwrapModelRefForClaudeSdk(normalizeModelRef('claude/opus'))).toBe('opus');
    expect(unwrapModelRefForClaudeSdk(normalizeModelRef('claude/haiku'))).toBe('haiku');
  });

  it('round-trips: legacy → normalize → unwrap returns same string', () => {
    for (const legacy of ['claude-sonnet-4-6', 'claude-opus-4-7', 'sonnet', 'haiku']) {
      const ref = normalizeModelRef(legacy);
      expect(unwrapModelRefForClaudeSdk(ref)).toBe(legacy);
    }
  });

  it('throws a friendly error for a Codex ref (runtime not wired up)', () => {
    const ref = normalizeModelRef('openai-codex/gpt-5-1');
    expect(() => unwrapModelRefForClaudeSdk(ref)).toThrow(
      /requires the codex runtime/,
    );
    expect(() => unwrapModelRefForClaudeSdk(ref)).toThrow(
      /only the claude-sdk runtime is wired up/,
    );
  });

  it('throws a friendly error for an OpenRouter ref', () => {
    const ref = normalizeModelRef('openrouter/openai/gpt-5-1');
    expect(() => unwrapModelRefForClaudeSdk(ref)).toThrow(/openai-compat runtime/);
  });

  it('throws a friendly error for an Ollama ref', () => {
    const ref = normalizeModelRef('ollama/qwen3:latest');
    expect(() => unwrapModelRefForClaudeSdk(ref)).toThrow(/ollama-native runtime/);
  });

  it('includes the tier label in the error when provided', () => {
    const ref = normalizeModelRef('openai-codex/gpt-5-1');
    expect(() => unwrapModelRefForClaudeSdk(ref, 'pulse')).toThrow(/pulse tier/);
  });

  it('omits the tier wording when no tier label is provided', () => {
    const ref = normalizeModelRef('openai-codex/gpt-5-1');
    expect(() => unwrapModelRefForClaudeSdk(ref)).not.toThrow(/for the .* tier/);
  });
});
