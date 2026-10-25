import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { MAX_FILES } from '../shared/files'
import { type SiteRow, sites } from '../src/db/schema'
import { commitVersion, StaleBaseError } from '../src/lib/versions'
import type { SiteFilesResponse, SiteMeta } from '../src/types'
import { testBackend } from './helpers'
import { legacyCanonical } from './legacy-name'

// Changes to the current tree, PATCH /api/sites/:id/tree (ADR-004)

const CSRF = { 'X-Drop-Request': '1' }
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const size = (body: string) => new TextEncoder().encode(body).length

// Store the Object and return it in the shape PATCH's put takes
async function stage(id: string, path: string, body: string) {
  const hash = await sha256(body)
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/${hash}`, {
    method: 'PUT',
    headers: CSRF,
    body,
  })
  expect([200, 201]).toContain(res.status)
  return { path, sha256: hash, size: size(body) }
}

async function createTree(entry: string, files: Record<string, string>): Promise<string> {
  const id = crypto.randomUUID()
  // Store the same content only once (the limit test creates 1000 files)
  const staged = new Map<string, { sha256: string; size: number }>()
  const listed = []
  for (const [path, body] of Object.entries(files)) {
    let ref = staged.get(body)
    if (!ref) {
      ref = await stage(id, path, body)
      staged.set(body, ref)
    }
    listed.push({ path, sha256: ref.sha256, size: ref.size })
  }
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ entry, files: listed, create: { sourceName: 'patch' } }),
  })
  expect(res.status).toBe(201)
  return id
}

async function current(id: string): Promise<SiteFilesResponse> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/files`, { headers: CSRF })
  expect(res.status).toBe(200)
  return res.json()
}

const paths = (t: SiteFilesResponse) => t.files.map((f) => f.path)

function patch(id: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

async function versionCount(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM versions WHERE site_id = ?')
    .bind(id)
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe('GET /api/sites/:id/files', () => {
  it('returns the current version number, entry and files', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a/b.css': 'b' })
    const t = await current(id)
    expect(t.version).toBe(1)
    expect(t.entry).toBe('index.html')
    expect(paths(t)).toEqual(['a/b.css', 'index.html'])
  })
})

describe('PATCH /api/sites/:id/tree', () => {
  it('adds and replaces files, carrying the rest over to a new version', async () => {
    const id = await createTree('index.html', {
      'index.html': '<title>T</title>',
      'css/a.css': 'a1',
      'img/p.png': 'p',
    })
    const res = await patch(id, {
      base: 1,
      put: [await stage(id, 'css/a.css', 'a2'), await stage(id, 'docs/新しい.txt', 'n')],
    })
    expect(res.status).toBe(200)
    const site = (await res.json()) as SiteMeta
    expect(site.title).toBe('T')

    const t = await current(id)
    expect(t.version).toBe(2)
    expect(paths(t)).toEqual(['css/a.css', 'docs/新しい.txt', 'img/p.png', 'index.html'])
    expect(t.files.find((f) => f.path === 'css/a.css')?.sha256).toBe(await sha256('a2'))
    expect(t.files.find((f) => f.path === 'docs/新しい.txt')?.contentType).toBe('text/plain')
    const served = await SELF.fetch(
      `https://drop.test/api/sites/${id}/versions/2/files/css/a.css`,
      {
        headers: CSRF,
      },
    )
    expect(await served.text()).toBe('a2')
  })

  it('deletes files, and refuses to delete the entry', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a.css': 'a', 'b.css': 'b' })
    expect((await patch(id, { base: 1, delete: ['a.css'] })).status).toBe(200)
    expect(paths(await current(id))).toEqual(['b.css', 'index.html'])

    expect((await patch(id, { base: 2, delete: ['index.html'] })).status).toBe(400)
    expect((await patch(id, { base: 2, delete: ['nothere.css'] })).status).toBe(400)
    expect(await versionCount(id)).toBe(2)
  })

  it('changes the entry and derives the title from the new entry', async () => {
    const id = await createTree('index.html', {
      'index.html': '<title>Index</title>',
      'docs/start.html': '<title>Start</title>',
      'a.css': 'a',
    })
    const res = await patch(id, { base: 1, entry: 'docs/start.html' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).title).toBe('Start')
    const t = await current(id)
    expect(t.entry).toBe('docs/start.html')
    expect(paths(t)).toEqual(['a.css', 'docs/start.html', 'index.html'])

    // title comes from the Entry also when the new Entry is replaced
    const put = await stage(id, 'docs/start.html', '<title>Start 2</title>')
    const again = await patch(id, { base: 2, put: [put] })
    expect(((await again.json()) as SiteMeta).title).toBe('Start 2')

    expect((await patch(id, { base: 3, entry: 'a.css' })).status).toBe(400)
    expect((await patch(id, { base: 3, entry: 'missing.html' })).status).toBe(400)
  })

  it('answers 409 for a stale base and leaves the versions alone', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a.css': 'a' })
    expect((await patch(id, { base: 1, delete: ['a.css'] })).status).toBe(200)
    const stale = await patch(id, { base: 1, put: [await stage(id, 'b.css', 'b')] })
    expect(stale.status).toBe(409)
    expect(await versionCount(id)).toBe(2)
    expect(paths(await current(id))).toEqual(['index.html'])
    // A Version that does not exist yet is also 409
    expect((await patch(id, { base: 9, delete: [] })).status).toBe(409)
  })

  it('rejects malformed requests with 400', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a.css': 'a' })
    const good = await stage(id, 'b.css', 'b')
    for (const body of [
      {},
      { base: 'x' },
      { base: 1, put: [{ ...good, path: '../b.css' }] },
      { base: 1, put: [good, good] },
      { base: 1, put: [{ ...good, sha256: 'nothex' }] },
      { base: 1, put: [{ ...good, path: 'a.css' }], delete: ['a.css'] },
      { base: 1, delete: ['a.css', 'a.css'] },
      { base: 1, delete: [42] },
      // The Object is missing, or the size does not match
      { base: 1, put: [{ path: 'c.css', sha256: 'f'.repeat(64), size: 1 }] },
      { base: 1, put: [{ ...good, size: good.size + 1 }] },
    ]) {
      const res = await patch(id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await versionCount(id)).toBe(1)
  })

  it('checks the limits on the merged tree, not only on what was sent', async () => {
    const files: Record<string, string> = { 'index.html': 'x' }
    for (let i = 0; i < MAX_FILES - 1; i++) files[`f/${i}.txt`] = 'same'
    const id = await createTree('index.html', files)
    const res = await patch(id, { base: 1, put: [await stage(id, 'one-more.txt', 'more')] })
    expect(res.status).toBe(400)
    // A replace does not increase the count, so it passes
    const swap = await patch(id, { base: 1, put: [await stage(id, 'f/0.txt', 'zero')] })
    expect(swap.status).toBe(200)
  })

  it('answers 404 for a missing site', async () => {
    const res = await patch('00000000-0000-4000-8000-000000000000', { base: 1, delete: [] })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/sites/:id/tree on legacy data', () => {
  // Rows under legacy keys (assets/, versions/) have no sha256 and cannot be resent with PUT /tree
  async function addLegacy(id: string, path: string, body: string, contentType: string) {
    const key = `assets/${id}/${crypto.randomUUID()}`
    await env.BUCKET.put(key, body)
    await env.DB.prepare(
      `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
       SELECT site_id, max(version), ?, ?, ?, ? FROM versions WHERE site_id = ?`,
    )
      .bind(path, key, contentType, size(body), id)
      .run()
    return key
  }

  it('keeps legacy object keys of the files it does not touch', async () => {
    const id = await createTree('index.html', { 'index.html': 'x' })
    const key = await addLegacy(id, 'old.css', 'old', 'text/css')
    const res = await patch(id, { base: 1, put: [await stage(id, 'new.css', 'new')] })
    expect(res.status).toBe(200)
    const t = await current(id)
    expect(t.files.find((f) => f.path === 'old.css')?.objectKey).toBe(key)
    const old = await SELF.fetch(`https://drop.test/api/sites/${id}/versions/2/files/old.css`, {
      headers: CSRF,
    })
    expect(await old.text()).toBe('old')
  })

  it('applies put and delete to both names of a legacy asset pair', async () => {
    const id = await createTree('index.html', { 'index.html': 'x' })
    const display = '図.png'.normalize('NFC')
    const canonical = await legacyCanonical(display)
    const key = await addLegacy(id, canonical, 'img', 'image/png')
    await env.DB.prepare(
      `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
       VALUES (?, 1, ?, ?, 'image/png', 3)`,
    )
      .bind(id, display, key)
      .run()

    // A put to the display name also makes the canonical name point to the new content
    const put = await patch(id, { base: 1, put: [await stage(id, display, 'img2')] })
    expect(put.status).toBe(200)
    const t = await current(id)
    const pair = t.files.filter((f) => f.path === display || f.path === canonical)
    expect(pair).toHaveLength(2)
    for (const f of pair) expect(f.sha256).toBe(await sha256('img2'))
    expect(t.files.find((f) => f.path === canonical)?.aliasOf).toBe(display)

    // A delete of the canonical name also removes the display name
    expect((await patch(id, { base: 2, delete: [canonical] })).status).toBe(200)
    expect(paths(await current(id))).toEqual(['index.html'])
  })
})

describe('legacy asset pairs that share an object', () => {
  // Two pairs with the same content point to the same Object. Pairing by name shape alone would
  // pick the other pair's canonical name as the partner
  it('keeps each pair apart when two pairs point at the same object', async () => {
    const id = await createTree('index.html', { 'index.html': 'x' })
    const [a, b] = ['あ.png', 'い.png']
    const [ca, cb] = [await legacyCanonical(a), await legacyCanonical(b)]
    const key = `assets/${id}/${crypto.randomUUID()}`
    await env.BUCKET.put(key, 'same')
    for (const path of [ca, a, cb, b]) {
      await env.DB.prepare(
        `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
         VALUES (?, 1, ?, ?, 'image/png', 4)`,
      )
        .bind(id, path, key)
        .run()
    }
    const listed = await current(id)
    expect(listed.files.find((f) => f.path === ca)?.aliasOf).toBe(a)
    expect(listed.files.find((f) => f.path === cb)?.aliasOf).toBe(b)

    expect((await patch(id, { base: 1, delete: [b] })).status).toBe(200)
    expect(paths(await current(id))).toEqual([ca, 'index.html', a].sort())

    // A replace also affects only the two in that pair
    const id2 = await createTree('index.html', { 'index.html': 'y' })
    const key2 = `assets/${id2}/${crypto.randomUUID()}`
    await env.BUCKET.put(key2, 'same')
    for (const path of [ca, a, cb, b]) {
      await env.DB.prepare(
        `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
         VALUES (?, 1, ?, ?, 'image/png', 4)`,
      )
        .bind(id2, path, key2)
        .run()
    }
    expect((await patch(id2, { base: 1, put: [await stage(id2, a, 'new')] })).status).toBe(200)
    const after = await current(id2)
    const keyOf = (p: string) => after.files.find((f) => f.path === p)?.objectKey
    expect(keyOf(a)).toBe(keyOf(ca))
    expect(keyOf(a)).not.toBe(key2)
    expect(keyOf(b)).toBe(key2)
    expect(keyOf(cb)).toBe(key2)
  })
})

// When another write lands between the precheck (is base the latest) and the batch. HTTP cannot
// interleave there, so call commitVersion directly to check that the check inside the batch works
describe('base guard inside the batch', () => {
  it('rolls back the whole batch when base is no longer the latest', async () => {
    const id = await createTree('index.html', { 'index.html': 'x' })
    const backend = testBackend()
    const [row] = await backend.db.orm.select().from(sites).where(eq(sites.id, id))
    const files = (await current(id)).files.map((f) => ({ ...f, sha256: f.sha256 }))
    const next = { entryPath: 'index.html', files, title: 'stale' }
    await expect(
      commitVersion(backend, row as SiteRow, { ...next, base: 0 }),
    ).rejects.toBeInstanceOf(StaleBaseError)
    expect(await versionCount(id)).toBe(1)
    const [after] = await backend.db.orm.select().from(sites).where(eq(sites.id, id))
    expect(after?.title).not.toBe('stale')

    await commitVersion(backend, row as SiteRow, { ...next, base: 1 })
    expect(await versionCount(id)).toBe(2)
  })
})
