-- Phase 5a (cleanup after docs/adr/004-site-file-tree.md): make sites.object_key and
-- versions.object_key nullable. Code no longer touches these two columns or site_assets. The
-- columns and table are dropped in the next migration, 0012.
-- Not dropped in one go because the old Worker still running between apply and deploy selects
-- every column by name via Drizzle's select() (dropping a column breaks reads from that moment).
-- Merely dropping NOT NULL lets the old Worker keep reading and writing. SQLite cannot change
-- constraints with ALTER, so recreate the tables as in 0004. Column order and constraints copy
-- the current DDL (sqlite_master). No table has foreign keys, triggers or views

CREATE TABLE sites_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  object_key TEXT,
  folder_id TEXT,
  entry_path TEXT NOT NULL DEFAULT 'index.html'
);
INSERT INTO sites_new (id, title, source_name, size, published, created_at, updated_at,
                       object_key, folder_id, entry_path)
  SELECT id, title, source_name, size, published, created_at, updated_at,
         object_key, folder_id, entry_path FROM sites;
DROP TABLE sites;
ALTER TABLE sites_new RENAME TO sites;
CREATE INDEX idx_sites_created_at ON sites(created_at DESC);
CREATE INDEX idx_sites_title ON sites(title);
CREATE INDEX idx_sites_source_name ON sites(source_name);
CREATE INDEX idx_sites_folder_id ON sites(folder_id);

CREATE TABLE versions_new (
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_key TEXT,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  entry_path TEXT NOT NULL DEFAULT 'index.html',
  PRIMARY KEY (site_id, version)
);
INSERT INTO versions_new (site_id, version, object_key, title, size, created_at, entry_path)
  SELECT site_id, version, object_key, title, size, created_at, entry_path FROM versions;
DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;
