-- Sticker packs and stickers.
-- Created WITHOUT user_only; migration 005 adds that column.
-- Historical sequence preserved: these tables were introduced before the
-- user_only flag, and splitting them keeps each migration as one discrete change.

CREATE TABLE sticker_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  entity_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stickers (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (pack_id) REFERENCES sticker_packs(id),
  UNIQUE(pack_id, name)
);
