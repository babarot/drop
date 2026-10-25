import { and, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Backend, Db } from '../backend/types'
import { type SiteRow, sites, versionFiles, versions } from '../db/schema'
import { MAX_VERSIONS } from '../types'
import { isNotNullViolation, isUniqueViolation } from './db-errors'
import { deleteUnreferenced } from './files'
import { assetPrefix, objectPrefix, versionPrefix } from './r2'

// Extract the text of the first <title> in an HTML body. null if there is none.
// HTMLRewriter streams, so the collected value is read only after the transformed Response has
// been fully consumed
export async function extractHtmlTitle(body: File | ArrayBuffer): Promise<string | null> {
  let text = ''
  let done = false
  const rewriter = new HTMLRewriter().on('title', {
    element() {
      // Ignore any later <title> (inside SVG and so on) and take only the first
      if (text !== '') done = true
    },
    text(t) {
      if (!done) text += t.text
    },
  })
  await rewriter.transform(new Response(body)).arrayBuffer()
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 120).trim()
  return title === '' ? null : title
}

// Whether there is a past version to go back to (= two or more versions)
export async function siteHasHistory(backend: Backend, row: SiteRow): Promise<boolean> {
  const [cnt] = await backend.db.orm
    .select({ value: count() })
    .from(versions)
    .where(eq(versions.siteId, row.id))
  return (cnt?.value ?? 0) > 1
}

// The source version of a restore was pruned before the commit
export class RestoreSourceGoneError extends Error {
  constructor() {
    super('restore source version is gone')
  }
}

// One file row of a new version (site_id and version are filled in at commit)
export interface NewFile {
  path: string
  objectKey: string
  contentType: string
  size: number
  sha256: string | null
}

// The content of a new version. files is that version's whole tree, and entryPath is a Page in it
export interface NewVersion {
  entryPath: string
  files: NewFile[]
  title: string
  // The source for a restore. The source's Entry row is looked up again inside the batch, and if
  // a concurrent replace pruned it, a NOT NULL violation rolls back the whole batch (so we never
  // commit a version with zero rows pointing at a tree whose source objects are gone)
  source?: { version: number; entryPath: string }
  // The version the change was based on (PATCH /tree). Inside the batch, check that the latest is
  // still this number, and if not, a NOT NULL violation rolls back the whole batch (so a tree built
  // from a stale list is never silently stacked on top of a replace made in another tab)
  base?: number
}

// Paths pointing at the same object (such as an old asset's canonical and display names) count once
export const totalSize = (files: NewFile[]): number => {
  const sizes = new Map<string, number>()
  for (const f of files) sizes.set(f.objectKey, f.size)
  return [...sizes.values()].reduce((a, b) => a + b, 0)
}

// A committed Version. site is the updated sites row, and version the new Version's number
export interface Committed {
  site: SiteRow
  version: number
}

// Insert a new version's file rows in one statement. It binds a single JSON string and expands it
// with json_each, so it hits neither D1's bound-parameter limit (100 per statement) nor the
// query-count limit
function insertFiles(db: Db, siteId: string, files: NewFile[], version: SQL) {
  const json = JSON.stringify(files)
  return db.insert(versionFiles).select(
    db
      .select({
        siteId: sql<string>`${siteId}`.as('site_id'),
        version: sql<number>`${version}`.as('version'),
        path: sql<string>`j.value ->> 'path'`.as('path'),
        objectKey: sql<string>`j.value ->> 'objectKey'`.as('object_key'),
        contentType: sql<string>`j.value ->> 'contentType'`.as('content_type'),
        size: sql<number>`j.value ->> 'size'`.as('size'),
        sha256: sql<string | null>`j.value ->> 'sha256'`.as('sha256'),
      })
      .from(sql`json_each(${json}) as j`),
  )
}

// Add a new version to an existing Site. The order is fixed:
// 1. The caller puts the objects in R2 first (content-addressed, not yet referenced by anything)
// 2. The D1 batch = the commit point (inserting versions and version_files + updating the sites
//    pointer + deleting pruned rows, atomically)
// 3. Of the objects the pruned versions pointed at, only those no row references anymore are
//    cleaned up after the response (the Backend's defer). One object can be pointed at by several
//    versions, so this is decided after the batch
// Objects are not deleted on failure: a content-addressed key may always be pointed at by another
// version or Path (e.g. a failed re-upload of the same content would delete the current Entry).
// Orphans are tolerated
export async function commitVersion(
  backend: Backend,
  row: SiteRow,
  next: NewVersion,
): Promise<Committed | null> {
  const db = backend.db.orm
  const id = row.id
  const now = new Date().toISOString()
  const size = totalSize(next.files)

  // Old versions beyond the retention limit (one more is about to be added). The rows to delete
  // are named explicitly in the batch.
  // Concurrent writes may exceed the limit briefly, which is fine since the next write prunes them.
  // There are at most MAX_VERSIONS+α rows, so fetch them all and slice in JS (SQLite does not
  // allow OFFSET on its own)
  const all = await db
    .select({ version: versions.version })
    .from(versions)
    .where(eq(versions.siteId, id))
    .orderBy(desc(versions.version))
  const stale = all.slice(MAX_VERSIONS - 1).map((s) => s.version)
  // Objects the pruned versions point at (cleanup candidates). Past versions' rows never change,
  // so they can be fetched beforehand
  const candidates =
    stale.length === 0
      ? []
      : (
          await db
            .selectDistinct({ key: versionFiles.objectKey })
            .from(versionFiles)
            .where(and(eq(versionFiles.siteId, id), inArray(versionFiles.version, stale)))
        ).map((r) => r.key)

  // The new version's number is the maximum after the insert into versions
  const newVersion = sql`(select max(version) from versions where site_id = ${id})`

  let updated: SiteRow | undefined
  let version: number | undefined
  try {
    const results = await backend.db.atomic([
      db
        .update(sites)
        .set({
          title: next.title,
          size,
          updatedAt: now,
          entryPath: next.entryPath,
        })
        .where(eq(sites.id, id))
        .returning(),
      db
        .insert(versions)
        .values({
          siteId: id,
          version:
            next.base === undefined
              ? sql`(select coalesce(max(${versions.version}), 0) + 1 from ${versions} where ${versions.siteId} = ${id})`
              : sql`(select case when max(${versions.version}) = ${next.base} then max(${versions.version}) + 1 end from ${versions} where ${versions.siteId} = ${id})`,
          title: next.title,
          size,
          createdAt: now,
          // For a restore, look it up again from the source version's Entry row. If a concurrent
          // write pruned the source, this is NULL and a NOT NULL violation rolls back the whole
          // batch (so an empty tree is never committed)
          entryPath: next.source
            ? sql`(select path from version_files where site_id = ${id}
              and version = ${next.source.version} and path = ${next.source.entryPath})`
            : next.entryPath,
        })
        // To return the committed number regardless of concurrent writes (the CLI uses it as the
        // synced version)
        .returning({ version: versions.version }),
      insertFiles(db, id, next.files, newVersion),
      ...(stale.length > 0
        ? [
            db
              .delete(versions)
              .where(and(eq(versions.siteId, id), inArray(versions.version, stale))),
            db
              .delete(versionFiles)
              .where(and(eq(versionFiles.siteId, id), inArray(versionFiles.version, stale))),
          ]
        : []),
    ])
    updated = (results[0] as SiteRow[])[0]
    version = (results[1] as { version: number }[])[0]?.version
  } catch (e) {
    if (next.source && isNotNullViolation(e)) throw new RestoreSourceGoneError()
    if (next.base !== undefined && isNotNullViolation(e)) throw new StaleBaseError()
    throw e
  }

  if (!updated || version === undefined) {
    // The site was deleted concurrently during the batch. Clean up the rows already added (the
    // sites update comes first, so without that row the later inserts are orphans). The objects
    // are left to the prefix cleanup on the deleting side
    backend.defer(
      Promise.all([
        db.delete(versions).where(eq(versions.siteId, id)),
        db.delete(versionFiles).where(eq(versionFiles.siteId, id)),
      ]),
    )
    return null
  }
  if (candidates.length > 0) {
    backend.defer(deleteUnreferenced(backend, id, candidates))
  }
  return { site: updated, version }
}

// The base of PATCH /tree was no longer the latest by the time of the batch
export class StaleBaseError extends Error {
  constructor() {
    super('base version is not current')
  }
}

export class SiteExistsError extends Error {
  constructor() {
    super('site already exists')
  }
}

// Create a new Site together with its v1 tree. The sites row and v1 (metadata and file tree) are
// created in the same batch
export async function createSite(
  backend: Backend,
  init: { id: string; sourceName: string; folderId: string | null },
  next: NewVersion,
): Promise<SiteRow> {
  const db = backend.db.orm
  const now = new Date().toISOString()
  const size = totalSize(next.files)
  const row: SiteRow = {
    id: init.id,
    title: next.title,
    sourceName: init.sourceName,
    size,
    published: 0,
    createdAt: now,
    updatedAt: now,
    folderId: init.folderId,
    entryPath: next.entryPath,
  }
  try {
    await backend.db.atomic([
      db.insert(sites).values(row),
      db.insert(versions).values({
        siteId: init.id,
        version: 1,
        title: next.title,
        size,
        createdAt: now,
        entryPath: next.entryPath,
      }),
      insertFiles(db, init.id, next.files, sql`1`),
    ])
  } catch (e) {
    if (isUniqueViolation(e)) throw new SiteExistsError()
    throw e
  }
  return row
}

// Delete all of a site's objects: content-addressed objects, every version object and every asset.
// Every key version_files points at lives under one of these 3 prefixes, so listing finds them.
export async function deleteSiteObjects(backend: Backend, id: string): Promise<void> {
  const keys: string[] = []
  for (const prefix of [objectPrefix(id), versionPrefix(id), assetPrefix(id)]) {
    for await (const o of backend.blobs.list(prefix)) keys.push(o.key)
  }
  await backend.blobs.delete(keys)
}
