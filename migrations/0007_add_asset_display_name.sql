-- An asset's display name (the original file name at upload, NFC-normalized).
-- Keeps the original name (e.g. Japanese) apart from filename (the ASCII-only canonical name),
-- for fallback lookup on delivery (/p/:id/<non-ASCII name>.pdf) and for listing.
-- For a normal upload with an ASCII name, equal to filename.
-- unique guarantees unambiguous alias resolution (one display name cannot point to several
-- filenames)
ALTER TABLE page_assets ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
UPDATE page_assets SET display_name = filename;
CREATE UNIQUE INDEX idx_page_assets_display_name ON page_assets(page_id, display_name);
