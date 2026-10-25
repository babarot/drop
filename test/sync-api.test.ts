import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { SiteMeta } from '../src/types'
import { CSRF, JSON_HEADERS, patchTree, sha256Hex } from './helpers'

// Server behavior the CLI's push relies on: base in PUT /tree, and the committed Version's number

async function putObjects(id: string, files: Record<string, string>) {
  const listed = []
  for (const [path, body] of Object.entries(files)) {
    const sha256 = await sha256Hex(body)
    const res = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/${sha256}`, {
      method: 'PUT',
      headers: CSRF,
      body,
    })
    expect([200, 201]).toContain(res.status)
    listed.push({ path, sha256, size: new TextEncoder().encode(body).length })
  }
  return listed
}

async function putTree(id: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

async function versionCount(id: string): Promise<number> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/versions`, { headers: CSRF })
  return ((await res.json()) as { versions: unknown[] }).versions.length
}

async function createSite(files: Record<string, string>): Promise<string> {
  const id = crypto.randomUUID()
  const res = await putTree(id, {
    entry: 'index.html',
    files: await putObjects(id, files),
    create: { sourceName: `sync-${id.slice(0, 8)}` },
  })
  expect(res.status).toBe(201)
  expect(((await res.json()) as SiteMeta).version).toBe(1)
  return id
}

describe('PUT /api/sites/:id/tree with base', () => {
  it('commits when base is the latest and answers the new version number', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    const res = await putTree(id, {
      base: 1,
      entry: 'index.html',
      files: await putObjects(id, { 'index.html': 'v2', 'a.css': 'x' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).version).toBe(2)
  })

  it('answers 409 and commits nothing when base is not the latest', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    const files = await putObjects(id, { 'index.html': 'v2' })
    expect((await putTree(id, { base: 1, entry: 'index.html', files })).status).toBe(200)
    // Send with base: 1 again (a push from a stale local copy after another machine committed v2
    // first)
    const stale = await putTree(id, {
      base: 1,
      entry: 'index.html',
      files: await putObjects(id, { 'index.html': 'stale' }),
    })
    expect(stale.status).toBe(409)
    expect(await versionCount(id)).toBe(2)
  })

  it('rejects a malformed base and base together with create', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    const files = await putObjects(id, { 'index.html': 'v2' })
    for (const base of [0, -1, 1.5, '1', null]) {
      expect((await putTree(id, { base, entry: 'index.html', files })).status, String(base)).toBe(
        400,
      )
    }
    const other = crypto.randomUUID()
    const res = await putTree(other, {
      base: 1,
      entry: 'index.html',
      files: await putObjects(other, { 'index.html': 'x' }),
      create: { sourceName: 'with-base' },
    })
    expect(res.status).toBe(400)
  })

  it('still commits without base, as the SPA does', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    const res = await putTree(id, {
      entry: 'index.html',
      files: await putObjects(id, { 'index.html': 'v2' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).version).toBe(2)
  })
})

describe('version numbers in responses', () => {
  it('lists the current version of each site', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    await putTree(id, {
      base: 1,
      entry: 'index.html',
      files: await putObjects(id, { 'index.html': 'v2' }),
    })
    const res = await SELF.fetch(
      `https://drop.test/api/sites?sourceName=${encodeURIComponent(`sync-${id.slice(0, 8)}`)}`,
      { headers: CSRF },
    )
    const { sites } = (await res.json()) as { sites: SiteMeta[] }
    expect(sites.find((s) => s.id === id)?.version).toBe(2)
  })

  it('answers the new version from PATCH /tree', async () => {
    const id = await createSite({ 'index.html': 'v1' })
    const res = await patchTree(id, { put: { 'b.css': 'y' } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).version).toBe(2)
  })
})
