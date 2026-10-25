import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { VersionFilesResponse, VersionMeta } from '../src/types'
import { addLegacyPair } from './helpers'

// A Version's file list and the original bytes of one file (ADR-004)

const CSRF = { 'X-Drop-Request': '1' }
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sendTree(
  id: string,
  entry: string,
  files: Record<string, string>,
  create = false,
): Promise<void> {
  const listed = []
  for (const [path, body] of Object.entries(files)) {
    const hash = await sha256(body)
    const res = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/${hash}`, {
      method: 'PUT',
      headers: CSRF,
      body,
    })
    expect([200, 201]).toContain(res.status)
    listed.push({ path, sha256: hash, size: new TextEncoder().encode(body).length })
  }
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      entry,
      files: listed,
      create: create ? { sourceName: 'files' } : undefined,
    }),
  })
  expect(res.status).toBe(create ? 201 : 200)
}

async function createTree(entry: string, files: Record<string, string>): Promise<string> {
  const id = crypto.randomUUID()
  await sendTree(id, entry, files, true)
  return id
}

const api = (path: string) => SELF.fetch(`https://drop.test/api${path}`, { headers: CSRF })

async function filesOf(id: string, version: number): Promise<VersionFilesResponse> {
  const res = await api(`/sites/${id}/versions/${version}/files`)
  expect(res.status).toBe(200)
  return res.json()
}

describe('GET /api/sites/:id/versions/:v/files', () => {
  it('lists the tree of each version with its entry', async () => {
    const id = await createTree('start.html', {
      'start.html': 'v1',
      'css/a.css': 'a',
      'img/b.png': 'b',
    })
    await sendTree(id, 'index.html', { 'index.html': 'v2', 'css/a.css': 'a2' })

    const v1 = await filesOf(id, 1)
    expect(v1.entry).toBe('start.html')
    expect(v1.files.map((f) => f.path)).toEqual(['css/a.css', 'img/b.png', 'start.html'])
    const css = v1.files.find((f) => f.path === 'css/a.css')
    expect(css).toMatchObject({ size: 1, contentType: 'text/css', sha256: await sha256('a') })
    expect(css?.objectKey).toBe(`sites/${id}/objects/${await sha256('a')}`)

    const v2 = await filesOf(id, 2)
    expect(v2.entry).toBe('index.html')
    expect(v2.files.map((f) => f.path)).toEqual(['css/a.css', 'index.html'])
  })

  it('marks the canonical name of a legacy asset pair with aliasOf', async () => {
    const id = await createTree('index.html', { 'index.html': '<h1>alias</h1>' })
    const display = '図.png'.normalize('NFC')
    const canonical = await addLegacyPair(id, display, 'img')

    const { files } = await filesOf(id, 1)
    expect(files.find((f) => f.path === canonical)?.aliasOf).toBe(display)
    expect(files.find((f) => f.path === display)?.aliasOf).toBeUndefined()
    expect(files.find((f) => f.path === 'index.html')?.aliasOf).toBeUndefined()
  })

  it('answers 404 for a pruned or missing version and site, and 400 for a bad number', async () => {
    const id = await createTree('index.html', { 'index.html': 'x' })
    expect((await api(`/sites/${id}/versions/9/files`)).status).toBe(404)
    expect((await api(`/sites/00000000-0000-4000-8000-000000000000/versions/1/files`)).status).toBe(
      404,
    )
    expect((await api(`/sites/${id}/versions/0/files`)).status).toBe(400)
    expect((await api(`/sites/${id}/versions/x/files`)).status).toBe(400)
  })

  it('counts files per version in the version list', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a.css': 'a', 'b/c.js': 'c' })
    await sendTree(id, 'index.html', { 'index.html': 'y' })
    const res = await api(`/sites/${id}/versions`)
    const { versions } = (await res.json()) as { versions: VersionMeta[] }
    expect(versions.map((v) => [v.version, v.fileCount])).toEqual([
      [2, 1],
      [1, 3],
    ])
  })
})

describe('GET /api/sites/:id/versions/:v/files/*path', () => {
  it('returns the original bytes of a file as an inert download', async () => {
    const id = await createTree('index.html', {
      'index.html': '<script>alert(1)</script>',
      'docs/a b#1?.css': 'body{}',
    })
    await sendTree(id, 'index.html', { 'index.html': 'v2' })

    const page = await api(`/sites/${id}/versions/1/files/index.html`)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<script>alert(1)</script>')
    expect(page.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(page.headers.get('Content-Disposition')).toBe('attachment')
    expect(page.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(page.headers.get('Cache-Control')).toBe('no-store')

    // Names with # and ? arrive percent-encoded per segment (a file only in Version 1)
    const css = await api(`/sites/${id}/versions/1/files/docs/${encodeURIComponent('a b#1?.css')}`)
    expect(css.status).toBe(200)
    expect(await css.text()).toBe('body{}')
  })

  it('answers 404 for a path that is not in that version, and for malformed paths', async () => {
    const id = await createTree('index.html', { 'index.html': 'x', 'a.css': 'a' })
    await sendTree(id, 'index.html', { 'index.html': 'y' })
    for (const path of [
      `/sites/${id}/versions/2/files/a.css`,
      `/sites/${id}/versions/1/files/nothere.css`,
      `/sites/${id}/versions/1/files/x%2Fa.css`,
      `/sites/${id}/versions/1/files/%E0%A4%A`,
      `/sites/${id}/versions/9/files/a.css`,
    ]) {
      expect((await api(path)).status, path).toBe(404)
    }
  })
})
