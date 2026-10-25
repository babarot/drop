// Shared steps for preparing Sites and files in tests. Adding and deleting files goes through PATCH
// /api/sites/:id/tree, as in the admin UI (the legacy asset API was removed in phase 5). Legacy
// asset pairs (canonical name and display name) can no longer be made via the API, so rows go
// straight into D1

import { env, SELF } from 'cloudflare:test'
import { expect } from 'vitest'
import { contentTypeOf } from '../shared/files'
import type { Backend } from '../src/backend/types'
import { type Env, workersBackend } from '../src/backend/workers'
import type { SiteFilesResponse, SiteMeta } from '../src/types'
import { legacyCanonical } from './legacy-name'

export const CSRF = { 'X-Drop-Request': '1' }
export const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }

export async function upload(html = '<h1>hello</h1>', name = 'test.html'): Promise<SiteMeta> {
  const form = new FormData()
  form.append('file', new File([html], name, { type: 'text/html' }))
  const res = await SELF.fetch('https://drop.test/api/sites', {
    method: 'POST',
    headers: CSRF,
    body: form,
  })
  expect(res.status).toBe(201)
  return res.json()
}

export async function publish(id: string): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
}

export async function sha256Hex(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function currentTree(id: string): Promise<SiteFilesResponse> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/files`, { headers: CSRF })
  expect(res.status).toBe(200)
  return res.json()
}

// Apply a change to the current tree (creates a new Version). put contents are stored as Objects
// first
export async function patchTree(
  id: string,
  change: { put?: Record<string, string | Uint8Array>; delete?: string[]; entry?: string },
): Promise<Response> {
  const { version } = await currentTree(id)
  const put = []
  for (const [path, body] of Object.entries(change.put ?? {})) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    const sha256 = await sha256Hex(bytes)
    const res = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/${sha256}`, {
      method: 'PUT',
      headers: CSRF,
      body: bytes,
    })
    expect([200, 201]).toContain(res.status)
    put.push({ path, sha256, size: bytes.length })
  }
  return SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ base: version, put, delete: change.delete, entry: change.entry }),
  })
}

// Add a file (replaces it at the same Path). Creates a new Version
export async function addFile(id: string, path: string, body: string | Uint8Array): Promise<void> {
  const res = await patchTree(id, { put: { [path]: body } })
  expect(res.status).toBe(200)
}

// Insert a legacy asset pair directly as rows of the current Version (the Object goes under the
// legacy key assets/, and two rows, canonical name and display name, point to it). Returns the
// canonical name
export async function addLegacyPair(id: string, display: string, body: string): Promise<string> {
  const name = display.normalize('NFC')
  const canonical = await legacyCanonical(name)
  const key = `assets/${id}/${crypto.randomUUID()}`
  await env.BUCKET.put(key, body)
  for (const path of [canonical, name]) {
    await env.DB.prepare(
      `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
       SELECT site_id, max(version), ?, ?, ?, ? FROM versions WHERE site_id = ?`,
    )
      .bind(path, key, contentTypeOf(path), new TextEncoder().encode(body).length, id)
      .run()
  }
  return canonical
}

// Get a private site's preview token via preview-url
export async function previewToken(id: string): Promise<string> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/preview-url`, { headers: CSRF })
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  const token = url.match(/\/t\/([A-Za-z0-9_.-]+)\//)?.[1]
  expect(token).toBeDefined()
  return token as string
}

// When a test uses the Backend directly (e.g. calling commitVersion). In the Bun project,
// test/bun/cloudflare-test.ts puts the Bun backend on env
export function testBackend(): Backend {
  if ('__backend' in env) return (env as { __backend: Backend }).__backend
  // PREVIEW_SECRET is a secret, so it is in the generated type (Cloudflare.Env) only where
  // .dev.vars exists. The value comes from the bindings in vitest.config.ts
  return workersBackend(env as unknown as Env, { waitUntil() {} })
}
