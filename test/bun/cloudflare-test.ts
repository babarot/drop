// Loaded instead of `cloudflare:test` in the Bun project (the alias in vitest.bun.config.ts).
// Provides, in the same shape on top of the Bun backend, only what the tests use (SELF.fetch, and
// env.DB / env.BUCKET to touch D1 and R2 directly). Each test file starts from an empty SQLite and
// a temp folder (just as pool-workers gives each test file its own storage)

import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { app } from '../../src/app'
import { applyMigrations, bunBackend } from '../../src/backend/bun'
import type { DropEnv } from '../../src/backend/types'
import { testAuth } from '../../src/middleware/access'

const raw = new Database(':memory:')
const migrationsDir = join(import.meta.dirname, '../../migrations')
applyMigrations(
  raw,
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') })),
)

const backend = bunBackend({
  raw,
  blobsDir: mkdtempSync(join(tmpdir(), 'drop-test-')),
  auth: testAuth,
  // The admin SPA build is not used (tests do not look at the content of the /sites HTML)
  assets: { fetch: async () => new Response('<!doctype html><title>drop</title>') },
  // Same values as the miniflare bindings in vitest.config.ts
  previewSecret: 'test-preview-secret',
})

const server = new Hono<DropEnv>()
server.use('*', async (c, next) => {
  c.set('backend', backend)
  await next()
})
server.route('/', app)

// As with workerd's SELF.fetch, add Content-Length to bodies of known length, and follow
// redirects unless redirect: 'manual'
async function fetchSelf(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const body = init?.body
  if (!headers.has('Content-Length')) {
    if (typeof body === 'string') {
      headers.set('Content-Length', String(new TextEncoder().encode(body).length))
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      headers.set('Content-Length', String(body.byteLength))
    } else if (body instanceof Blob) {
      headers.set('Content-Length', String(body.size))
    }
  }
  const url = input instanceof Request ? input.url : input.toString()
  let req = new Request(url, { ...init, headers })
  for (let hops = 0; ; hops++) {
    const res = await server.fetch(req)
    const location = res.headers.get('Location')
    if (init?.redirect === 'manual' || location === null || res.status < 300 || res.status >= 400)
      return res
    if (hops >= 20) throw new Error('too many redirects')
    req = new Request(new URL(location, req.url).toString(), { headers: init?.headers })
  }
}

export const SELF = { fetch: fetchSelf }

type Bindable = string | number | null

// The part of D1's prepare / bind / first / all / run and exec that the tests use
const DB = {
  prepare(sql: string) {
    let params: Bindable[] = []
    const stmt = {
      bind(...args: Bindable[]) {
        params = args
        return stmt
      },
      async first<T>(): Promise<T | null> {
        return (raw.query(sql).get(...params) as T | undefined) ?? null
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: raw.query(sql).all(...params) as T[] }
      },
      async run() {
        raw.query(sql).run(...params)
        return { success: true }
      },
    }
    return stmt
  },
  async exec(sql: string) {
    raw.exec(sql)
  },
}

// The part of R2's put / head / list that the tests use
const BUCKET = {
  async put(key: string, body: string | ArrayBuffer | Uint8Array) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await backend.blobs.put(key, bytes, sha256)
  },
  head: (key: string) => backend.blobs.head(key),
  async list({ prefix }: { prefix: string }) {
    const objects = []
    for await (const o of backend.blobs.list(prefix)) objects.push(o)
    return { objects, truncated: false }
  },
}

// When a test uses the Backend directly (e.g. checking base when calling commitVersion), look at
// __backend
export const env = { DB, BUCKET, __backend: backend }
