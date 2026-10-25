import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  // title: a label for humans. Always derived from the current content (<title> tag ?? sourceName)
  title: text('title').notNull(),
  // sourceName: an identifier from the dropped file's name (without extension).
  // Used to match re-drops and as the download name, and unchanged by a replace
  sourceName: text('source_name').notNull().default(''),
  size: integer('size').notNull(),
  published: integer('published').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // The folder it belongs to (NULL = unfiled). An organizing concept of the admin UI only, never
  // exposed on public sites
  folderId: text('folder_id'),
  // The Path of the Page shown first (ADR-004). A copy of the current version's
  // versions.entry_path, always updated together in the commit batch
  entryPath: text('entry_path').notNull().default('index.html'),
})

// Folders (a site belongs to at most one folder). position is the manual order on the bar
export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Version metadata. The content (file tree) lives in version_files.
// version increases monotonically within a site and is never reused, even after pruning
export const versions = sqliteTable(
  'versions',
  {
    siteId: text('site_id').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    // The total of all files (Paths pointing at the same object count once)
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
    // This version's Entry. sites.entry_path is a copy of this value for the current version
    entryPath: text('entry_path').notNull().default('index.html'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.version] })],
)

// The file tree of each version (Path → Object). Delivery reads only from here (ADR-004).
// One object_key can be pointed at by several versions and Paths, so before deleting an object
// in R2, confirm that no row references it anymore (the pruning in src/lib/versions.ts)
export const versionFiles = sqliteTable(
  'version_files',
  {
    siteId: text('site_id').notNull(),
    version: integer('version').notNull(),
    // NFC-normalized, /-separated, no leading / (e.g. about/index.html)
    path: text('path').notNull(),
    objectKey: text('object_key').notNull(),
    // The value the server determined from the Path's extension
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    // Only new uploads have it. Backfilled rows and rows from the old API are NULL
    sha256: text('sha256'),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.version, t.path] }),
    index('idx_version_files_object_key').on(t.siteId, t.objectKey),
  ],
)

export type SiteRow = typeof sites.$inferSelect
export type VersionRow = typeof versions.$inferSelect
export type VersionFileRow = typeof versionFiles.$inferSelect
export type FolderRow = typeof folders.$inferSelect
