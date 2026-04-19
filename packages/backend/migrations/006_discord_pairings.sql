-- Discord user pairing requests and approvals.
CREATE TABLE discord_pairings (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT
);
