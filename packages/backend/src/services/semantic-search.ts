import moment from 'moment-timezone';
import { embed } from './embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from './vector-cache.js';
import { getDb, getEmbeddingCount, getMessageContext } from './db.js';
import { parseLocalDateTime } from './time.js';

export interface SemanticSearchOptions {
  query: string;
  threadId?: string;
  role?: string;
  after?: string;
  before?: string;
  limit?: number;
  context?: number;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type NormalizedSemanticSearchDateFilters =
  | { after?: string; before?: string; error?: undefined }
  | { error: string };

/**
 * Normalize the after / before filters supplied to /search-semantic into
 * UTC ISO strings that align with local-day boundaries in the supplied
 * timezone. Compensates for the historical bug where date-only inputs
 * (e.g. "2026-04-21") were compared lexicographically against UTC ISO
 * timestamps in vector-cache, off-by-one for ~3 hours every night around
 * local midnight.
 *
 * Behavior by input shape:
 * - Date-only `YYYY-MM-DD` after  → start of that local day
 * - Date-only `YYYY-MM-DD` before → end of that local day (last
 *   millisecond, DST-aware via moment.tz endOf('day')). Pairs with the
 *   strict `m.createdAt > filter.before` comparison in vector-cache.
 * - Date+time with explicit Z/offset → parsed as an absolute moment
 *   and re-emitted as UTC ISO (no day expansion).
 * - Date+time without offset → interpreted as wall-clock in the
 *   supplied timezone and re-emitted as UTC ISO (no day expansion).
 *
 * Type validation is internal: non-string filters return { error }
 * for the caller to surface as 400. Whitespace-only and unparseable
 * inputs also return { error } rather than silently filtering with
 * a bad boundary.
 */
/** typeof reports arrays as "object" — distinguish them in error messages. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function normalizeSemanticSearchDateFilters(
  tz: string,
  { after, before }: { after?: unknown; before?: unknown },
): NormalizedSemanticSearchDateFilters {
  if (after !== undefined && typeof after !== 'string') {
    return { error: `'after' must be a string, got ${describeType(after)}` };
  }
  if (before !== undefined && typeof before !== 'string') {
    return { error: `'before' must be a string, got ${describeType(before)}` };
  }

  const result: { after?: string; before?: string } = {};

  if (typeof after === 'string') {
    const value = after.trim();
    if (!value) return { error: `'after' is empty or whitespace` };
    if (DATE_ONLY_RE.test(value)) {
      const m = moment.tz(value, 'YYYY-MM-DD', true, tz);
      if (!m.isValid()) return { error: `Invalid 'after' value: ${after}` };
      result.after = m.startOf('day').toISOString();
    } else {
      const d = parseLocalDateTime(tz, value);
      if (!d) return { error: `Invalid 'after' value: ${after}` };
      result.after = d.toISOString();
    }
  }

  if (typeof before === 'string') {
    const value = before.trim();
    if (!value) return { error: `'before' is empty or whitespace` };
    if (DATE_ONLY_RE.test(value)) {
      const m = moment.tz(value, 'YYYY-MM-DD', true, tz);
      if (!m.isValid()) return { error: `Invalid 'before' value: ${before}` };
      // Last ms of the local day. Pairs with vector-cache's strict
      // > comparison: a message at exactly start-of-next-day local
      // is > this bound and correctly excluded.
      result.before = m.endOf('day').toISOString();
    } else {
      const d = parseLocalDateTime(tz, value);
      if (!d) return { error: `Invalid 'before' value: ${before}` };
      result.before = d.toISOString();
    }
  }

  return result;
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
