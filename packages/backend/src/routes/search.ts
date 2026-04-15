import { Router } from 'express';
import type { AgentService } from '../services/agent.js';
import { getRecentAuditEntries } from '../services/audit.js';
import { searchMessages } from '../services/db.js';
import { performSemanticSearch } from '../services/semantic-search.js';

const router = Router();

router.get('/search', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      res.status(400).json({ error: 'Search query required' });
      return;
    }

    const threadId = req.query.threadId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const { messages: rows, total } = searchMessages({ query: q.trim(), threadId, limit, offset });

    const results = rows.map((row) => {
      const index = row.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, index - 40);
      const end = Math.min(row.content.length, index + q.length + 40);
      const highlight = (start > 0 ? '...' : '') + row.content.slice(start, end) + (end < row.content.length ? '...' : '');

      return {
        messageId: row.id,
        threadId: row.thread_id,
        threadName: row.thread_name,
        role: row.role,
        content: row.content.substring(0, 200),
        highlight,
        createdAt: row.created_at,
      };
    });

    res.json({ results, total });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.post('/search-semantic', async (req, res) => {
  try {
    const { query, threadId, role, after, before, limit, context } = req.body as Record<string, unknown>;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const response = await performSemanticSearch({
      query,
      threadId: threadId as string | undefined,
      role: role as string | undefined,
      after: after as string | undefined,
      before: before as string | undefined,
      limit: typeof limit === 'number' ? limit : 10,
      context: typeof context === 'number' ? context : 2,
    });

    res.json(response);
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ error: 'Semantic search failed' });
  }
});

router.get('/audit', (req, res) => {
  try {
    const { limit } = req.query;
    const entries = getRecentAuditEntries(limit ? parseInt(limit as string, 10) : 50);
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const { limit } = req.query;
    const agentService = req.app.locals.agentService as AgentService;
    const sessions = await agentService.listSessions(limit ? parseInt(limit as string, 10) : 50);
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

export default router;
