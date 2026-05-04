// MODELS — selectable model identities for the model selector dropdown.
//
// Two categories:
//   - Pinned versions (e.g. `claude-opus-4-7`) — stable, won't change behavior
//     unless you switch entries.
//   - Family aliases (`opus` / `sonnet` / `haiku`) — auto-track to whatever
//     Anthropic considers latest in that family. They migrate ~a week after
//     a new generation ships, and any user on an alias inherits the new
//     model's behavior automatically. Useful for "always latest with surprise
//     tolerance" — for stability, prefer pinned IDs.
//
// `minClaudeCodeVersion` (optional) declares the minimum bundled Claude Code
// version this model needs. The Settings → Claude Runtime Health card checks
// the bundled SDK runtime against this and warns if it's behind. Most models
// don't need it. Backend authoritative source: services/runtime-health.ts
// MODEL_MIN_CC table — keep both in sync when a new min-version model ships.

export const MODELS = [
  // Pinned versions
  { id: 'claude-opus-4-7', label: 'Opus 4.7', minClaudeCodeVersion: '2.1.111' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  // Family aliases — auto-track the latest of each family server-side.
  { id: 'opus', label: 'Opus (latest, auto-updates)', minClaudeCodeVersion: '2.1.111' },
  { id: 'sonnet', label: 'Sonnet (latest, auto-updates)' },
  { id: 'haiku', label: 'Haiku (latest, auto-updates)' },
] as const;
