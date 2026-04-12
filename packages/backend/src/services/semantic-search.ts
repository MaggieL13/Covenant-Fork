import { embed } from './embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from './vector-cache.js';
import { getDb, getEmbeddingCount, getMessageContext } from './db.js';

export interface SemanticSearchOptions {
  query: string;
  threadId?: string;
  role?: string;
  after?: string;
  before?: string;
  limit?: number;
  context?: number;
}

export interface SemanticSearchResult {
  messageId: string;
  threadId: string;
  threadName: string;
  similarity: number;
  createdAt: string;
  role: string;
  type?: 'message' | 'digest';
  session: { sessionId: string; startedAt: string; endedAt: string | null } | null;
  context: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
    isMatch: boolean;
  }>;
}

export interface SemanticSearchResponse {
  results: SemanticSearchResult[];
  indexed: number;
  totalMessages: number;
  cache: { loaded: boolean; count: number; memoryMb: number };
}

export async function performSemanticSearch(opts: SemanticSearchOptions): Promise<SemanticSearchResponse> {
  const { query, threadId, role, after, before, limit = 10, context: contextSize = 2 } = opts;

  const queryVector = await embed(query);

  const filter: SearchFilter = {};
  if (threadId) filter.threadId = threadId;
  if (role) filter.role = role;
  if (after) filter.after = after;
  if (before) filter.before = before;

  const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
  const ctxWindow = Math.min(contextSize, 10);

  const sessionStmt = getDb().prepare(`
    SELECT sh.session_id, sh.started_at, sh.ended_at
    FROM session_history sh
    WHERE sh.thread_id = ? AND sh.started_at <= ? AND (sh.ended_at IS NULL OR sh.ended_at >= ?)
    LIMIT 1
  `);

  const results = topResults.map(r => {
    // Digest entries don't have message context or sessions
    if (r.type === 'digest') {
      const digestContent = r.content || '';
      return {
        messageId: r.messageId,
        threadId: '',
        threadName: r.threadName,
        similarity: Math.round(r.similarity * 1000) / 1000,
        createdAt: r.createdAt,
        role: 'digest',
        type: 'digest' as const,
        session: null,
        context: [{
          id: r.messageId,
          role: 'digest',
          content: digestContent.length > 500 ? digestContent.slice(0, 500) + '\u2026' : digestContent,
          createdAt: r.createdAt,
          isMatch: true,
        }],
      };
    }

    const surrounding = getMessageContext(r.messageId, ctxWindow);

    let session: { sessionId: string; startedAt: string; endedAt: string | null } | null = null;
    try {
      const row = sessionStmt.get(r.threadId, r.createdAt, r.createdAt) as {
        session_id: string; started_at: string; ended_at: string | null;
      } | undefined;
      if (row) session = { sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at };
    } catch { /* best-effort */ }

    return {
      messageId: r.messageId,
      threadId: r.threadId,
      threadName: r.threadName,
      similarity: Math.round(r.similarity * 1000) / 1000,
      createdAt: r.createdAt,
      role: r.role,
      type: 'message' as const,
      session,
      context: surrounding.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content.length > 500 ? m.content.slice(0, 500) + '\u2026' : m.content,
        createdAt: m.created_at,
        isMatch: m.id === r.messageId,
      })),
    };
  });

  const cache = getCacheStats();
  const { embedded, total } = getEmbeddingCount();
  return { results, indexed: embedded, totalMessages: total, cache };
}
