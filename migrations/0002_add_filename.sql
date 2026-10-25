-- Split title (label) from filename (identifier).
-- filename is used for re-drop matching and download names. Existing rows' title
-- comes straight from the file name, so backfill it as is to keep the meaning
ALTER TABLE pages ADD COLUMN filename TEXT NOT NULL DEFAULT '';
UPDATE pages SET filename = title WHERE filename = '';
CREATE INDEX idx_pages_filename ON pages(filename);
