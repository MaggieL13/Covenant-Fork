/**
 * Per-tool output-budget cap (PR E3b/2 review catch).
 *
 * The Codex tool-calling loop driver (PR E3b/4, not yet wired) applies
 * a `MAX_SINGLE_OUTPUT_BYTES = 50KB` truncation to every tool result
 * as a structural safety net so the model doesn't accidentally shove
 * megabytes of tool output back into its own context. But the loop
 * driver runs AFTER the tool has already done the work — so a tool
 * that produces 4MB of text wastes CPU/memory/time on output that
 * gets truncated anyway, plus opens edge cases where the truncation
 * itself happens mid-line / mid-JSON / mid-anything-meaningful.
 *
 * Self-limiting at the TOOL boundary closes both gaps:
 *   - Tools stop producing more output than they're allowed to return
 *   - Truncation messages are formatted by the tool author who knows
 *     the output shape (line-numbered file content vs file:line:match
 *     vs entry listing), not a generic byte-slicer in the loop driver
 *
 * The loop driver's cap stays as a second-line safety net for tools
 * that don't (yet) apply this helper or that have legitimate-but-
 * surprising output growth between commits.
 */

/**
 * Maximum characters a tool result may contain. Matches the loop
 * driver's `MAX_SINGLE_OUTPUT_BYTES` cap. Units are JS string chars
 * (UTF-16 code units); for typical ASCII source-code output that's
 * ~50KB of UTF-8 wire bytes which is what the cap is sized for.
 */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;

/**
 * Truncate `text` to at most `max` characters, appending a clear
 * truncation notice when truncation actually happens. Returns the
 * input untouched if it's already under the cap.
 *
 * The notice includes:
 *   - The cap that fired (so the model can adapt its next call —
 *     "ask for a smaller page" / "use a tighter pattern")
 *   - The number of chars omitted (so the model knows whether it's
 *     missing 100 chars or 4MB worth of content)
 *
 * Notice text is appended INSIDE the truncated window so the final
 * string is exactly `max` chars, never `max + notice.length`. This
 * means the visible content is `max - noticeLength` chars when
 * truncation fires.
 */
export function applyOutputBudget(
  text: string,
  max: number = MAX_TOOL_OUTPUT_CHARS,
): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  const notice = `\n[tool output truncated at ${max} chars; ${omitted} chars omitted — narrow the request to see more]`;
  // Reserve room for the notice INSIDE the cap so the returned string
  // is AT MOST `max` chars regardless of input size. If the caller
  // passed a `max` so small that even the notice doesn't fit, fall
  // back to a truncated notice (no content) — pathological case;
  // production usage always passes the 50KB default which is two
  // orders of magnitude larger than the notice.
  if (max <= notice.length) {
    return notice.slice(0, max);
  }
  const keep = max - notice.length;
  return text.slice(0, keep) + notice;
}
