-- Introduce versioning. Each version is a full copy in R2 (versions/{page_id}/{uuid}.html),
-- and this table is its metadata. Version numbers increase monotonically per page and are not
-- reused after pruning. object_key is a UUID independent of the version number, so R2 keys
-- do not collide under concurrent writes
CREATE TABLE versions (
  page_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- pages.object_key points to the latest version, and delivery reads it.
-- It is updated in the same D1 batch as the insert into versions, so "served content = latest
-- versions row" always holds. NULL is legacy from before versioning, falling back to the old
-- key pages/{id}.html
ALTER TABLE pages ADD COLUMN object_key TEXT;
