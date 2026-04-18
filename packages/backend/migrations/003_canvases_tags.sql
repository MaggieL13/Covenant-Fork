-- Add tags column to canvases for tagging/categorization.
ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]';
