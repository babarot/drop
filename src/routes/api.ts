import { and, asc, count, desc, eq, isNull, like, max, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { MAX_FILE_SIZE, MAX_PAGE_SIZE } from '../../shared/files'
import { type Backend, type DropContext, type DropEnv, readBlob } from '../backend/types'
import {
  type FolderRow,
  folders,
  type SiteRow,
  sites,
  type VersionRow,
  versionFiles,
  versions,
} from '../db/schema'
import { isUniqueViolation } from '../lib/db-errors'
import { decodeFilePath, ENTRY_PATH, encodePath } from '../lib/delivery'
import { aliasDisplayOf, findAliasPairs, findFile, listFiles } from '../lib/files'
import {
  ChecksumMismatchError,
  listObjects,
  objectKeyOf,
  parseTree,
  putObject,
  SHA256_RE,
  SITE_ID_RE,
  sha256Hex,
} from '../lib/tree'
import { applyPatch, parsePatch } from '../lib/tree-patch'
import {
  commitVersion,
  createSite,
  deleteSiteObjects,
  extractHtmlTitle,
  type NewFile,
  RestoreSourceGoneError,
  SiteExistsError,
  StaleBaseError,
  siteHasHistory,
} from '../lib/versions'
import { createViewToken, createViewTokenUntil, SHARE_TTL_SECONDS } from '../lib/view-token'
import { apiSessionExpiry } from '../middleware/access'
import type { FolderMeta, SiteMeta, VersionFileMeta, VersionMeta } from '../types'

function toMeta(row: SiteRow, hasHistory: boolean, version?: number): SiteMeta {
  return {
    id: row.id,
    title: row.title,
    sourceName: row.sourceName,
    size: row.size,
    published: row.published === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasHistory,
    folderId: row.folderId,
    ...(version === undefined ? {} : { version }),
  }
}

// The number of the current (highest) Version. undefined if there are no rows
async function latestVersion(backend: Backend, id: string): Promise<number | undefined> {
  const [latest] = await backend.db.orm
    .select({ version: max(versions.version) })
    .from(versions)
    .where(eq(versions.siteId, id))
  return latest?.version ?? undefined
}

function toFolderMeta(row: FolderRow, siteCount: number): FolderMeta {
  return { id: row.id, name: row.name, position: row.position, siteCount }
}

// A drop made while a folder is shown goes straight into that folder (optional field).
// null if not given, undefined if the folder does not exist
async function resolveFolder(backend: Backend, raw: unknown): Promise<string | null | undefined> {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return undefined
  const db = backend.db.orm
  const [folder] = await db.select().from(folders).where(eq(folders.id, raw))
  return folder ? folder.id : undefined
}

// Shape a version_files row so it can be copied as is into a new version
const toNewFile = (f: NewFile): NewFile => ({
  path: f.path,
  objectKey: f.objectKey,
  contentType: f.contentType,
  size: f.size,
  sha256: f.sha256,
})

// Build the Entry row from the body. The object goes to its content address (an existing one is
// not overwritten)
async function putEntry(
  backend: Backend,
  siteId: string,
  path: string,
  file: File,
): Promise<NewFile> {
  const body = await file.arrayBuffer()
  const sha256 = await sha256Hex(body)
  await putObject(backend, siteId, sha256, body)
  return {
    path,
    objectKey: objectKeyOf(siteId, sha256),
    contentType: 'text/html',
    size: body.byteLength,
    sha256,
  }
}

// Turn a version's rows into the API shape. For an old asset pair, the canonical-name row gets
// aliasOf (the display-name Path)
async function toFileMetas(rows: NewFile[]): Promise<VersionFileMeta[]> {
  const pairs = await findAliasPairs(rows)
  return rows.map((f) => {
    const aliasOf = aliasDisplayOf(f, pairs)
    return {
      path: f.path,
      objectKey: f.objectKey,
      sha256: f.sha256 ?? null,
      size: f.size,
      contentType: f.contentType,
      ...(aliasOf === null ? {} : { aliasOf }),
    }
  })
}

// title is always derived from the current content (<title> tag ?? sourceName).
// Keeping this invariant in every operation that rewrites the body (upload / replace / restore)
// prevents a restore from bringing back only the body and leaving the title behind
type HtmlUpload =
  | { file: File; sourceName: string; title: string; form: FormData }
  | { error: string; status: 400 | 413 }

async function parseHtmlUpload(c: DropContext): Promise<HtmlUpload> {
  const contentLength = Number(c.req.header('Content-Length') ?? '0')
  // Reject early from the header alone, allowing for multipart overhead
  if (contentLength > MAX_PAGE_SIZE + 64 * 1024) {
    return { error: `file too large (max ${MAX_PAGE_SIZE / 1024 / 1024}MB)`, status: 413 }
  }

  const form = await c.req.formData().catch(() => null)
  if (!form) return { error: 'file field is required', status: 400 }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return { error: 'file field is required', status: 400 }
  }
  if (file.size > MAX_PAGE_SIZE) {
    return { error: `file too large (max ${MAX_PAGE_SIZE / 1024 / 1024}MB)`, status: 413 }
  }
  const isHtml = file.type.startsWith('text/html') || /\.html?$/i.test(file.name)
  if (!isHtml) {
    return { error: 'only HTML files are accepted', status: 400 }
  }

  const sourceName = file.name.replace(/\.html?$/i, '') || 'untitled'
  const title = (await extractHtmlTitle(file)) ?? sourceName

  return { file, sourceName, title, form }
}

// The root URL of the file tree (with a trailing /). For a private site, a token for the admin
// UI goes in the path. Its expiry matches the admin's Access session (as in the shell;
// src/routes/view.ts). The token is in the path for the same reason as filesBase in
// src/routes/view.ts (ADR-004)
async function filesBaseFor(c: DropContext, row: SiteRow): Promise<string> {
  if (row.published === 1) return `/p/${row.id}/f/`
  const token = await createViewTokenUntil(
    c.var.backend.previewSecret,
    row.id,
    await apiSessionExpiry(c),
  )
  return `/p/${row.id}/t/${token}/`
}

export const api = new Hono<DropEnv>()

// Create a new Site from a single HTML file. This is the one-file special case of the tree Commit
// (PUT /sites/:id/tree); the server computes the SHA-256 and puts the object at its content address
api.post('/sites', async (c) => {
  const upload = await parseHtmlUpload(c)
  if ('error' in upload) return c.json({ error: upload.error }, upload.status)

  const folderId = await resolveFolder(c.var.backend, upload.form.get('folderId'))
  if (folderId === undefined) return c.json({ error: 'folder not found' }, 400)

  const id = crypto.randomUUID()
  const entry = await putEntry(c.var.backend, id, ENTRY_PATH, upload.file)
  const row = await createSite(
    c.var.backend,
    { id, sourceName: upload.sourceName, folderId },
    { entryPath: ENTRY_PATH, files: [entry], title: upload.title },
  )
  return c.json(toMeta(row, false, 1), 201)
})

// The query before sending: returns the hashes of objects the Site does not have. Accepted even
// without a Site row (a new Site puts its objects before the Commit). Looks them up in one list
// instead of a HEAD per object
api.post('/sites/:id/objects/missing', async (c) => {
  const id = c.req.param('id')
  if (!SITE_ID_RE.test(id)) return c.json({ error: 'invalid site id' }, 400)
  const body = await c.req.json<{ sha256?: unknown }>().catch(() => null)
  const hashes = body?.sha256
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && SHA256_RE.test(h))) {
    return c.json({ error: 'sha256 must be an array of lowercase hex SHA-256' }, 400)
  }
  const have = await listObjects(c.var.backend, id)
  return c.json({ missing: [...new Set(hashes as string[])].filter((h) => !have.has(h)) })
})

// Sending an object. The content is the raw body, and R2 verifies the hash before writing
// (nothing is left if it does not match). An existing object is not overwritten. Accepted even
// without a Site row (for the same reason as missing)
api.put('/sites/:id/objects/:sha256', async (c) => {
  const id = c.req.param('id')
  const sha256 = c.req.param('sha256')
  if (!SITE_ID_RE.test(id)) return c.json({ error: 'invalid site id' }, 400)
  if (!SHA256_RE.test(sha256)) return c.json({ error: 'invalid sha256' }, 400)
  // Content-Length is required because a stream passed to R2 must have a known length.
  // Without it, 411 (treating it as 0 would let a chunked body on the Bun server slip past the
  // size check)
  const declared = c.req.header('Content-Length')
  if (declared === undefined || !/^\d+$/.test(declared)) {
    return c.json({ error: 'Content-Length required' }, 411)
  }
  const contentLength = Number(declared)
  if (contentLength > MAX_FILE_SIZE) {
    return c.json({ error: `file too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413)
  }
  const body = c.req.raw.body ?? new Uint8Array(0)
  try {
    const result = await putObject(c.var.backend, id, sha256, body)
    return c.json({ sha256 }, result === 'created' ? 201 : 200)
  } catch (e) {
    if (e instanceof ChecksumMismatchError) return c.json({ error: e.message }, 400)
    throw e
  }
})

// Commit: finalize the whole tree as one version. With create, a new Site is made.
// For an existing Site, the tree sent becomes the new version as is (files not sent are gone from
// the new version and remain in the old ones. ADR-004).
// base (optional) is the version the sender started from. As with PATCH /tree, if it is not the
// latest, 409 and nothing is committed (so a CLI push cannot overwrite changes on drop's side
// with stale content)
api.put('/sites/:id/tree', async (c) => {
  const id = c.req.param('id')
  if (!SITE_ID_RE.test(id)) return c.json({ error: 'invalid site id' }, 400)
  const body = await c.req
    .json<{ entry?: unknown; files?: unknown; create?: unknown; base?: unknown }>()
    .catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const base = body.base
  if (base !== undefined) {
    if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 1) {
      return c.json({ error: 'invalid base' }, 400)
    }
    if (body.create !== undefined) return c.json({ error: 'base is not allowed with create' }, 400)
  }

  const tree = parseTree(body.entry, body.files)
  if ('error' in tree) return c.json({ error: tree.error }, 400)

  let create: { sourceName: string; folderId: string | null } | null = null
  let row: SiteRow | undefined
  if (body.create !== undefined) {
    const raw = body.create as { sourceName?: unknown; folderId?: unknown } | null
    const sourceName = typeof raw?.sourceName === 'string' ? raw.sourceName.trim() : ''
    if (sourceName === '') return c.json({ error: 'create.sourceName is required' }, 400)
    const folderId = await resolveFolder(c.var.backend, raw?.folderId)
    if (folderId === undefined) return c.json({ error: 'folder not found' }, 400)
    create = { sourceName, folderId }
  } else {
    const db = c.var.backend.db.orm
    ;[row] = await db.select().from(sites).where(eq(sites.id, id))
    if (!row) return c.json({ error: 'not found' }, 404)
    if (base !== undefined && (await latestVersion(c.var.backend, id)) !== base) {
      return c.json({ error: 'the site was updated elsewhere' }, 409)
    }
  }

  // Every object must exist and match its declared size
  const have = await listObjects(c.var.backend, id)
  const bad = tree.files.find((f) => have.get(f.sha256) !== f.size)
  if (bad) return c.json({ error: `missing or mismatched object: ${bad.path}` }, 400)

  const files: NewFile[] = tree.files.map((f) => ({
    path: f.path,
    objectKey: objectKeyOf(id, f.sha256),
    contentType: f.contentType,
    size: f.size,
    sha256: f.sha256,
  }))
  const entryFile = files.find((f) => f.path === tree.entry) as NewFile
  const entryObj = await readBlob(c.var.backend.blobs, entryFile.objectKey)
  if (!entryObj) return c.json({ error: `missing object: ${tree.entry}` }, 400)
  const sourceName = create?.sourceName ?? row?.sourceName ?? ''
  const title = (await extractHtmlTitle(await entryObj.arrayBuffer())) ?? sourceName
  const next = { entryPath: tree.entry, files, title }

  if (create) {
    try {
      const created = await createSite(c.var.backend, { id, ...create }, next)
      return c.json(toMeta(created, false, 1), 201)
    } catch (e) {
      if (e instanceof SiteExistsError) return c.json({ error: 'site already exists' }, 409)
      throw e
    }
  }
  try {
    const committed = await commitVersion(c.var.backend, row as SiteRow, {
      ...next,
      ...(base === undefined ? {} : { base }),
    })
    if (!committed) return c.json({ error: 'not found' }, 404)
    return c.json(toMeta(committed.site, true, committed.version))
  } catch (e) {
    if (e instanceof StaleBaseError) {
      return c.json({ error: 'the site was updated elsewhere' }, 409)
    }
    throw e
  }
})

api.get('/sites', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  const folder = c.req.query('folder') ?? ''
  const sourceName = c.req.query('sourceName')
  const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 100)
  const offset = Number(c.req.query('offset') ?? '0') || 0

  const db = c.var.backend.db.orm
  const conds = []
  if (sourceName !== undefined) {
    // The dedicated path for matching a re-drop (exact match). Not combined with folder or search;
    // looks across all sites
    conds.push(eq(sites.sourceName, sourceName))
  } else {
    if (q !== '') conds.push(or(like(sites.title, `%${q}%`), like(sites.sourceName, `%${q}%`)))
    if (folder === 'unfiled') conds.push(isNull(sites.folderId))
    else if (folder !== '') conds.push(eq(sites.folderId, folder))
  }
  const where = conds.length > 0 ? and(...conds) : undefined

  const rows = await db
    .select()
    .from(sites)
    .where(where)
    .orderBy(desc(sites.createdAt))
    .limit(limit)
    .offset(offset)
  const [totalRow] = await db.select({ value: count() }).from(sites).where(where)

  const counts = await db
    .select({ siteId: versions.siteId, value: count(), latest: max(versions.version) })
    .from(versions)
    .groupBy(versions.siteId)
  const countMap = new Map(counts.map((r) => [r.siteId, r]))

  return c.json({
    sites: rows.map((row) => {
      const v = countMap.get(row.id)
      return toMeta(row, (v?.value ?? 0) > 1, v?.latest ?? undefined)
    }),
    total: totalRow?.value ?? 0,
  })
})

api.get('/sites/:id', async (c) => {
  const db = c.var.backend.db.orm
  const [row] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, c.req.param('id')))
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(toMeta(row, await siteHasHistory(c.var.backend, row)))
})

// Issue the URL of the Entry that the preview sheet (admin UI) puts in its iframe.
// Private sites are authorized with the same short-lived token as the shell (/p/:id),
// leaving the delivery side's authorization logic and CSP headers untouched
api.get('/sites/:id/preview-url', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  // base is the root of the file tree. The file tree dialog uses it to open a Page in a new tab
  // (a Page cannot be opened with the admin cookie; see serveFile in src/routes/view.ts)
  const base = await filesBaseFor(c, row)
  return c.json({ url: `${base}${encodePath(row.entryPath)}`, base })
})

// The root of the history preview's file tree (/p/:id/h/{token}/, with a trailing /). Used with a
// version and Path appended. The token has the history scope and covers every version of the
// Site. Its expiry matches the admin's Access session (as in filesBaseFor). Even for a published
// Site, past versions open only with this token (/:id/h in src/routes/view.ts)
api.get('/sites/:id/history-base', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  const token = await createViewTokenUntil(
    c.var.backend.previewSecret,
    id,
    await apiSessionExpiry(c),
    'history',
  )
  c.header('Cache-Control', 'no-store')
  return c.json({ base: `/p/${id}/h/${token}/` })
})

// Issue a short-lived share link that shows a private site for 10 minutes without publishing it.
// preview-url returns a relative URL for an iframe src, whereas this value is copied to the
// clipboard and handed to someone else, so it returns an absolute URL.
// It only stops working by expiring; there is no way to revoke an issued link individually
api.get('/sites/:id/share-link', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  // A time-limited link for a published site makes no sense (just use the public URL).
  // The menu does not offer it either, so reaching here means the caller made a mistake
  if (row.published === 1) return c.json({ error: 'already published' }, 400)

  const token = await createViewToken(c.var.backend.previewSecret, id, SHARE_TTL_SECONDS)
  const url = `${new URL(c.req.url).origin}/p/${id}?token=${token}`
  c.header('Cache-Control', 'no-store')
  return c.json({ url, expiresIn: SHARE_TTL_SECONDS })
})

// Download for getting the original back. It sits behind Access rather than on the public raw
// route so that private sites can be downloaded too.
// This surface returns HTML on the same origin, so it must never render (attachment + sandbox +
// nosniff). The client sets the file name (a.download)
api.get('/sites/:id/download', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  const entry = await findFile(c.var.backend, id, row.entryPath)
  const obj = entry && (await readBlob(c.var.backend.blobs, entry.objectKey))
  if (!obj) return c.json({ error: 'not found' }, 404)

  c.header('Content-Disposition', 'attachment')
  c.header('Content-Security-Policy', 'sandbox')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Cache-Control', 'no-store')
  return c.body(obj.body)
})

// The list of versions (entry point of the history UI)
api.get('/sites/:id/versions', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  const rows = await db
    .select()
    .from(versions)
    .where(eq(versions.siteId, id))
    .orderBy(desc(versions.version))
  const latest = rows[0]?.version ?? 0
  const counts = await db
    .select({ version: versionFiles.version, value: count() })
    .from(versionFiles)
    .where(eq(versionFiles.siteId, id))
    .groupBy(versionFiles.version)
  const countOf = new Map(counts.map((r) => [r.version, r.value]))
  const list: VersionMeta[] = rows.map((v) => ({
    version: v.version,
    title: v.title,
    size: v.size,
    createdAt: v.createdAt,
    current: v.version === latest,
    entryPath: v.entryPath,
    fileCount: countOf.get(v.version) ?? 0,
  }))
  return c.json({ versions: list })
})

// The shape of a version number (an integer of 1 or more). Anything else is a 400
const parseVersion = (raw: string): number | null =>
  /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null

// A version's file list and Entry (for the per-file diff in history and the entry point of the 4c
// file tree). An old asset pair is shown with aliasOf (the display-name Path) on the
// canonical-name row
api.get('/sites/:id/versions/:version/files', async (c) => {
  const id = c.req.param('id')
  const vn = parseVersion(c.req.param('version'))
  if (vn === null) return c.json({ error: 'invalid version' }, 400)
  const db = c.var.backend.db.orm
  const [v] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.siteId, id), eq(versions.version, vn)))
  if (!v) return c.json({ error: 'not found' }, 404)

  return c.json({
    entry: v.entryPath,
    files: await toFileMetas(await listFiles(c.var.backend, id, vn)),
  })
})

// The current version's tree (entry point of the file tree dialog). version is the base for
// PATCH /tree
api.get('/sites/:id/files', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [v] = await db
    .select()
    .from(versions)
    .where(eq(versions.siteId, id))
    .orderBy(desc(versions.version))
    .limit(1)
  if (!v) return c.json({ error: 'not found' }, 404)
  return c.json({
    version: v.version,
    entry: v.entryPath,
    files: await toFileMetas(await listFiles(c.var.backend, id, v.version)),
  })
})

// Changes to the current tree (adding, replacing and deleting files, and changing the Entry).
// See src/lib/tree-patch.ts. The changes are applied to the base version's tree and committed
// after checking inside the batch that base is still the latest. If not, 409 (the dialog reloads
// the list)
api.patch('/sites/:id/tree', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  const patch = parsePatch(await c.req.json().catch(() => null))
  if ('error' in patch) return c.json({ error: patch.error }, 400)

  const [base] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.siteId, id), eq(versions.version, patch.base)))
  if (!base || (await latestVersion(c.var.backend, id)) !== patch.base) {
    return c.json({ error: 'the site was updated elsewhere' }, 409)
  }

  const baseFiles = (await listFiles(c.var.backend, id, base.version)).map(toNewFile)
  const applied = applyPatch(id, baseFiles, await findAliasPairs(baseFiles), base.entryPath, patch)
  if ('error' in applied) return c.json({ error: applied.error }, 400)

  // The objects being added must exist and match their declared size (as in PUT /tree)
  if (patch.put.length > 0) {
    const have = await listObjects(c.var.backend, id)
    const bad = patch.put.find((f) => have.get(f.sha256) !== f.size)
    if (bad) return c.json({ error: `missing or mismatched object: ${bad.path}` }, 400)
  }

  // title always comes from the Entry. Reread it only when the Entry or its content changed
  const entryFile = applied.files.find((f) => f.path === applied.entry) as NewFile
  const baseEntry = baseFiles.find((f) => f.path === base.entryPath)
  let title = base.title
  if (entryFile.objectKey !== baseEntry?.objectKey) {
    const obj = await readBlob(c.var.backend.blobs, entryFile.objectKey)
    if (!obj) return c.json({ error: `missing object: ${applied.entry}` }, 400)
    title = (await extractHtmlTitle(await obj.arrayBuffer())) ?? row.sourceName
  }

  try {
    const committed = await commitVersion(c.var.backend, row, {
      entryPath: applied.entry,
      files: applied.files,
      title,
      base: patch.base,
    })
    if (!committed) return c.json({ error: 'not found' }, 404)
    return c.json(toMeta(committed.site, true, committed.version))
  } catch (e) {
    if (e instanceof StaleBaseError) {
      return c.json({ error: 'the site was updated elsewhere' }, 409)
    }
    throw e
  }
})

// The original of one file in a version (for diff and download). It may be binary, so the
// Content-Type is always octet-stream and it never renders (attachment + sandbox + nosniff). The
// client decides from the kind of Path whether to read it as text. A Path may contain # or ?, so
// decode it segment by segment from the URL path rather than c.req.param (same rule as
// decodeFilePath in delivery)
api.get('/sites/:id/versions/:version/files/*', async (c) => {
  const id = c.req.param('id')
  const vn = parseVersion(c.req.param('version'))
  if (vn === null) return c.json({ error: 'invalid version' }, 400)
  // ['', 'api', 'sites', id, 'versions', version, 'files', ...path]
  const path = decodeFilePath(new URL(c.req.url).pathname.split('/').slice(7).join('/'))
  if (path === null) return c.json({ error: 'not found' }, 404)
  const file = await findFile(c.var.backend, id, path, vn)
  const obj = file && (await readBlob(c.var.backend.blobs, file.objectKey))
  if (!obj) return c.json({ error: 'not found' }, 404)

  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', 'attachment')
  c.header('Content-Security-Policy', 'sandbox')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cache-Control', 'no-store')
  return c.body(obj.body)
})

// Replace: add a new version and move the latest pointer to it.
// id, sourceName and published are kept, and title is derived again from the new body
api.put('/sites/:id/file', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  const upload = await parseHtmlUpload(c)
  if ('error' in upload) return c.json({ error: upload.error }, upload.status)

  // sourceName identifies the site, so the name of the file used for the replace does not
  // overwrite it. title is derived again from the new body (falls back to sourceName without
  // <title>)
  const title = (await extractHtmlTitle(upload.file)) ?? row.sourceName
  // Replace only the Entry and carry the other files over from the current tree (phase 3,
  // decision 1)
  const entry = await putEntry(c.var.backend, id, row.entryPath, upload.file)
  const current = await listFiles(c.var.backend, id)
  const files = [...current.filter((f) => f.path !== row.entryPath).map(toNewFile), entry]
  const committed = await commitVersion(c.var.backend, row, {
    entryPath: row.entryPath,
    files,
    title,
  })
  if (!committed) return c.json({ error: 'not found' }, 404)
  return c.json(
    toMeta(committed.site, await siteHasHistory(c.var.backend, committed.site), committed.version),
  )
})

// Copy the content of the given version (by default the one before the latest) and add it as a
// new version (like git revert). History only moves forward, so a restore can itself be undone
// by another restore
api.post('/sites/:id/restore', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)

  // Without a body, "the one before the latest" (the toast's undo)
  const body = await c.req.json<{ version?: unknown }>().catch(() => null)
  const requested = body?.version
  if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested))) {
    return c.json({ error: 'invalid version' }, 400)
  }

  const [latest, previous] = await db
    .select()
    .from(versions)
    .where(eq(versions.siteId, id))
    .orderBy(desc(versions.version))
    .limit(2)
  if (!latest) return c.json({ error: 'nothing to restore' }, 409)

  let target: VersionRow | undefined
  if (requested === undefined) {
    target = previous
  } else if (requested === latest.version) {
    return c.json({ error: 'already current' }, 409)
  } else {
    ;[target] = await db
      .select()
      .from(versions)
      .where(and(eq(versions.siteId, id), eq(versions.version, requested)))
  }
  if (!target) return c.json({ error: 'nothing to restore' }, 409)

  // Nothing is copied in R2; the past version's file tree is pointed to again as is. The Entry is
  // also the source version's
  const files = (await listFiles(c.var.backend, id, target.version)).map(toNewFile)
  const entry = files.find((f) => f.path === target.entryPath)
  if (!entry || !(await c.var.backend.blobs.head(entry.objectKey))) {
    return c.json({ error: 'version content missing' }, 409)
  }

  // Bring back the title together with the body (invariant: title always comes from the content.
  // A version's title was derived from its body, so it can be used as is)
  let committed: Awaited<ReturnType<typeof commitVersion>>
  try {
    committed = await commitVersion(c.var.backend, row, {
      entryPath: target.entryPath,
      files,
      title: target.title,
      source: { version: target.version, entryPath: target.entryPath },
    })
  } catch (e) {
    if (e instanceof RestoreSourceGoneError) return c.json({ error: 'nothing to restore' }, 409)
    throw e
  }
  if (!committed) return c.json({ error: 'not found' }, 404)
  return c.json(toMeta(committed.site, true, committed.version))
})

// Manual title updates are not accepted (title always comes from the content. If manual renaming
// is ever needed, design it as a separate field that overrides the derived title)
api.patch('/sites/:id', async (c) => {
  const body = await c.req.json<{ published?: unknown; folderId?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const db = c.var.backend.db.orm
  const patch: Partial<typeof sites.$inferInsert> = {}
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') {
      return c.json({ error: 'invalid published' }, 400)
    }
    patch.published = body.published ? 1 : 0
    // Only a change to published advances updatedAt. Moving to a folder is organizing, not a
    // content update, so it does not (a card's date changing would be confusing)
    patch.updatedAt = new Date().toISOString()
  }
  if (body.folderId !== undefined) {
    if (body.folderId !== null && typeof body.folderId !== 'string') {
      return c.json({ error: 'invalid folderId' }, 400)
    }
    if (typeof body.folderId === 'string') {
      const [folder] = await db.select().from(folders).where(eq(folders.id, body.folderId))
      if (!folder) return c.json({ error: 'folder not found' }, 400)
    }
    patch.folderId = body.folderId
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'nothing to update' }, 400)
  }
  const [row] = await db
    .update(sites)
    .set(patch)
    .where(eq(sites.id, c.req.param('id')))
    .returning()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(toMeta(row, await siteHasHistory(c.var.backend, row)))
})

// The list of folders (entry point of the folder bar). Ascending by position, with each folder's
// count and the unfiled count
api.get('/folders', async (c) => {
  const db = c.var.backend.db.orm
  const rows = await db
    .select()
    .from(folders)
    .orderBy(asc(folders.position), asc(folders.createdAt))
  const counts = await db
    .select({ folderId: sites.folderId, value: count() })
    .from(sites)
    .groupBy(sites.folderId)
  const countMap = new Map(counts.map((r) => [r.folderId, r.value]))
  return c.json({
    folders: rows.map((row) => toFolderMeta(row, countMap.get(row.id) ?? 0)),
    unfiledCount: countMap.get(null) ?? 0,
  })
})

api.post('/folders', async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name === '') return c.json({ error: 'name is required' }, 400)

  const db = c.var.backend.db.orm
  // Append at the end (max+1). Reordering is done with position in PATCH
  const [maxRow] = await db.select({ value: max(folders.position) }).from(folders)
  const now = new Date().toISOString()
  const row: FolderRow = {
    id: crypto.randomUUID(),
    name,
    position: (maxRow?.value ?? -1) + 1,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await db.insert(folders).values(row)
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'folder name already exists' }, 409)
    throw e
  }
  return c.json(toFolderMeta(row, 0), 201)
})

api.patch('/folders/:id', async (c) => {
  const body = await c.req.json<{ name?: unknown; position?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const patch: Partial<typeof folders.$inferInsert> = {}
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') return c.json({ error: 'invalid name' }, 400)
    patch.name = name
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isInteger(body.position)) {
      return c.json({ error: 'invalid position' }, 400)
    }
    patch.position = body.position
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'nothing to update' }, 400)
  }
  patch.updatedAt = new Date().toISOString()

  const db = c.var.backend.db.orm
  let row: FolderRow | undefined
  try {
    ;[row] = await db
      .update(folders)
      .set(patch)
      .where(eq(folders.id, c.req.param('id')))
      .returning()
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'folder name already exists' }, 409)
    throw e
  }
  if (!row) return c.json({ error: 'not found' }, 404)

  const [countRow] = await db
    .select({ value: count() })
    .from(sites)
    .where(eq(sites.folderId, row.id))
  return c.json(toFolderMeta(row, countRow?.value ?? 0))
})

// Delete a folder. Its sites go back to unfiled (the sites are not deleted). Atomic in one batch
api.delete('/folders/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  const results = await c.var.backend.db.atomic([
    db.delete(folders).where(eq(folders.id, id)).returning(),
    db.update(sites).set({ folderId: null }).where(eq(sites.folderId, id)),
  ])
  const [row] = results[0] as FolderRow[]
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.body(null, 204)
})

api.delete('/sites/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.var.backend.db.orm
  // Delete from D1 first (if that fails, R2 is left alone). R2 is best effort
  const results = await c.var.backend.db.atomic([
    db.delete(sites).where(eq(sites.id, id)).returning(),
    db.delete(versions).where(eq(versions.siteId, id)),
    db.delete(versionFiles).where(eq(versionFiles.siteId, id)),
  ])
  const [row] = results[0] as SiteRow[]
  if (!row) return c.json({ error: 'not found' }, 404)
  c.var.backend.defer(deleteSiteObjects(c.var.backend, id))
  return c.body(null, 204)
})
