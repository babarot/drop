-- Rename to match the glossary (docs/glossary.md), which calls the unit of upload a Site.
-- pages.filename is confusing next to the assets' filename, so it becomes source_name.
-- RENAME updates index references automatically, but index names stay, so recreate them.
-- A breaking change, but with a single admin user, tens of seconds of errors between
-- "migrate -> deploy" are acceptable
ALTER TABLE pages RENAME TO sites;
ALTER TABLE sites RENAME COLUMN filename TO source_name;
ALTER TABLE page_assets RENAME TO site_assets;
ALTER TABLE site_assets RENAME COLUMN page_id TO site_id;
ALTER TABLE versions RENAME COLUMN page_id TO site_id;

DROP INDEX idx_pages_created_at;
DROP INDEX idx_pages_title;
DROP INDEX idx_pages_filename;
DROP INDEX idx_pages_folder_id;
DROP INDEX idx_page_assets_display_name;
CREATE INDEX idx_sites_created_at ON sites(created_at DESC);
CREATE INDEX idx_sites_title ON sites(title);
CREATE INDEX idx_sites_source_name ON sites(source_name);
CREATE INDEX idx_sites_folder_id ON sites(folder_id);
CREATE UNIQUE INDEX idx_site_assets_display_name ON site_assets(site_id, display_name);
