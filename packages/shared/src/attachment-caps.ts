/**
 * Attachment caps shared between the backend image extractor and the
 * frontend pre-send guards. Single source of truth so the user-facing
 * pre-send hint ("you're at 11/10 images" / "selection totals ~16MB,
 * limit is 15MB") and the backend post-send fallback notice
 * ("[image not attached — over 5MB cap]") can never disagree.
 *
 * Originally hardcoded inside `runtimes/codex-image-extractor.ts`
 * (backend) only — moved to shared in PR E3a.5 when the frontend
 * started enforcing the same numbers pre-send.
 */

/**
 * Hard cap on raw image file size, measured on disk before base64
 * encoding. Backend rejects per-image; frontend warns pre-send so
 * the user removes the offender before pressing send.
 *
 * Chosen to comfortably fit two 5MB images plus headroom inside the
 * per-turn encoded cap (5MB binary → ~6.67MB encoded; two of them
 * = ~13.34MB, well under 15MB).
 */
export const MAX_BINARY_BYTES_PER_IMAGE = 5 * 1024 * 1024;

/**
 * Hard cap on the SUM of base64-encoded image bytes attached to a
 * single user turn. Counted post-encoding because that's what
 * actually leaves on the wire to the model provider. Backend drops
 * images at this boundary; frontend warns pre-send.
 */
export const MAX_ENCODED_BYTES_PER_TURN = 15 * 1024 * 1024;

/**
 * Hard cap on the number of image attachments per user message.
 * Universal across providers (Anthropic's API limit is 100/request
 * but no consumer-realistic conversation needs that). Matches the
 * ChatGPT / Claude.ai UX convention.
 *
 * Enforced at the frontend send-time chokepoint; backend treats
 * this as soft (extractor will process whatever the frontend let
 * through, then per-image / per-turn budgets do the structural
 * defense).
 */
export const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * Exact base64-encoded length for a given binary byte count.
 * Standard base64 inflation is ceil(n / 3) * 4 — 3 input bytes
 * become 4 output chars, padded with `=` when the input length
 * isn't a multiple of 3. The "~33% inflation" rule of thumb is the
 * rounded average; this formula is exact.
 *
 * Used by the frontend pre-send size hint to predict whether a
 * selection will fit under `MAX_ENCODED_BYTES_PER_TURN` before
 * actually encoding (which would mean reading every file into
 * memory just to measure).
 */
export function estimateBase64Length(binaryByteCount: number): number {
  if (!Number.isFinite(binaryByteCount) || binaryByteCount < 0) return 0;
  return Math.ceil(binaryByteCount / 3) * 4;
}
