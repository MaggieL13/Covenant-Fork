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
 *    **Autonomous turns suppress the bridge** (PR E3a/3 Codex catch).
 *    When `isAutonomous: true`, the synthetic represents a pulse /
 *    wake / programmatic prompt that is NOT a synthesized form of
 *    the user-role tail. The tail might be an old unanswered user
 *    image — pulling its bytes onto the autonomous prompt would
 *    attach an image the autonomous text never references. With
 *    `isAutonomous` set, tail images stay on their DB-owner messages
 *    and the synthetic appends image-less. Codex still sees the
 *    historical image in its proper place; it just doesn't get
 *    duplicated onto the wake prompt.
 *
 * 5. **Fallback annotation.** Per-image-cap / per-turn-cap / missing
 *    / non-image-MIME drops surface as `fallbackNotices` from the
 *    extractor. For interactive turns, in-flight notices append a
 *    bracketed line per drop to the message the model is actually
 *    reading (the synthetic if it exists, otherwise the last user
 *    replay entry) so the model still hears about the dropped image.
 *    Autonomous turns skip in-flight annotation for the same reason
 *    the bridge does — there is no "current turn" the synthetic
 *    represents. Historical drops are not re-annotated each turn —
 *    they're low signal once the conversation has moved on.
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
  /** Pulse / wake / programmatic invocation? When true, the synthetic
   *  prompt is NOT a synthesized form of the user-role tail and must
   *  not inherit tail images or in-flight fallback annotations. The
   *  tail might be an old unanswered user-image message (Maggie sent
   *  a photo and went to sleep; autonomous wake fires) — pulling its
   *  bytes onto the wake prompt would attach an image the wake text
   *  never references. */
  isAutonomous: boolean;
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

function attachmentFileIds(msg: Message): Set<string> {
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const rawAttachments = meta.attachments;
  const ids = new Set<string>();
  if (!Array.isArray(rawAttachments)) return ids;
  for (const raw of rawAttachments) {
    const att = raw as { fileId?: unknown };
    if (typeof att.fileId === 'string') ids.add(att.fileId);
  }
  return ids;
}

function messageFileId(msg: Message): string | undefined {
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const fileId = meta.fileId ?? meta.photoFileId;
  return typeof fileId === 'string' ? fileId : undefined;
}

function currentInvocationOwnerIds(dbMessages: Message[], isAutonomous: boolean): Set<string> {
  const ids = new Set<string>();
  if (isAutonomous) return ids;

  let i = dbMessages.length - 1;
  while (i >= 0 && dbMessages[i].role !== 'user') i--;
  if (i < 0) return ids;

  const last = dbMessages[i];
  ids.add(last.id);

  // Batched web uploads write one parent text row, then one child row per
  // attachment. If the newest row is a child file message, walk backward
  // through sibling file rows until the matching parent attachments row.
  if (last.content_type === 'image' || last.content_type === 'audio' || last.content_type === 'file') {
    const childFileIds = new Set<string>();
    const firstChildIndex = i;
    for (; i >= 0; i--) {
      const msg = dbMessages[i];
      if (msg.role !== 'user') break;
      if (msg.content_type !== 'image' && msg.content_type !== 'audio' && msg.content_type !== 'file') break;
      ids.add(msg.id);
      const fileId = messageFileId(msg);
      if (fileId) childFileIds.add(fileId);
    }

    if (i >= 0 && dbMessages[i].role === 'user') {
      const parentIds = attachmentFileIds(dbMessages[i]);
      const allChildrenBelongToParent =
        childFileIds.size > 0
        && [...childFileIds].every((fileId) => parentIds.has(fileId));
      if (allChildrenBelongToParent) {
        ids.add(dbMessages[i].id);
      } else {
        // The newest file row is a single-attachment message, not a
        // batched-upload child. Keep only that newest owner.
        ids.clear();
        ids.add(dbMessages[firstChildIndex].id);
      }
    } else {
      // Reached the start of history (or a non-user boundary) without a
      // batched-upload parent. Treat the newest file row as a standalone
      // single attachment and leave older stacked user files alone.
      ids.clear();
      ids.add(dbMessages[firstChildIndex].id);
    }
  }

  return ids;
}

export function buildCodexNormalizedMessages(
  opts: BuildCodexNormalizedOptions,
): BuildCodexNormalizedResult {
  const { dbMessages, currentContent, nowIso, isAutonomous } = opts;
  const { imagesByMessageId, fallbackNotices } = extractImagesFromMessages(dbMessages);

  const replayEntries: Array<{ ownerMessageId: string; message: NormalizedMessage }> = dbMessages
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
      return { ownerMessageId: m.id, message: out };
    });
  const messages: NormalizedMessage[] = replayEntries.map((entry) => entry.message);

  // In-flight owners = DB rows the channel handler just wrote for this
  // invocation. This is intentionally narrower than "all contiguous
  // trailing user rows": two user sends can stack before an assistant
  // reply, and an older trailing image must not be stolen onto the new
  // synthetic prompt.
  //
  // For autonomous turns the tail does NOT represent the in-flight
  // turn — the synthetic is a pulse/wake prompt, not a synthesized
  // form of any user message. Treat the in-flight set as empty so
  // neither images nor fallback annotations leak from the tail onto
  // the autonomous synthetic.
  const inFlightOwnerIds = currentInvocationOwnerIds(dbMessages, isAutonomous);
  const currentTurnFallbacks = fallbackNotices.filter((f) =>
    inFlightOwnerIds.has(f.ownerMessageId),
  );

  const lastMsg = messages[messages.length - 1];
  const currentPromptPresent =
    lastMsg?.role === 'user' && lastMsg.content === currentContent;

  let appendedSynthetic = false;

  if (!currentPromptPresent) {
    // Image bridge: walk backward through the replay entries, collect
    // images ONLY from DB owners identified as in-flight for this
    // invocation, and detach them. The synthetic about to be appended
    // will carry the union — so pi-ai sees the descriptive text + bytes
    // on the same message without stealing older trailing user images.
    //
    // Autonomous suppresses this entirely (see comment on the in-flight
    // set above). The tail images stay attached to their original
    // DB-owner messages so Codex still sees them in their proper
    // place; they just don't get duplicated onto the wake prompt.
    const transferredImages: NormalizedImage[] = [];
    if (!isAutonomous) {
      for (let i = replayEntries.length - 1; i >= 0; i--) {
        const { ownerMessageId, message: nm } = replayEntries[i];
        if (nm.role !== 'user') break;
        if (!inFlightOwnerIds.has(ownerMessageId)) continue;
        if (nm.images && nm.images.length > 0) {
          transferredImages.unshift(...nm.images);
          nm.images = undefined;
        }
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
    // in place so the model hears about dropped images. (Autonomous
    // never reaches this branch because the in-flight set is empty,
    // so currentTurnFallbacks is also empty.)
    lastMsg.content =
      lastMsg.content + '\n\n' + currentTurnFallbacks.map(formatFallback).join('\n');
  }

  return { messages, appendedSynthetic, fallbackNotices };
}
