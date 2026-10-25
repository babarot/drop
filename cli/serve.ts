// drop serve: run drop without Cloudflare (Bun backend). Binds only to 127.0.0.1 and serves the
// admin UI, delivery and admin API just like drop. Data lives in dataDir (SQLite and the Object
// store)

import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { app } from '../src/app'
import { applyMigrations, bunBackend, type Migration } from '../src/backend/bun'
import { isLocalHost, type TokenAuth, tokenAuth } from '../src/backend/token-auth'
import type { DropEnv } from '../src/backend/types'
import { embedded } from './embedded'

// Location in the repository read when nothing is embedded (no single binary; run as bun
// cli/main.ts)
const repo = fileURLToPath(new URL('..', import.meta.url))

function migrations(): Migration[] {
  const fromBinary = embedded()?.migrations
  if (fromBinary) return fromBinary
  const dir = join(repo, 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

// The admin SPA build (/sites/...). As with Workers' ASSETS, 404 if the file does not exist
function assets(): { fetch(req: Request): Promise<Response> } {
  const files = embedded()?.assets
  const root = join(repo, 'app', 'dist')
  return {
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname)
      const source = files
        ? files.get(path)
        : join(root, ...path.split('/').filter((s) => s !== '..'))
      if (!source || !existsSync(source)) return new Response('not found', { status: 404 })
      return new Response(Bun.file(source), {
        headers: { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' },
      })
    },
  }
}

// A secret in the data directory. Created if missing, in a file only the user can read
function secret(dataDir: string, name: string): string {
  const path = join(dataDir, name)
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const value = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
  return value
}

export const cliTokenPath = (dataDir: string) => join(dataDir, 'cli-token')

export interface LocalServer {
  url: string
  auth: TokenAuth
  stop(): void
}

export function startServer(opts: { dataDir: string; port: number }): LocalServer {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 })
  const raw = new Database(join(opts.dataDir, 'drop.db'))
  raw.exec('PRAGMA journal_mode = WAL')
  applyMigrations(raw, migrations())
  // The CLI token is the admin token. A browser signs in with the one-time URL printed to the
  // terminal, or by entering this token at /login
  const auth = tokenAuth(
    {
      adminToken: secret(opts.dataDir, 'cli-token'),
      sessionSecret: secret(opts.dataDir, 'session-secret'),
    },
    { loginCodes: true },
  )
  const backend = bunBackend({
    raw,
    blobsDir: join(opts.dataDir, 'blobs'),
    auth,
    assets: assets(),
    previewSecret: secret(opts.dataDir, 'preview-secret'),
  })

  const server = new Hono<DropEnv>()
  server.use('*', async (c, next) => {
    // DNS rebinding defense (an attacker's domain pointed at 127.0.0.1 must not be treated as
    // same-origin)
    if (!isLocalHost(c.req.header('Host'))) return c.text('forbidden', 403)
    c.set('backend', backend)
    await next()
  })
  // Serve admin SPA files before the shared app, like Workers' asset-first
  server.get('/sites/assets/*', (c) => backend.assets.fetch(c.req.raw))
  server.route('/', app)

  const bun = Bun.serve({ hostname: '127.0.0.1', port: opts.port, fetch: server.fetch })
  return {
    url: `http://127.0.0.1:${bun.port}`,
    auth,
    stop: () => bun.stop(true),
  }
}
