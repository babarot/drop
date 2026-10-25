CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_pages_created_at ON pages(created_at DESC);
CREATE INDEX idx_pages_title ON pages(title);
