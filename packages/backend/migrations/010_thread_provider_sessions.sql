-- PR C of the multi-provider runtime arc: per-(thread, runtime, provider,
-- model_ref) session sidecar.
--
-- Today each thread tracks one Claude SDK session via
-- `threads.current_session_id` (added in 001_init.sql). That works fine while
-- Claude is the only runtime, but breaks the moment we add a second provider:
-- switching mid-thread from Claude to Codex would either (a) reuse the Claude
-- session id with Codex's API (garbage) or (b) clobber the Claude session
-- pointer (loss of Claude continuity).
--
-- This table stores provider-native session ids — Claude SDK session_id today,
-- Codex conversation_id when PR E lands, OpenRouter session pointer if it
-- ever exposes one, etc. — keyed on the compatibility identity:
-- (thread, runtime, provider, model_ref). A single thread can have multiple
-- rows: one for each (runtime, provider, model_ref) combo it has ever talked
-- to. Switching back to a previously-used combo resumes that combo's session;
-- switching to a brand-new combo starts fresh.
--
-- Why model_ref is part of the key (not just runtime + provider): Claude
-- sessions are model-bound. Resuming a Sonnet session with Opus is incorrect
-- — the session id encodes the model's token context. Putting model_ref in
-- the key prevents cross-model resume regressions. Same caution applies to
-- other providers; some may turn out to be model-agnostic (in which case
-- their runtime can normalize model_ref to a constant before lookup), but
-- the conservative default is per-model.
--
-- `threads.current_session_id` stays in place as a denormalized fast-path
-- for the Claude case. AgentService writes to both this table AND
-- `threads.current_session_id` when capturing a session on the Claude
-- runtime, and reads prefer this table with a fallback to
-- `threads.current_session_id` for threads created before this migration
-- ran (no backfill: pre-existing threads keep working via the fallback,
-- and the new table fills in as they're touched).
--
-- See `shared/multi-provider-runtime-spec-2026-05-16.md` §D5 for the full
-- design including the cross-provider ProviderHandoff packet that PR D adds
-- on top of this table.

-- Plain DDL per migrations/README.md §"Use plain DDL" — no IF NOT EXISTS.
-- Idempotency comes from the `_migrations` ledger; the runner either applies
-- the whole transaction or rolls it back, leaving no partial state.

CREATE TABLE thread_provider_sessions (
  thread_id     TEXT NOT NULL,
  runtime_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model_ref     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (thread_id, runtime_id, provider, model_ref),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- Composite-PK lookup already gives us efficient queries by full key. This
-- secondary index covers the "clear all rows for one thread" path used by
-- `/clear` (otherwise SQLite would still walk the PK btree; this is faster
-- and self-documenting).
CREATE INDEX idx_thread_provider_sessions_thread
  ON thread_provider_sessions (thread_id);

-- For future runtime-health / debug surfaces that want "all sessions across
-- threads for a given (runtime, provider)" — e.g. "how many threads are
-- currently sitting on a Codex session". Not used yet; added now so PR E's
-- diagnostics don't need a follow-up migration.
CREATE INDEX idx_thread_provider_sessions_runtime
  ON thread_provider_sessions (runtime_id, provider);
