// The Bun backend: SQLite (bun:sqlite) + a folder on disk. For running drop without Cloudflare
// (fully local. The tests also run the same suite as the Workers backend against it, to confirm
// the boundary is right)

import type { Database } from 'bun:sqlite'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type {
  AuthProvider,
  Backend,
  BlobBody,
  BlobMeta,
  BlobStore,
  Db,
  DropDatabase,
} from './types'
import { ChecksumMismatchError } from './types'

export interface Migration {
  name: string
  sql: string
}

// Apply the same migrations/*.sql as D1, in name order. Applied ones are recorded in
// _drop_migrations, and from the second run only the missing ones are applied (the same role as
// D1's d1_migrations)
export function applyMigrations(raw: Database, migrations: Migration[]): void {
  raw.exec('CREATE TABLE IF NOT EXISTS _drop_migrations (name TEXT PRIMARY KEY, applied_at TEXT)')
  const done = new Set(
    raw
      .query<{ name: string }, []>('SELECT name FROM _drop_migrations')
      .all()
      .map((r) => r.name),
  )
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue
    raw.transaction(() => {
      raw.exec(m.sql)
      raw
        .query('INSERT INTO _drop_migrations (name, applied_at) VALUES (?, ?)')
        .run(m.name, new Date().toISOString())
    })()
  }
}

function sqliteDatabase(raw: Database): DropDatabase {
  const orm = drizzle(raw)
  return {
    // The bun:sqlite driver is sync, but built queries can be awaited (Db in src/backend/types.ts)
    orm: orm as unknown as Db,
    // Like D1's batch, all succeed or all are rolled back. The queries run in order inside a
    // transaction, and on an exception it rolls back and rethrows. A query with returning yields
    // an array of rows
    async atomic(queries) {
      return orm.transaction(() =>
        queries.map((q) => {
          const query = q as unknown as {
            config?: { returning?: unknown }
            all(): unknown
            run(): unknown
          }
          return query.config?.returning ? query.all() : query.run()
        }),
      )
    },
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function toBytes(
  body: ReadableStream | ArrayBuffer | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) {
    return body.buffer instanceof ArrayBuffer
      ? (body as Uint8Array<ArrayBuffer>)
      : new Uint8Array(body)
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  return new Uint8Array(await new Response(body).arrayBuffer())
}

// Whether etag matches an If-None-Match value (comma-separated, with W/, or *)
function matchesNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag)
}

// Keys map directly onto the folder hierarchy (the / in a key is the separator). Keys live under
// the prefixes in src/lib/r2.ts; the Site id is a validated UUID and the rest is a sha256 or an
// old key, so they never become .. or an absolute path
export function fileBlobs(root: string): BlobStore {
  const pathOf = (key: string) => join(root, ...key.split('/'))
  const metaOf = async (key: string): Promise<BlobMeta | null> => {
    const s = await stat(pathOf(key)).catch(() => null)
    if (!s?.isFile()) return null
    // Content never changes after it is written (no overwrites), so size and time are stable enough
    return { size: s.size, etag: `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"` }
  }
  return {
    async put(key, body, sha256) {
      const bytes = await toBytes(body)
      if ((await sha256Hex(bytes)) !== sha256) throw new ChecksumMismatchError()
      if (await metaOf(key)) return 'exists'
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true })
      // Write to a temporary file and then rename it (so a crash midway never leaves a broken
      // object under the key)
      const tmp = `${path}.${crypto.randomUUID()}.tmp`
      await Bun.write(tmp, bytes)
      await rename(tmp, path)
      return 'created'
    },
    async get(key, opts) {
      const meta = await metaOf(key)
      if (!meta) return null
      if (matchesNoneMatch(opts?.conditional?.get('If-None-Match') ?? null, meta.etag)) return meta
      const file = Bun.file(pathOf(key))
      const range = opts?.range
      const blob = range ? file.slice(range.offset, range.offset + range.length) : file
      return {
        ...meta,
        body: blob.stream(),
        arrayBuffer: () => blob.arrayBuffer(),
        text: () => blob.text(),
      } satisfies BlobBody
    },
    head: metaOf,
    async *list(prefix) {
      // Walk the folder up to the last / of prefix, and return only keys that start with prefix
      const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
      const base = pathOf(dir)
      const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isFile() || e.name.endsWith('.tmp')) continue
        const full = join(e.parentPath, e.name)
        const key = relative(root, full).split(sep).join('/')
        if (!key.startsWith(prefix)) continue
        const s = await stat(full)
        yield { key, size: s.size }
      }
    },
    async delete(keys) {
      for (const key of keys) await rm(pathOf(key), { force: true })
    },
  }
}

export interface BunBackendOptions {
  raw: Database
  blobsDir: string
  auth: AuthProvider
  assets: Backend['assets']
  previewSecret: string
}

export function bunBackend(opts: BunBackendOptions): Backend {
  return {
    db: sqliteDatabase(opts.raw),
    blobs: fileBlobs(opts.blobsDir),
    auth: opts.auth,
    assets: opts.assets,
    previewSecret: opts.previewSecret,
    // The process keeps running after the response, so let it run without waiting. Failures are
    // only logged
    defer(promise) {
      promise.catch((e) => console.error('deferred task failed', e))
    },
  }
}
