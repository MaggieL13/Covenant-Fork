-- Vector embeddings for scribe digests (semantic search over daily summaries).
CREATE TABLE digest_embeddings (
  digest_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
