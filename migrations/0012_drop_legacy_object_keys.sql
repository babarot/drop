-- Phase 5b (cleanup after docs/adr/004-site-file-tree.md): drop sites.object_key and
-- versions.object_key, made nullable in 0011, along with site_assets. Code has touched none of
-- them since 5a, so the Worker running between apply and deploy (5a code) keeps working. Neither
-- column has an index, UNIQUE, foreign key or trigger, so DROP COLUMN succeeds. site_assets'
-- indexes go with the table. R2 objects under legacy keys (versions/, assets/) stay, still
-- referenced from version_files (R2 is not moved)
DROP TABLE site_assets;
ALTER TABLE sites DROP COLUMN object_key;
ALTER TABLE versions DROP COLUMN object_key;
