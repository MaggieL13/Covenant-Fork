-- Add user_only flag to sticker_packs for packs restricted to user-only use.
ALTER TABLE sticker_packs ADD COLUMN user_only INTEGER DEFAULT 0;
