-- Make object_key required and remove the legacy delivery fallback (pages/{id}.html) from code.
-- Pages from before versioning are migrated with the legacy key itself as the pointer
-- (R2 objects are not moved; the next replace switches to a key under versions/)
UPDATE pages SET object_key = 'pages/' || id || '.html' WHERE object_key IS NULL;

-- SQLite cannot add NOT NULL to an existing column, so recreate the table.
-- If any NULL remains, the INSERT fails and the whole migration stops (fails safe)
CREATE TABLE pages_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  object_key TEXT NOT NULL
);
INSERT INTO pages_new (id, title, filename, size, published, created_at, updated_at, object_key)
  SELECT id, title, filename, size, published, created_at, updated_at, object_key FROM pages;
DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;
CREATE INDEX idx_pages_created_at ON pages(created_at DESC);
CREATE INDEX idx_pages_title ON pages(title);
CREATE INDEX idx_pages_filename ON pages(filename);
