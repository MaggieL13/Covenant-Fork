import { Router } from 'express';
import crypto from 'crypto';
import {
  listThreads,
  getThread,
  createThread,
  getMessages,
  markMessagesRead,
  getMessage,
  archiveThread,
  deleteThread,
  getDb,
  pinThread,
  unpinThread,
  getTodayThread,
} from '../services/db.js';
import { deleteFile } from '../services/files.js';
import { registry } from '../services/ws.js';
import { localDateStr } from '../services/time.js';
import { getResonantConfig } from '../config.js';

const router = Router();

// Thread list with summary
router.get('/', (req, res) => {
  try {
    const threads = listThreads({ includeArchived: false, limit: 50 });

    // Enhance with last message preview
    const db = getDb();
    const threadsWithPreview = threads.map(thread => {
      const lastMsg = db.prepare(`
        SELECT content, role, created_at
        FROM messages
        WHERE thread_id = ? AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT 1
      `).get(thread.id) as { content: string; role: string; created_at: string } | undefined;

      return {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: lastMsg ? {
          content: lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '...' : ''),
          role: lastMsg.role,
          created_at: lastMsg.created_at,
        } : null,
        pinned_at: thread.pinned_at ?? null,
      };
    });

    res.json({ threads: threadsWithPreview });
  } catch (error) {
    console.error('Error fetching threads:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// Get archived threads (must be before :id routes)
router.get('/archived', (req, res) => {
  try {
    const db = getDb();
    const threads = db.prepare(`
      SELECT * FROM threads WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC LIMIT 50
    `).all();
    res.json({ threads });
  } catch (error) {
    console.error('Error fetching archived threads:', error);
    res.status(500).json({ error: 'Failed to fetch archived threads' });
  }
});

// Create named thread (blank name falls back to today's daily thread)
router.post('/', (req, res) => {
  try {
    const rawName = req.body.name;
    const name = typeof rawName === 'string' ? rawName.slice(0, 200) : rawName;

    if (!name || typeof name !== 'string' || !name.trim()) {
      // Blank name — fall back to today's daily thread (get or create)
      let thread = getTodayThread();
      if (!thread) {
        const now = new Date();
        // Sovereignty + format parity: route through time.ts so all four
        // daily-thread creation sites produce the same "Wednesday, 22 Apr"
        // label. Previous formats here and elsewhere diverged.
        const todayName = localDateStr(getResonantConfig().identity.timezone, now);
        thread = createThread({
          id: crypto.randomUUID(),
          name: todayName,
          type: 'daily',
          createdAt: now.toISOString(),
          sessionType: 'v2',
        });
      }
      res.json({ thread });
      return;
    }

    const thread = createThread({
      id: crypto.randomUUID(),
      name,
      type: 'named',
      createdAt: new Date().toISOString(),
      sessionType: 'v2',
    });

    res.json({ thread });
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Get thread messages (paginated)
router.get('/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const { before, limit } = req.query;

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const messages = getMessages({
      threadId: id,
      before: before as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Archive a thread
router.post('/:id/archive', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    archiveThread(id, new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error archiving thread:', error);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// Unarchive a thread
router.post('/:id/unarchive', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    archiveThread(id, null);
    res.json({ success: true });
  } catch (error) {
    console.error('Error unarchiving thread:', error);
    res.status(500).json({ error: 'Failed to unarchive thread' });
  }
});

// Pin a thread
router.post('/:id/pin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    pinThread(id);
    const updated = getThread(id)!;

    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        unread_count: updated.unread_count,
        last_activity_at: updated.last_activity_at,
        last_message_preview: null,
        pinned_at: updated.pinned_at,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error pinning thread:', error);
    res.status(500).json({ error: 'Failed to pin thread' });
  }
});

// Unpin a thread
router.post('/:id/unpin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    unpinThread(id);

    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: null,
        pinned_at: null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error unpinning thread:', error);
    res.status(500).json({ error: 'Failed to unpin thread' });
  }
});

// Delete a thread and all associated data
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const fileIds = deleteThread(id);

    // Clean up files on disk (best-effort — thread is already deleted)
    for (const fileId of fileIds) {
      try {
        deleteFile(fileId);
      } catch (err) {
        console.warn(`Failed to delete orphaned file ${fileId}:`, err);
      }
    }

    // Broadcast deletion to all connected clients
    registry.broadcast({ type: 'thread_deleted', threadId: id });

    res.json({ success: true, deletedFiles: fileIds.length });
  } catch (error) {
    console.error('Error deleting thread:', error);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// Rename a thread
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rawName = req.body.name;
    const name = typeof rawName === 'string' ? rawName.slice(0, 200) : rawName;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Thread name required' });
      return;
    }

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const db = getDb();
    db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(name, id);

    // Broadcast updated thread to all clients
    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: null,
        pinned_at: thread.pinned_at ?? null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error renaming thread:', error);
    res.status(500).json({ error: 'Failed to rename thread' });
  }
});

// Mark messages as read (mounted at /messages/read from api.ts)
// This is exported separately since it's at a different path
export const markReadHandler = Router();
markReadHandler.post('/messages/read', (req, res) => {
  try {
    const { threadId, beforeId } = req.body;

    if (!threadId || !beforeId) {
      res.status(400).json({ error: 'threadId and beforeId required' });
      return;
    }

    const message = getMessage(beforeId);
    if (!message || message.thread_id !== threadId) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    markMessagesRead(threadId, beforeId, new Date().toISOString());

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

export default router;
