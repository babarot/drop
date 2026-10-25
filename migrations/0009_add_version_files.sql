-- Store a Site as a file tree (ADR-004). version_files maps Path -> Object per Version, and
-- delivery reads only this. object_key is an opaque pointer that points as is to existing keys
-- under versions/ or assets/ (R2 is not moved). Only new uploads have sha256
CREATE TABLE version_files (
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  PRIMARY KEY (site_id, version, path)
);
-- Used by pruning to tell whether an Object is still referenced (NOT EXISTS on object_key)
CREATE INDEX idx_version_files_object_key ON version_files(site_id, object_key);

-- The Page shown first. Existing Sites are a single HTML file, so the default stands
ALTER TABLE sites ADD COLUMN entry_path TEXT NOT NULL DEFAULT 'index.html';

-- Backfill. Existing Sites are "one HTML file + assets shared by all Versions", so:
-- 1. Each Version's HTML as index.html
INSERT INTO version_files (site_id, version, path, object_key, content_type, size, sha256)
  SELECT site_id, version, 'index.html', object_key, 'text/html', size, NULL FROM versions;

-- 2. The current assets into every Version (old Versions' HTML also rendered with current assets)
INSERT INTO version_files (site_id, version, path, object_key, content_type, size, sha256)
  SELECT a.site_id, v.version, a.filename, a.object_key, a.content_type, a.size, NULL
  FROM site_assets a JOIN versions v ON v.site_id = a.site_id;

-- 3. Make the same Object reachable by the display name Path (e.g. a Japanese name). Existing HTML
-- also refers to display names. If a display name equals another asset's canonical name, the
-- canonical name wins, as in the old delivery (OR IGNORE)
INSERT OR IGNORE INTO version_files (site_id, version, path, object_key, content_type, size, sha256)
  SELECT a.site_id, v.version, a.display_name, a.object_key, a.content_type, a.size, NULL
  FROM site_assets a JOIN versions v ON v.site_id = a.site_id
  WHERE a.display_name <> a.filename;
