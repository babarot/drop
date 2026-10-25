-- Folders are an organizing concept for the admin UI only, never exposed on public pages (/p/:id).
-- pages.folder_id = NULL means "unfiled". Like the existing tables, no FK; the app validates it
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_folders_name ON folders(name);

ALTER TABLE pages ADD COLUMN folder_id TEXT;
CREATE INDEX idx_pages_folder_id ON pages(folder_id);
