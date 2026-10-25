-- Keep the Entry per Version (ADR-004, phase 3 of docs/plans/multi-html.md).
-- With only sites.entry_path, after committing a tree that changes the Entry, restore, history
-- preview and download of earlier Versions can no longer find the Entry row.
-- sites.entry_path stays as a copy of the current Version's value (so delivery need not read
-- versions every time)
ALTER TABLE versions ADD COLUMN entry_path TEXT NOT NULL DEFAULT 'index.html';
UPDATE versions SET entry_path = (SELECT entry_path FROM sites WHERE sites.id = versions.site_id)
  WHERE EXISTS (SELECT 1 FROM sites WHERE sites.id = versions.site_id);

-- Change size from the Entry HTML's size to the total of all files. Display name Paths point to
-- the same Object as the canonical name, so dedupe by object_key per Version before summing
UPDATE versions SET size = (
  SELECT sum(f.size) FROM version_files f
  WHERE f.site_id = versions.site_id AND f.version = versions.version
    AND f.rowid IN (
      SELECT min(g.rowid) FROM version_files g
      WHERE g.site_id = versions.site_id AND g.version = versions.version
      GROUP BY g.object_key
    )
)
WHERE EXISTS (
  SELECT 1 FROM version_files f WHERE f.site_id = versions.site_id AND f.version = versions.version
);
UPDATE sites SET size = (
  SELECT v.size FROM versions v WHERE v.site_id = sites.id ORDER BY v.version DESC LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM versions v WHERE v.site_id = sites.id);
