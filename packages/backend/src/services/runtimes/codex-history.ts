/**
 * Builds the `NormalizedMessage[]` history the Codex dispatch branch
 * hands to `CodexRuntime.runTurn`. Pure function, no DB / no I/O —
 * the caller passes the already-loaded DB messages plus the current
 * turn's prompt text. Extracted from `agent.ts` so the load-bearing
 * synthetic-prompt + image-bridge path is testable in isolation.
 *
 * ## What this handles
 *
 * 1. **DB → normalized translation.** Filters out non-user/companion
 *    roles, remaps `companion` → `assistant`, copies `content` and
 *    `created_at`.
 *
 * 2. **Image attachment.** Calls `extractImagesFromMessages` to walk
 *    the dual-shape attachment storage (batched-upload parent +
 *    children, Telegram single-message photoFileId) and attaches
 *    base64 bytes to each owner's normalized entry.
 *
 * 3. **Defensive synthetic-prompt append** (PR E2 Codex catch).
 *    If the chronologically-last user-role replay doesn't match the
 *    current prompt verbatim, we append a fresh user message with
 *    the prompt text. Triggers in two cases the channel handlers
 *    create:
 *      - **batched upload (web)**: `ws/handlers/messages.ts`
 *        synthesizes a multi-image narration as `agentPrompt` while
 *        storing the user's raw caption on the parent DB row.
 *      - **autonomous / programmatic invocation**: no user message
 *        in DB at all; synthetic is the whole turn.
 *
 * 4. **Image bridge to synthetic** (PR E3a Codex catch). The synthetic
 *    has no DB id, so a naive `imagesByMessageId.get(m.id)` lookup
 *    misses it — pi-ai would receive the descriptive text but no
 *    bytes. Bridge: walk backward through normalized, collect images
 *    from the contiguous user-role tail (the "in-flight turn"),
 *    detach them from their original owners, attach the union to the
 *    synthetic. Earlier turns' images stay put.
 *
 * 5. **Fallback annotation.** Per-image-cap / per-turn-cap / missing
 *    / non-image-MIME drops surface as `fallbackNotices` from the
 *    extractor. For in-flight notices we append a bracketed line per
 *    drop to the message the model is actually reading (the
 *    synthetic if it exists, otherwise the last user replay entry)
 *    so the model still hears about the dropped image. Historical
 *    drops are not re-annotated each turn — they're low signal once
 *    the conversation has moved on.
 */

import type { Message } from '@resonant/shared';
import { extractImagesFromMessages, type ImageFallback } from './codex-image-extractor.js';
import type { NormalizedImage, NormalizedMessage } from './types.js';

export interface BuildCodexNormalizedOptions {
  /** Recent DB messages, chronological order (oldest first). */
  dbMessages: Message[];
  /** The current turn's prompt text as the channel handler built it
   *  (post-synthesis for batched uploads). */
  currentContent: string;
  /** ISO timestamp to stamp on the synthetic message when it's
   *  appended. The caller usually passes `new Date().toISOString()`. */
  nowIso: string;
}

export interface BuildCodexNormalizedResult {
  /** History to hand to `CodexRuntime.runTurn` via
   *  `AgentTurnInput.messages`. */
  messages: NormalizedMessage[];
  /** Whether the synthetic-prompt append fired. Diagnostic only —
   *  callers may log this. */
  appendedSynthetic: boolean;
  /** All fallback notices the extractor produced this turn. Surfaced
   *  for diagnostics (already folded into message text where it
   *  matters). */
  fallbackNotices: ImageFallback[];
}

function formatFallback(notice: ImageFallback): string {
  const label = notice.filename ?? notice.fileId;
  return `[image not attached — ${label}: ${notice.reason}]`;
}

export function buildCodexNormalizedMessages(
  opts: BuildCodexNormalizedOptions,
): BuildCodexNormalizedResult {
  const { dbMessages, currentContent, nowIso } = opts;
  const { imagesByMessageId, fallbackNotices } = extractImagesFromMessages(dbMessages);

  const messages: NormalizedMessage[] = dbMessages
    .filter((m) => m.role === 'user' || m.role === 'companion')
    .map((m) => {
      const role: 'user' | 'assistant' =
        m.role === 'companion' ? 'assistant' : 'user';
      const images = imagesByMessageId.get(m.id);
      const out: NormalizedMessage = {
        role,
        content: m.content,
        createdAt: m.created_at,
      };
      if (images && images.length > 0) out.images = images;
      return out;
    });

  // In-flight turn = the contiguous user-role tail of the original
  // dbMessages list (NOT the filtered `messages` array — we walk
  // dbMessages so a stray `system` role between turns is treated as
  // a boundary). These are the DB rows the channel handler just
  // wrote for the current invocation.
  const inFlightOwnerIds = new Set<string>();
  for (let i = dbMessages.length - 1; i >= 0; i--) {
    const m = dbMessages[i];
    if (m.role !== 'user') break;
    inFlightOwnerIds.add(m.id);
  }
  const currentTurnFallbacks = fallbackNotices.filter((f) =>
    inFlightOwnerIds.has(f.ownerMessageId),
  );

  const lastMsg = messages[messages.length - 1];
  const currentPromptPresent =
    lastMsg?.role === 'user' && lastMsg.content === currentContent;

  let appendedSynthetic = false;

  if (!currentPromptPresent) {
    // Image bridge: walk backward through `messages`, collect images
    // from contiguous user-role tail entries, and detach them. The
    // synthetic about to be appended will carry the union — so pi-ai
    // sees the descriptive text + bytes on the same message.
    const transferredImages: NormalizedImage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const nm = messages[i];
      if (nm.role !== 'user') break;
      if (nm.images && nm.images.length > 0) {
        transferredImages.unshift(...nm.images);
        nm.images = undefined;
      }
    }

    let syntheticContent = currentContent;
    if (currentTurnFallbacks.length > 0) {
      syntheticContent =
        syntheticContent + '\n\n' + currentTurnFallbacks.map(formatFallback).join('\n');
    }

    const synthetic: NormalizedMessage = {
      role: 'user',
      content: syntheticContent,
      createdAt: nowIso,
    };
    if (transferredImages.length > 0) synthetic.images = transferredImages;
    messages.push(synthetic);
    appendedSynthetic = true;
  } else if (lastMsg && currentTurnFallbacks.length > 0) {
    // Current prompt already replayed verbatim from DB — annotate it
    // in place so the model hears about dropped images.
    lastMsg.content =
      lastMsg.content + '\n\n' + currentTurnFallbacks.map(formatFallback).join('\n');
  }

  return { messages, appendedSynthetic, fallbackNotices };
}
