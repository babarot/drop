// Backend: the bundle of parts whose implementation differs per runtime (docs/glossary.md). Shared
// code (routes, Commit, delivery) never touches D1, R2 or Access directly; it goes through this,
// carried on the Hono context (c.var.backend).
// There is a Workers backend (src/backend/workers.ts) and a Bun backend

import type { BatchItem } from 'drizzle-orm/batch'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'

// The Drizzle DB used by shared code. The D1 driver is async and the bun:sqlite driver is sync,
// but both let a built query be awaited, so the type follows the async one
export type Db = BaseSQLiteDatabase<'async', unknown>

export interface DropDatabase {
  orm: Db
  // All succeed or all are rolled back (D1's batch). Results come in query order; a query with
  // returning yields an array of rows. On a rollback such as a NOT NULL violation, that error is
  // thrown (commitVersion's base and restore checks rely on this)
  atomic(queries: BatchItem<'sqlite'>[]): Promise<unknown[]>
}

export interface BlobMeta {
  size: number
  // The value that goes into the HTTP ETag header as is (quotes included)
  etag: string
}

export interface BlobBody extends BlobMeta {
  body: ReadableStream
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface BlobRange {
  offset: number
  length: number
}

// The written content did not match the declared SHA-256 (nothing is left behind)
export class ChecksumMismatchError extends Error {
  constructor() {
    super('body does not match sha256')
  }
}

// Where Objects are stored (R2, or a folder on disk). Keys live under the prefixes in src/lib/r2.ts
export interface BlobStore {
  // Verify the content and write only when the key does not exist. ChecksumMismatchError if it
  // does not match
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array,
    sha256: string,
  ): Promise<'created' | 'exists'>
  // conditional is the request's headers (If-None-Match and the like). When the condition matches
  // and no body is returned, a BlobMeta without body comes back (the caller turns it into 304).
  // null if the key does not exist
  get(
    key: string,
    opts?: { range?: BlobRange; conditional?: Headers },
  ): Promise<BlobBody | BlobMeta | null>
  head(key: string): Promise<BlobMeta | null>
  list(prefix: string): AsyncIterable<{ key: string; size: number }>
  // The implementation takes care of any limit on the number of keys
  delete(keys: string[]): Promise<void>
}

export type DropContext = Context<DropEnv>

// Admin authentication (Cloudflare Access and the like)
export interface AuthProvider {
  // The gatekeeper for /api/*. null to let the request through, or the response to refuse it with
  guardApi(c: DropContext): Promise<Response | null>
  // The session expiry (Unix seconds) of a request that passed /api/*. Used as the expiry of the
  // admin's View tokens (ADR-002)
  apiSessionExpiry(c: DropContext): Promise<number>
  // On the public side (/p/:id), the admin's session expiry (Unix seconds). null if not the admin
  adminSessionExpiry(c: DropContext): Promise<number | null>
  // Browser login (GET /login, POST /login, POST /logout). Only authentication with drop's own
  // token has these. For one without them (Access), GET /login redirects to /sites (so the user
  // logs in again through Access at the edge)
  loginPage?(c: DropContext): Promise<Response>
  loginSubmit?(c: DropContext): Promise<Response>
  logout?(c: DropContext): Promise<Response>
}

export interface Backend {
  db: DropDatabase
  blobs: BlobStore
  auth: AuthProvider
  // The built files of the admin SPA
  assets: { fetch(req: Request): Promise<Response> }
  // The secret that signs View tokens (ADR-002)
  previewSecret: string
  // Cleanup that may continue after the response (waitUntil on Workers)
  defer(promise: Promise<unknown>): void
}

export type DropEnv = { Variables: { backend: Backend } }

// Read without conditions (a body always comes back). null if the key does not exist
export async function readBlob(blobs: BlobStore, key: string): Promise<BlobBody | null> {
  const obj = await blobs.get(key)
  return obj && 'body' in obj ? obj : null
}
