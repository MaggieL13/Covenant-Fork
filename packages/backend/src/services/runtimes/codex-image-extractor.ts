/**
 * Image extractor for the Codex runtime's vision path.
 *
 * Vision-capable runtimes (Codex via pi-ai's openai-codex-responses
 * provider) need the actual image bytes attached to user messages, not
 * the file-path placeholders the chat synthesizer writes into message
 * content for batched uploads. This module walks the recent DB
 * messages, finds image attachments across BOTH of Covenant's storage
 * shapes, applies size/total budgets, and returns the resulting bytes
 * keyed by the message id that should own them.
 *
 * ## Storage shapes
 *
 * Covenant currently writes image attachments two ways:
 *
 * 1. **Batched upload (web file panel)** — `ws/handlers/messages.ts`
 *    writes ONE parent text message with the user's caption + a
 *    synthesized multi-image narration as `content`, and
 *    `metadata.attachments: Array<{fileId, mimeType, contentType, ...}>`.
 *    The handler then writes one child message PER attachment with
 *    `content_type: 'image'`, `content: <url>`, and
 *    `metadata: { fileId, filename, size, mimeType }`. The parent's
 *    synthesized text is what the model actually reads, so we treat
 *    the parent as owner of the image bytes.
 *
 * 2. **Single attachment (Telegram, internal shares)** — one message
 *    with `content_type: 'image'`, a descriptive caption in `content`,
 *    and `metadata.fileId` (often paired with `metadata.photoFileId`).
 *    No parent/child split; the image-content message is its own
 *    owner.
 *
 * Dedup is by `fileId`. The parent in shape 1 claims its attachments
 * first (chronological walk), and the child file-messages with the
 * matching `metadata.fileId` are skipped to avoid double-counting.
 *
 * ## Budgets
 *
 * - **Per-image cap: 5MB binary file size** (raw bytes on disk,
 *   measured before base64 encoding via `statSync`). Over-cap images
 *   produce a fallback notice and no attachment.
 * - **Per-turn total cap: 15MB encoded payload**, summed across every
 *   image actually attached. The cap is checked AFTER per-image
 *   encoding; the image that would push us over is dropped and a
 *   fallback notice is recorded.
 *
 * Callers append the fallback notices to the prompt so the model
 * still knows an image was referenced and why it can't see it.
 */

import { statSync, readFileSync } from 'fs';
import type { Message } from '@resonant/shared';
import { getFile } from '../files.js';
import type { NormalizedImage } from './types.js';

const MAX_BINARY_BYTES_PER_IMAGE = 5 * 1024 * 1024;
const MAX_ENCODED_BYTES_PER_TURN = 15 * 1024 * 1024;

/**
 * One reason-for-skip per file id. Surfaced to the caller so over-cap
 * / missing / wrong-type attachments can still be acknowledged in the
 * prompt text (the model otherwise wouldn't know the image existed).
 */
export interface ImageFallback {
  fileId: string;
  reason: string;
}

export interface ExtractionResult {
  /** Images keyed by the DB message id that owns them. Each list is
   *  in declared (chronological) order within that message. */
  imagesByMessageId: Map<string, NormalizedImage[]>;
  /** Images referenced in the messages but not attached, with reason. */
  fallbackNotices: ImageFallback[];
}

interface BatchAttachment {
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  contentType?: string;
}

interface ImageRef {
  ownerMessageId: string;
  fileId: string;
  /** Declared MIME from message metadata; resolved against the file's
   *  on-disk MIME at the budget pass. */
  declaredMimeType?: string;
}

/**
 * Two-pass extraction.
 *
 * Pass 1 walks chronologically to collect refs + dedup by fileId.
 * Parent messages with `metadata.attachments` claim their attachments
 * first; child file-messages with the same fileId are dropped. This
 * also handles Telegram-shape single image messages (no parent).
 *
 * Pass 2 enforces budgets. Per-image cap is checked against the
 * on-disk size BEFORE base64 work (cheap reject). Per-turn total cap
 * is a running sum on encoded length; the image that would push the
 * sum over the cap is dropped via a fallback notice.
 */
export function extractImagesFromMessages(messages: Message[]): ExtractionResult {
  const refs: ImageRef[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;

    // Shape 1: parent message with metadata.attachments. Claims its
    // image attachments. The corresponding child file-messages later
    // in the chronological walk get deduped by fileId.
    const rawAttachments = meta.attachments;
    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      let claimedAny = false;
      for (const raw of rawAttachments) {
        const att = raw as BatchAttachment;
        if (!att || typeof att.fileId !== 'string') continue;
        if (att.contentType !== 'image') continue;
        if (seen.has(att.fileId)) continue;
        seen.add(att.fileId);
        refs.push({
          ownerMessageId: msg.id,
          fileId: att.fileId,
          declaredMimeType: att.mimeType,
        });
        claimedAny = true;
      }
      if (claimedAny) continue;
      // Parent had no image attachments but might itself BE one (rare;
      // belt-and-suspenders). Fall through to shape 2 logic.
    }

    // Shape 2: image-content message with metadata.fileId / photoFileId.
    if (msg.content_type !== 'image') continue;
    const fileIdRaw = meta.fileId ?? meta.photoFileId;
    if (typeof fileIdRaw !== 'string') continue;
    if (seen.has(fileIdRaw)) continue;
    seen.add(fileIdRaw);
    refs.push({
      ownerMessageId: msg.id,
      fileId: fileIdRaw,
      declaredMimeType: typeof meta.mimeType === 'string' ? meta.mimeType : undefined,
    });
  }

  const imagesByMessageId = new Map<string, NormalizedImage[]>();
  const fallbackNotices: ImageFallback[] = [];
  let totalEncoded = 0;

  for (const ref of refs) {
    const file = getFile(ref.fileId);
    if (!file) {
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: 'file not found on disk',
      });
      continue;
    }

    const mimeType = ref.declaredMimeType ?? file.mimeType;
    if (!mimeType.startsWith('image/')) {
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: `non-image MIME type rejected (${mimeType})`,
      });
      continue;
    }

    let binarySize: number;
    try {
      binarySize = statSync(file.path).size;
    } catch (err) {
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (binarySize > MAX_BINARY_BYTES_PER_IMAGE) {
      const sizeMb = (binarySize / 1024 / 1024).toFixed(1);
      const capMb = (MAX_BINARY_BYTES_PER_IMAGE / 1024 / 1024).toFixed(0);
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: `image too large to include — ${sizeMb}MB exceeds ${capMb}MB per-image cap`,
      });
      continue;
    }

    let base64: string;
    try {
      base64 = readFileSync(file.path).toString('base64');
    } catch (err) {
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (totalEncoded + base64.length > MAX_ENCODED_BYTES_PER_TURN) {
      const capMb = (MAX_ENCODED_BYTES_PER_TURN / 1024 / 1024).toFixed(0);
      fallbackNotices.push({
        fileId: ref.fileId,
        reason: `image dropped — turn total would exceed ${capMb}MB encoded cap`,
      });
      continue;
    }
    totalEncoded += base64.length;

    let list = imagesByMessageId.get(ref.ownerMessageId);
    if (!list) {
      list = [];
      imagesByMessageId.set(ref.ownerMessageId, list);
    }
    list.push({ base64, mimeType });
  }

  return { imagesByMessageId, fallbackNotices };
}

/** Exported solely for the test suite — assertions against the budget
 *  constants without hard-coding them in the test file. */
export const __TEST_INTERNALS__ = Object.freeze({
  MAX_BINARY_BYTES_PER_IMAGE,
  MAX_ENCODED_BYTES_PER_TURN,
});
