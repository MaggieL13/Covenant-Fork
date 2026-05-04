/**
 * Model manifest — single source of truth for model identities, labels,
 * and runtime requirements. Both the backend (runtime-health service) and
 * frontend (model selector, runtime-health card) read from this file so
 * adding a new model with a min-CC requirement is a one-line edit instead
 * of a two-file edit kept manually in sync.
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
 * checks the bundled SDK runtime against this and warns when behind. Most
 * models don't need it.
 *
 * Why this lives in `shared/` and not in either package: the values are
 * data, not behavior, and they have to match exactly across the wire. A
 * single source kills the drift class entirely.
 *
 * Future-arc note: if/when Anthropic ships a machine-readable manifest
 * for "minimum CC per model," this file becomes the local cache + fallback
 * layer rather than the authoritative source. Same shape, different fill.
 */

export interface ModelEntry {
  /** Anthropic model identity. Pinned (e.g. `claude-opus-4-7`) or family
   *  alias (`opus` / `sonnet` / `haiku`). */
  id: string;
  /** Human-facing label for the dropdown. */
  label: string;
  /** Minimum bundled Claude Code version this model requires. Omit if no
   *  hard floor; the runtime-health card treats absent as "no minimum
   *  declared" (green). */
  minClaudeCodeVersion?: string;
}

export const MODELS: readonly ModelEntry[] = [
  // Pinned versions
  { id: 'claude-opus-4-7', label: 'Opus 4.7', minClaudeCodeVersion: '2.1.111' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  // Family aliases — auto-track the latest of each family server-side.
  // `opus` currently resolves to 4.7, so it inherits the same min-CC.
  { id: 'opus', label: 'Opus (latest, auto-updates)', minClaudeCodeVersion: '2.1.111' },
  { id: 'sonnet', label: 'Sonnet (latest, auto-updates)' },
  { id: 'haiku', label: 'Haiku (latest, auto-updates)' },
] as const;

/**
 * Map of model id → minimum Claude Code version. Derived from `MODELS`
 * so the manifest stays single-source. Used by the backend runtime-health
 * service to compute the per-tier minimum requirement across configured
 * model tiers (interactive / autonomous / pulse).
 */
export const MODEL_MIN_CC: ReadonlyMap<string, string> = new Map(
  MODELS
    .filter((m): m is ModelEntry & { minClaudeCodeVersion: string } => !!m.minClaudeCodeVersion)
    .map((m) => [m.id, m.minClaudeCodeVersion]),
);
