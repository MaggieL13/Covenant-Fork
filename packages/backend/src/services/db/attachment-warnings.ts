/**
 * Persistence for `attachment_warning` WS events (Cleanup-2).
 *
 * The live WS event surface (introduced in PR E3a.5) tells the user
 * "this image was dropped because..." in real time. But the pills
 * live in browser memory only — page reload loses them. For users
 * who want to look back at "wait, what got dropped on Tuesday?"
 * the live-only surface isn't enough.
 *
 * This module writes each warning into the owner message's
 * `metadata.attachmentWarnings` array. The frontend seeds its
 * reactive map from this on initial message load (or thread
 * switch), so reload restores the pills. Live and persisted are
 * deduped by `fileId` per message — a backend re-run that emits
 * the same warning twice produces one persisted entry, not two.
 *
 * Pattern follows `db/reactions.ts` — read-modify-write the
 * metadata object inside a single transaction, write the
 * serialized JSON back.
 */

import { getDb } from './state.js';
import { getMessage } from './messages.js';

export interface PersistedAttachmentWarning {
  fileId: string;
  filename?: string;
  reason: string;
  /** ISO timestamp when the backend recorded this drop. Frontend
   *  surfaces as the pill's "when" for sort / debug purposes. */
  receivedAt: string;
}

/**
 * Append a warning to `messages[messageId].metadata.attachmentWarnings`.
 * Dedupes by `fileId` — if a warning with the same fileId already
 * exists on this message, this is a no-op. (Backend re-runs of the
 * same turn produce the same notices; we don't want them to grow
 * the array unbounded.)
 *
 * Silently no-ops on unknown messageId — the owner row may have
 * been deleted between extractor run and broadcast, no point
 * crashing the turn.
 */
export function appendAttachmentWarning(
  messageId: string,
  warning: Omit<PersistedAttachmentWarning, 'receivedAt'> & {
    receivedAt?: string;
  },
): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata =
      msg.metadata && typeof msg.metadata === 'object'
        ? { ...(msg.metadata as Record<string, unknown>) }
        : {};

    const existing: PersistedAttachmentWarning[] = Array.isArray(
      metadata.attachmentWarnings,
    )
      ? ([...(metadata.attachmentWarnings as PersistedAttachmentWarning[])])
      : [];

    // Dedupe by fileId — first writer wins.
    if (existing.some((w) => w.fileId === warning.fileId)) return;

    const entry: PersistedAttachmentWarning = {
      fileId: warning.fileId,
      filename: warning.filename,
      reason: warning.reason,
      receivedAt: warning.receivedAt ?? new Date().toISOString(),
    };
    existing.push(entry);
    metadata.attachmentWarnings = existing;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(
      JSON.stringify(metadata),
      messageId,
    );
  });
  run();
}
