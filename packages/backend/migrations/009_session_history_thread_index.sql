-- Index to speed up thread-scoped lookups on session_history.
-- session_history itself lives in 001_init.sql; this index does not.
CREATE INDEX idx_session_history_thread_id ON session_history(thread_id);
