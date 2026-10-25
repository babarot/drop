// The Workers backend: D1 + R2 + Cloudflare Access (production, wrangler dev and tests)

import type { BatchItem } from 'drizzle-orm/batch'
import { drizzle } from 'drizzle-orm/d1'
import { accessAuth, developmentAuth, lockedAuth, testAuth } from '../middleware/access'
import { tokenAuth } from './token-auth'
import {
  type AuthProvider,
  type Backend,
  type BlobBody,
  type BlobMeta,
  type BlobStore,
  ChecksumMismatchError,
  type Db,
} from './types'

// The Worker's bindings and vars (wrangler.toml)
export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  ASSETS: Fetcher
  // Admin authentication: "access" (Cloudflare Access) or "token" (drop's own token). With anything
  // else, nobody gets in
  AUTH?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  // Secrets for AUTH = "token" (wrangler secret)
  DROP_ADMIN_TOKEN?: string
  DROP_SESSION_SECRET?: string
  PREVIEW_SECRET: string
  ENVIRONMENT?: string
}

// Accept a structural type with only the needed waitUntil, to absorb the type difference between
// Hono's c.executionCtx and the Workers ExecutionContext
interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void
}

function r2Blobs(bucket: R2Bucket): BlobStore {
  const meta = (o: R2Object): BlobMeta => ({ size: o.size, etag: o.httpEtag })
  return {
    async put(key, body, sha256) {
      try {
        // With the onlyIf wildcard, an existing key is not overwritten and null comes back
        const put = await bucket.put(key, body, { sha256, onlyIf: { etagDoesNotMatch: '*' } })
        return put === null ? 'exists' : 'created'
      } catch (e) {
        if (e instanceof Error && /checksum|sha-?256/i.test(e.message))
          throw new ChecksumMismatchError()
        throw e
      }
    },
    async get(key, opts) {
      const obj = await bucket.get(key, { onlyIf: opts?.conditional, range: opts?.range })
      if (!obj) return null
      // When onlyIf (If-None-Match) matches, an R2Object without a body comes back
      if (!('body' in obj) || obj.body === null) return meta(obj)
      const b = obj as R2ObjectBody
      return {
        ...meta(b),
        body: b.body,
        arrayBuffer: () => b.arrayBuffer(),
        text: () => b.text(),
      } satisfies BlobBody
    },
    async head(key) {
      const obj = await bucket.head(key)
      return obj ? meta(obj) : null
    },
    async *list(prefix) {
      // 1000 per call, so loop until the cursor runs out
      let cursor: string | undefined
      do {
        const res = await bucket.list({ prefix, cursor })
        for (const o of res.objects) yield { key: o.key, size: o.size }
        cursor = res.truncated ? res.cursor : undefined
      } while (cursor)
    },
    async delete(keys) {
      // delete takes up to 1000 keys per call
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
    },
  }
}

export function authFor(env: Env): AuthProvider {
  if (env.ENVIRONMENT === 'development') return developmentAuth
  if (env.ENVIRONMENT === 'test') return testAuth
  if (env.AUTH === 'access') {
    return accessAuth({
      ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN ?? '',
      ACCESS_AUD: env.ACCESS_AUD ?? '',
    })
  }
  if (env.AUTH === 'token') {
    return tokenAuth({
      adminToken: env.DROP_ADMIN_TOKEN ?? '',
      sessionSecret: env.DROP_SESSION_SECRET ?? '',
    })
  }
  // A configuration error. Fail safe: nobody gets in as the admin
  return lockedAuth
}

export function workersBackend(env: Env, ctx: WaitUntilCtx): Backend {
  const orm = drizzle(env.DB)
  return {
    db: {
      orm: orm as unknown as Db,
      atomic: (queries) => orm.batch(queries as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]),
    },
    blobs: r2Blobs(env.BUCKET),
    auth: authFor(env),
    assets: env.ASSETS,
    previewSecret: env.PREVIEW_SECRET,
    defer: (promise) => ctx.waitUntil(promise),
  }
}
