-- Vector embeddings for messages (semantic search).
CREATE TABLE message_embeddings (
  message_id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
