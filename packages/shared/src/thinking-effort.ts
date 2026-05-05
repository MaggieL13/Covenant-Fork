/**
 * Thinking effort resolution — single source of truth for the
 * `agent.thinking_effort` config knob.
 *
 * The user-facing setting accepts a named effort level OR `'auto'`,
 * which delegates the choice to a small per-model resolver. Auto's
 * goal is "sensible and cheap by default" — not "secretly expensive."
 * Heavier values (`xhigh`, `max`) stay available as explicit opt-ins
 * for users who want the big-brain firepower.
 *
 * Lives in `shared/` because both the backend (config resolution at
 * the SDK call site) and the frontend (Settings dropdown showing
 * "Auto resolves to: Chat X → high · Autonomous Y → high") need to
 * agree on the table. Keeps the displayed values matching what the
 * backend actually sends.
 */

/** Valid values for `agent.thinking_effort`. `'auto'` means "let the
 *  resolver pick per model." The other five map directly to the SDK's
 *  `EffortLevel` type. */
export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Concrete effort level the SDK accepts. Strict subset of `ThinkingEffort`
 *  excluding `'auto'` — what the resolver returns. */
export type ResolvedEffort = Exclude<ThinkingEffort, 'auto'>;

/**
 * Resolve a configured effort value to a concrete level for a given model.
 *
 * - If the user picked an explicit value (anything other than `'auto'`),
 *   return it verbatim — explicit overrides are respected, even if the
 *   model would 400 on them. We don't second-guess the user.
 * - If the user picked `'auto'` (or the value is missing/invalid), pick
 *   a conservative default per model class:
 *     - Haiku family → `'medium'` (lightweight; saves tokens)
 *     - Everything else (Opus / Sonnet) → `'high'` (solid reasoning, not
 *       wasteful, valid on every supported model)
 *
 * Auto deliberately does NOT return `'xhigh'` or `'max'` for any model.
 * Both are "spend freely" modes — `xhigh` is recommended for deep
 * agentic/coding work, `max` for frontier reasoning. Making either the
 * silent default would be like putting the agent in deep-research mode
 * for a "what time is it" query: funny once, expensive forever.
 *
 * Pulse turns don't go through this — they use `thinking: { type: 'disabled' }`
 * so the effort value is moot.
 */
export function resolveEffortForModel(
  model: string,
  configured: ThinkingEffort | string | undefined,
): ResolvedEffort {
  // Explicit non-auto choice: respect it as the user's intentional setting.
  if (
    configured === 'low' ||
    configured === 'medium' ||
    configured === 'high' ||
    configured === 'xhigh' ||
    configured === 'max'
  ) {
    return configured;
  }

  // Auto path (or missing/invalid value defaulting to auto behavior).
  // Match Haiku family by substring — covers `haiku` alias, pinned IDs
  // like `claude-haiku-4-5`, and any future Haiku variant.
  if (/haiku/i.test(model)) return 'medium';

  // Opus / Sonnet / family aliases / unknown future models: 'high' is
  // the safe baseline. Solid reasoning, not a wallet hit, valid across
  // every current model generation.
  return 'high';
}
