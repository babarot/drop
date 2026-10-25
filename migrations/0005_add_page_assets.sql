-- Binary assets belonging to a page. Lifecycle and visibility follow the page.
-- Stored in R2 at assets/{page_id}/{uuid}{ext} (UUID keys do not collide on replace).
-- Assets are not versioned: old HTML versions always render against the current assets
CREATE TABLE page_assets (
  page_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (page_id, filename)
);
