/**
 * Model manifest — single source of truth for model identities, labels,
 * runtime requirements, and (as of PR A of the multi-provider arc)
 * provider/runtime/capability metadata.
 *
 * Both the backend (runtime-health service, model resolver) and frontend
 * (model selector, runtime-health card) read from this file so adding a
 * new model is a one-line edit instead of a multi-file edit kept manually
 * in sync.
 *
 * Two categories:
 *   - Pinned versions (e.g. `claude-opus-4-7`) — stable, won't change
 *     behavior unless the user switches entries.
 *   - Family aliases (`opus` / `sonnet` / `haiku`) — auto-track to whatever
 *     Anthropic considers latest in that family. They migrate ~a week
 *     after a new generation ships, so any user on an alias inherits the
 *     new model's behavior automatically. Useful for "always latest with
 *     surprise tolerance"; for stability, prefer pinned IDs.
 *
 * `minClaudeCodeVersion` (optional) declares the minimum bundled Claude
 * Code version the model needs. The Settings → Claude Runtime Health card
 * checks the bundled SDK runtime against this and warns when behind. Only
 * meaningful for `runtime: 'claude-sdk'`; non-Claude runtimes ignore it.
 *
 * Why this lives in `shared/` and not in either package: the values are
 * data, not behavior, and they have to match exactly across the wire. A
 * single source kills the drift class entirely.
 *
 * ## Multi-provider arc (PR A — scaffolding only)
 *
 * `ModelEntry.id` stays as the raw provider-native id (e.g. `claude-sonnet-4-6`)
 * for back-compat with all existing consumers that do
 * `MODELS.find(m => m.id === 'claude-sonnet-4-6')`. New canonical
 * provider-qualified refs (e.g. `claude/claude-sonnet-4-6`) are exposed via
 * the derived `.ref` field, and the `normalizeModelRef` / `parseModelRef`
 * helpers let new code work in canonical-ref space without breaking SDK
 * call sites that need the raw native id.
 *
 * Until non-Claude runtimes ship (later PRs), every entry here has
 * `provider: 'claude'` and `runtime: 'claude-sdk'`.
 */

// ---------------------------------------------------------------------------
// Provider / runtime / tier vocabulary
// ---------------------------------------------------------------------------

/** Provider namespace in canonical refs. Each provider maps to one runtime. */
export type ProviderId =
  | 'claude'         // Anthropic models via @anthropic-ai/claude-agent-sdk
  | 'openai-codex'   // OpenAI ChatGPT via Codex OAuth (later PR)
  | 'openrouter'     // OpenRouter aggregator (later PR)
  | 'ollama';        // Local Ollama server (later PR)

/** Runtime implementation that handles turns for a provider. */
export type RuntimeId =
  | 'claude-sdk'        // wraps @anthropic-ai/claude-agent-sdk
  | 'codex'             // wraps @earendil-works/pi-ai/openai-codex-responses
  | 'openai-compat'     // generic OpenAI-compatible HTTP (OpenRouter, custom endpoints)
  | 'ollama-native';    // Ollama /api/chat NDJSON

/** Map a provider to the runtime that handles it. */
export function providerToRuntime(provider: ProviderId): RuntimeId {
  switch (provider) {
    case 'claude':       return 'claude-sdk';
    case 'openai-codex': return 'codex';
    case 'openrouter':   return 'openai-compat';
    case 'ollama':       return 'ollama-native';
  }
}

/** Which model-resolution tier a model is suitable for. UI uses this to
 *  decide which dropdown a model appears in. */
export type TierHint = 'interactive' | 'autonomous' | 'pulse' | 'memory';

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  /** Can consume MCP server tool definitions natively. Claude-SDK-only today. */
  mcp: boolean;
  /** Provider/runtime supports resuming a prior session by id. */
  sessionResume: boolean;
  /** Runtime can checkpoint and rewind filesystem state. Claude-SDK-only today. */
  fileCheckpointing: boolean;
}

/** Authentication shape required to use a model. */
export interface ModelAuth {
  type: 'claude-sdk' | 'codex-oauth' | 'api-key' | 'none';
  envVars?: string[];
}

// ---------------------------------------------------------------------------
// Model entry
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Provider-native model id. For Claude this is the value passed directly
   *  to the SDK (e.g. `claude-sonnet-4-6`, `opus`, `sonnet`, `haiku`). For
   *  other providers it's the raw provider-side id (e.g. `gpt-5-1`,
   *  `qwen3:latest`). **Stays bare** so existing consumers like
   *  `MODELS.find(m => m.id === 'claude-sonnet-4-6')` keep working. */
  id: string;
  /** Human-facing label for the dropdown. */
  label: string;
  /** Provider namespace. */
  provider: ProviderId;
  /** Runtime implementation. Derived from `provider` in the manifest, but
   *  stored explicitly so non-Claude runtimes can later override
   *  (e.g. a Claude model routed through OpenRouter for failover). */
  runtime: RuntimeId;
  /** Canonical provider-qualified ref (`<provider>/<id>`). Computed in the
   *  manifest builder; new code should prefer this over `id` for cross-
   *  provider lookups. */
  ref: string;
  /** Which dropdowns this model should appear in. */
  tierHints: TierHint[];
  /** What the model/runtime can do. */
  capabilities: ModelCapabilities;
  /** Authentication required to use it. */
  auth: ModelAuth;
  /** Minimum bundled Claude Code version this model requires. Only
   *  meaningful when `runtime: 'claude-sdk'`. */
  minClaudeCodeVersion?: string;
}

// ---------------------------------------------------------------------------
// Default capability sets (avoid repeating in every entry)
// ---------------------------------------------------------------------------

const CLAUDE_SDK_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: true,
  sessionResume: true,
  fileCheckpointing: true,
};

const CLAUDE_SDK_AUTH: ModelAuth = { type: 'claude-sdk' };

/** Build a Claude-SDK entry with provider/runtime/ref/capabilities filled in. */
function claudeEntry(
  id: string,
  label: string,
  tierHints: TierHint[],
  minClaudeCodeVersion?: string,
): ModelEntry {
  return {
    id,
    label,
    provider: 'claude',
    runtime: 'claude-sdk',
    ref: `claude/${id}`,
    tierHints,
    capabilities: CLAUDE_SDK_CAPABILITIES,
    auth: CLAUDE_SDK_AUTH,
    ...(minClaudeCodeVersion ? { minClaudeCodeVersion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT OAuth) preview entries — PR E0
// ---------------------------------------------------------------------------
//
// These are **preview/scaffold entries** that surface Codex models in the
// Settings + chat-header dropdowns so users can see the multi-provider
// architecture has landed. **Selecting one today produces the existing
// friendly error** from `resolveConfiguredRuntime` ("requires the codex
// runtime, which is not wired up yet") — there is no CodexRuntime
// implementation, no OAuth flow, no actual ChatGPT request. PR E proper
// (next) lands the runtime + auth + event-translation work that makes
// these entries usable.
//
// Capability profile reflects what Codex via the responses API actually
// supports / will support once wired:
//  - tools: false  — MCP-to-OpenAI tool-schema bridge is a separate PR
//  - vision: true  — gpt-5 supports image inputs natively
//  - reasoning: true for o-series, false for chat/instruct models
//  - mcp: false  — Codex has no MCP equivalent
//  - sessionResume: true — Codex maintains a conversation_id per
//    response chain (will be persisted in `thread_provider_sessions`)
//  - fileCheckpointing: false — Claude-SDK-specific
//
// Tier hints: interactive / autonomous / memory.
// NOT pulse — pulse needs literal `PULSE_OK` reliability across cycles;
// Codex is new + has different output conventions, Haiku stays the pulse
// default. Users can override per Settings if they really want.
//
// Auth: `codex-oauth` — runtime-health card surfaces "Logged in" /
// "Login required" once PR E adds the auth state machine.
//
// Exact model list will be refined when PR E runtime model-discovery
// lands; these entries are a curated starting set.

const CODEX_AUTH: ModelAuth = { type: 'codex-oauth' };

const CODEX_CHAT_CAPABILITIES: ModelCapabilities = {
  tools: false,
  // Forward-looking GPT-5.x models DO support vision at the API level,
  // but CodexRuntime today does not pass image bytes through pi-ai — it
  // only sends the message text plus attachment filenames. Until E3a
  // lands (NormalizedMessage carries image content + CodexRuntime
  // converts it into pi-ai's ImageContent), the honest current state is
  // `vision: false` so the UI capability gate actually fires:
  //   - file picker drops image/*
  //   - paste / drag-drop / programmatic uploadFile reject images
  //   - send-time guard catches the model-swap race
  // Flip this back to true when E3a wires the runtime end-to-end and
  // a smoke confirms a real image round-trip. See lab-findings #4 →
  // per-provider-rendering-spec D4 → T18 review (2026-05-19).
  vision: false,
  reasoning: false,
  mcp: false,
  sessionResume: true,
  fileCheckpointing: false,
};

const CODEX_REASONING_CAPABILITIES: ModelCapabilities = {
  ...CODEX_CHAT_CAPABILITIES,
  reasoning: true,
};

/** Build a Codex (ChatGPT OAuth) entry. */
function codexEntry(
  id: string,
  label: string,
  tierHints: TierHint[],
  capabilities: ModelCapabilities = CODEX_CHAT_CAPABILITIES,
): ModelEntry {
  return {
    id,
    label,
    provider: 'openai-codex',
    runtime: 'codex',
    ref: `openai-codex/${id}`,
    tierHints,
    capabilities,
    auth: CODEX_AUTH,
  };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Tier-hint conventions:
 *  - Opus: interactive + autonomous (heavy reasoning; not memory or pulse)
 *  - Sonnet: interactive + autonomous + memory (balanced; structured output OK)
 *  - Haiku: every tier (cheap + reliable; the pulse + memory default)
 */
export const MODELS: readonly ModelEntry[] = [
  // Pinned versions
  claudeEntry('claude-opus-4-7', 'Opus 4.7', ['interactive', 'autonomous'], '2.1.111'),
  claudeEntry('claude-opus-4-6', 'Opus 4.6', ['interactive', 'autonomous']),
  claudeEntry('claude-opus-4-5', 'Opus 4.5', ['interactive', 'autonomous']),
  claudeEntry('claude-sonnet-4-6', 'Sonnet 4.6', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-sonnet-4-5', 'Sonnet 4.5', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-haiku-4-5', 'Haiku 4.5', ['interactive', 'autonomous', 'pulse', 'memory']),
  // Family aliases — auto-track the latest of each family server-side.
  // `opus` currently resolves to 4.7, so it inherits the same min-CC.
  claudeEntry('opus', 'Opus (latest, auto-updates)', ['interactive', 'autonomous'], '2.1.111'),
  claudeEntry('sonnet', 'Sonnet (latest, auto-updates)', ['interactive', 'autonomous', 'memory']),
  claudeEntry('haiku', 'Haiku (latest, auto-updates)', ['interactive', 'autonomous', 'pulse', 'memory']),

  // Codex (ChatGPT OAuth) — PREVIEW entries. Selecting any of these
  // today produces a friendly "codex runtime not wired up yet" error
  // from `resolveConfiguredRuntime`. PR E lands the runtime.
  // PR E2 (post-review): ids match the current Codex UI / pi-ai's
  // live registry — not a stale subset. Codex itself surfaces 5.5 /
  // 5.4 / 5.3-codex / 5.2 as its current chat tier, so showing the
  // older 5.1 entries as the primary picker would be confusing.
  //
  // Older ids (gpt-5.1, gpt-5.1-codex-mini) stay as hidden migration
  // aliases in LEGACY_BARE_ID_ALIASES below — anyone who configured
  // them in the brief E2 → fix window auto-routes to the current
  // equivalents, no visible dropdown clutter.
  codexEntry('gpt-5.5', 'GPT-5.5', ['interactive', 'autonomous'], CODEX_REASONING_CAPABILITIES),
  codexEntry('gpt-5.4', 'GPT-5.4', ['interactive', 'autonomous', 'memory'], CODEX_REASONING_CAPABILITIES),
  codexEntry('gpt-5.4-mini', 'GPT-5.4 Mini', ['interactive', 'autonomous', 'memory'], CODEX_REASONING_CAPABILITIES),
  codexEntry('gpt-5.3-codex', 'GPT-5.3 Codex', ['interactive', 'autonomous'], CODEX_REASONING_CAPABILITIES),
  codexEntry('gpt-5.2', 'GPT-5.2', ['interactive', 'autonomous'], CODEX_REASONING_CAPABILITIES),
] as const;

/**
 * Map of model id → minimum Claude Code version. Derived from `MODELS`
 * so the manifest stays single-source. Used by the backend runtime-health
 * service to compute the per-tier minimum requirement across configured
 * model tiers (interactive / autonomous / pulse).
 *
 * Keyed by raw `id` (not canonical ref) for back-compat with existing
 * `MODEL_MIN_CC.get(rawModelId)` callers.
 */
export const MODEL_MIN_CC: ReadonlyMap<string, string> = new Map(
  MODELS
    .filter((m): m is ModelEntry & { minClaudeCodeVersion: string } => !!m.minClaudeCodeVersion)
    .map((m) => [m.id, m.minClaudeCodeVersion]),
);

// ---------------------------------------------------------------------------
// Model reference parsing + normalization
// ---------------------------------------------------------------------------

/** Resolved model reference — what the resolver hands to a runtime. */
export interface ModelRef {
  /** Canonical form, `<provider>/<model>`. */
  canonical: string;
  /** Provider namespace. */
  provider: ProviderId;
  /** Provider-native model id (the value handed to the SDK / API). */
  model: string;
  /** Runtime implementation that should execute this ref. */
  runtime: RuntimeId;
}

/** Known provider prefixes. */
const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'claude',
  'openai-codex',
  'openrouter',
  'ollama',
]);

/**
 * Parse a canonical `<provider>/<model>` ref. Splits on the FIRST `/` so
 * `openrouter/anthropic/claude-sonnet-4-6` parses as
 * `(openrouter, anthropic/claude-sonnet-4-6)`.
 *
 * Returns `null` if the input doesn't contain `/` (use `normalizeModelRef`
 * for legacy bare-id strings) or if the provider prefix is unknown.
 */
export function parseModelRef(canonical: string): ModelRef | null {
  const slash = canonical.indexOf('/');
  if (slash < 0) return null;
  const provider = canonical.slice(0, slash) as ProviderId;
  const model = canonical.slice(slash + 1);
  if (!KNOWN_PROVIDERS.has(provider)) return null;
  if (!model) return null;
  return {
    canonical,
    provider,
    model,
    runtime: providerToRuntime(provider),
  };
}

/**
 * Normalize either a legacy bare model id (`claude-sonnet-4-6`, `sonnet`)
 * or a canonical ref (`claude/claude-sonnet-4-6`) to a `ModelRef`.
 *
 * Back-compat rules:
 * - Input contains `/` AND has a known provider prefix → treat as canonical.
 * - Otherwise → treat as a legacy Claude id (every pre-multi-provider
 *   config value was a Claude id).
 *
 * This is intentionally liberal: a typoed legacy id like
 * `claude-opus-99` returns a `ModelRef` pointing at the (probably
 * nonexistent) Claude model. Validation that the model actually exists
 * happens at the SDK boundary, not here — same as the pre-PR-A behavior.
 *
 * Throws only for genuinely empty input or canonical-form input with an
 * unknown provider prefix.
 */
/**
 * Aliases for bare ids whose manifest entry has been replaced. Keyed by
 * the OLD id, value is the canonical ref the new manifest entry uses.
 * Used by `normalizeModelRef` after the manifest lookup miss but before
 * the Claude fallback — so old config values stay routed to the right
 * provider instead of silently falling through to the Claude SDK.
 *
 * Add entries here whenever a manifest id changes. Removing entries
 * silently breaks anyone with the old id in their config; prefer to
 * leave aliases in long-term unless the legacy id is known-dead.
 */
const LEGACY_BARE_ID_ALIASES: Record<string, string> = {
  // PR E0 preview ids → current Codex equivalents (PR E2 post-review).
  'gpt-5': 'openai-codex/gpt-5.5',
  'gpt-5-mini': 'openai-codex/gpt-5.4-mini',
  // o3 was the E0 reasoning placeholder. pi-ai's openai-codex registry
  // doesn't expose an o3 id; route to gpt-5.5 (current reasoning-
  // capable Codex flagship). Users who want a smaller reasoning model
  // can pick gpt-5.4-mini explicitly in Settings.
  'o3': 'openai-codex/gpt-5.5',
  // Brief-window aliases: ids that appeared in PR E2's initial commit
  // before the post-review version bump. Cheap to keep and protect
  // anyone who configured them in the gap. Drop after a few releases
  // once it's clear no one's pinning them.
  'gpt-5.1': 'openai-codex/gpt-5.5',
  'gpt-5.1-codex-mini': 'openai-codex/gpt-5.4-mini',
};

export function normalizeModelRef(input: string): ModelRef {
  if (!input || !input.trim()) {
    throw new Error('normalizeModelRef: empty model reference');
  }
  const trimmed = input.trim();

  // Canonical form path
  if (trimmed.includes('/')) {
    const parsed = parseModelRef(trimmed);
    if (parsed) return parsed;
    // Has a `/` but provider prefix is unknown — friendly error.
    const prefix = trimmed.slice(0, trimmed.indexOf('/'));
    throw new Error(
      `normalizeModelRef: unknown provider "${prefix}" in "${trimmed}". ` +
      `Known providers: ${[...KNOWN_PROVIDERS].join(', ')}.`,
    );
  }

  // Bare-id path: check the manifest first. If this id matches a known
  // entry, use that entry's provider/runtime so non-Claude bare ids
  // (e.g. `gpt-5` from the dropdown) route correctly. Without this
  // lookup, every bare id silently became a Claude ref via the legacy
  // fallback below — which then bypassed `unwrapModelRefForClaudeSdk`'s
  // friendly-error guard for non-Claude entries (PR E0 smoke caught:
  // selecting "GPT-5 (Codex preview)" in the UI sent `gpt-5` to the
  // SDK as a Claude model, which Anthropic's API silently accepted /
  // routed somewhere unexpected instead of erroring cleanly).
  const entry = MODELS.find((m) => m.id === trimmed);
  if (entry) {
    return {
      canonical: entry.ref,
      provider: entry.provider,
      model: entry.id,
      runtime: entry.runtime,
    };
  }

  // PR E2: legacy alias map for E0 preview ids. The first wave of Codex
  // preview entries (gpt-5, gpt-5-mini, o3) were placeholders that PR E2
  // replaced with real pi-ai-registered ids. Anyone who saved a preview
  // id to their config would otherwise fall through to the Claude fallback
  // below, silently sending a Codex-shaped id to the Claude SDK boundary.
  // Map old → closest current Codex equivalent before the fallback.
  const aliased = LEGACY_BARE_ID_ALIASES[trimmed];
  if (aliased) {
    // Re-resolve through the canonical-form branch — guarantees the
    // mapped target gets validated against the manifest, and any future
    // alias-of-alias mistake surfaces as an unknown provider error
    // instead of silently mis-routing.
    return normalizeModelRef(aliased);
  }

  // Legacy fallback: assume Claude. Matches every pre-multi-provider
  // config value (all of which were Claude ids), AND covers typoed
  // ids (e.g. `claude-opus-99`) that aren't in the manifest but are
  // clearly intended to be Claude — the SDK boundary catches them.
  return {
    canonical: `claude/${trimmed}`,
    provider: 'claude',
    model: trimmed,
    runtime: 'claude-sdk',
  };
}

/**
 * Look up a `ModelEntry` for a ref or legacy id. Returns `undefined` if
 * no manifest entry matches — useful for "is this a known model?" checks.
 *
 * Matches on `entry.ref === canonical` so both canonical and legacy
 * inputs find their entry (legacy normalizes to `claude/<id>` which
 * matches the Claude entries' refs).
 */
export function findModelByRef(input: string): ModelEntry | undefined {
  let ref: ModelRef;
  try {
    ref = normalizeModelRef(input);
  } catch {
    return undefined;
  }
  return MODELS.find((m) => m.ref === ref.canonical);
}

/**
 * Filter the manifest down to models whose tierHints include the given
 * tier. UI uses this to populate per-tier dropdowns (e.g. pulse picker
 * only shows pulse-eligible models).
 */
export function getModelsForTier(tier: TierHint): readonly ModelEntry[] {
  return MODELS.filter((m) => m.tierHints.includes(tier));
}

/**
 * Unwrap a `ModelRef` to the raw provider-native string the Claude Agent
 * SDK expects (e.g. `claude-sonnet-4-6`, `sonnet`).
 *
 * Throws a friendly error if `ref.runtime !== 'claude-sdk'` — protects
 * the SDK boundary from being handed a model that requires a runtime
 * that isn't wired up yet. The error message tells the operator how to
 * recover (switch back to a Claude model in Settings) rather than
 * surfacing as an opaque SDK 4xx.
 *
 * This is the "sticky-note" guard from PR A of the multi-provider arc:
 * canonical refs flow through resolver/config plumbing freely, but
 * never reach `@anthropic-ai/claude-agent-sdk` in their canonical form.
 */
export function unwrapModelRefForClaudeSdk(ref: ModelRef, tierLabel?: string): string {
  if (ref.runtime !== 'claude-sdk') {
    const tierPart = tierLabel ? ` for the ${tierLabel} tier` : '';
    throw new Error(
      `Model "${ref.canonical}" requires the ${ref.runtime} runtime, but ` +
      `only the claude-sdk runtime is wired up in this build. Switch back ` +
      `to a Claude model${tierPart} in Settings.`,
    );
  }
  return ref.model;
}
