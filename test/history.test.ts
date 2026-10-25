import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { RAW_SANDBOX_CSP } from '../shared/security'
import { createViewToken, createViewTokenUntil, SHARE_TTL_SECONDS } from '../src/lib/view-token'
import type { VersionMeta } from '../src/types'

// The fixed history preview route /p/:id/h/:token/:version/*path (ADR-004)

const CSRF = { 'X-Drop-Request': '1' }
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }
const ADMIN = { Cookie: 'CF_Authorization=dev' }
// Same values as the miniflare bindings in vitest.config.ts
const SECRET = 'test-preview-secret'
const MISSING_ID = '00000000-0000-4000-8000-000000000000'

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Put the Objects, then Commit. Creates the Site with the id if it does not exist
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
      create: create ? { sourceName: 'history' } : undefined,
    }),
  })
  expect(res.status).toBe(create ? 201 : 200)
}

async function createTree(entry: string, files: Record<string, string>): Promise<string> {
  const id = crypto.randomUUID()
  await sendTree(id, entry, files, true)
  return id
}

async function publish(id: string): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
}

async function historyBase(id: string): Promise<string> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/history-base`, {
    headers: CSRF,
  })
  expect(res.status).toBe(200)
  const { base } = (await res.json()) as { base: string }
  return base
}

const tokenOf = (base: string) => base.match(/\/h\/([^/]+)\//)?.[1] as string

async function listVersions(id: string): Promise<VersionMeta[]> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/versions`, { headers: CSRF })
  return ((await res.json()) as { versions: VersionMeta[] }).versions
}

const get = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://drop.test${path}`, { redirect: 'manual', ...init })

describe('history preview route', () => {
  it('serves an old version from its own tree, following relative refs', async () => {
    const id = await createTree('index.html', {
      'index.html': '<link rel="stylesheet" href="css/old.css"><a href="about/">about</a>',
      'css/old.css': 'body{color:red}',
      'css/shared.css': 'v1',
      'about/index.html': '<h1>old about</h1>',
    })
    // The replace removes old.css and about/, and changes the content of shared.css
    await sendTree(id, 'index.html', { 'index.html': '<h1>new</h1>', 'css/shared.css': 'v2' })
    const base = await historyBase(id)
    const page = new URL(`${base}1/index.html`, 'https://drop.test')

    const res = await get(page.pathname)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('css/old.css')
    for (const [ref, body] of [
      ['css/old.css', 'body{color:red}'],
      ['css/shared.css', 'v1'],
    ] as const) {
      const asset = await get(new URL(ref, page).pathname)
      expect(asset.status, ref).toBe(200)
      expect(await asset.text()).toBe(body)
    }
    expect(await (await get(new URL('about/', page).pathname)).text()).toContain('old about')
    // The current Version at the same route has the new content
    expect(await (await get(`${base}2/css/shared.css`)).text()).toBe('v2')
  })

  it('moves a directory without a trailing slash using that version tree', async () => {
    const id = await createTree('index.html', {
      'index.html': 'top',
      'docs/index.html': 'docs',
    })
    await sendTree(id, 'index.html', { 'index.html': 'top only' })
    const base = await historyBase(id)
    const res = await get(`${base}1/docs`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('docs/')
    expect((await get(`${base}2/docs`)).status).toBe(404)
  })

  it('lets the SPA open a version whose entry is not index.html', async () => {
    const id = await createTree('start.html', { 'start.html': '<h1>start</h1>' })
    await sendTree(id, 'index.html', { 'index.html': '<h1>index</h1>' })
    const versions = await listVersions(id)
    const v1 = versions.find((v) => v.version === 1) as VersionMeta
    expect(v1.entryPath).toBe('start.html')
    expect(versions.find((v) => v.version === 2)?.entryPath).toBe('index.html')

    const res = await get(`${await historyBase(id)}1/${v1.entryPath}`)
    expect(await res.text()).toContain('<h1>start</h1>')
  })

  it('sends the same headers as private file delivery, even for a published site', async () => {
    const id = await createTree('index.html', { 'index.html': '<h1>h</h1>', 'a.css': 'x' })
    await publish(id)
    const base = await historyBase(id)
    const page = await get(`${base}1/index.html`)
    expect(page.headers.get('Content-Security-Policy')).toBe(RAW_SANDBOX_CSP)
    expect(page.headers.get('Cache-Control')).toBe('no-store')
    expect(page.headers.get('Referrer-Policy')).toBe('no-referrer')
    const asset = await get(`${base}1/a.css`)
    expect(asset.headers.get('Cache-Control')).toBe('no-store')
    expect(asset.headers.get('Content-Security-Policy')).toBe('sandbox')
  })

  it('passes the theme through the query like current pages', async () => {
    const id = await createTree('index.html', { 'index.html': '<html><body>t</body></html>' })
    const res = await get(`${await historyBase(id)}1/index.html?theme=dark`)
    expect(await res.text()).toMatch(/<html[^>]*data-theme="dark"/)
  })
})

describe('history preview authorization', () => {
  it('opens old versions of a published site only with a history token', async () => {
    const id = await createTree('index.html', { 'index.html': 'pub', 'a.css': 'x' })
    await publish(id)
    const now = Math.floor(Date.now() / 1000)
    const share = await createViewToken(SECRET, id, SHARE_TTL_SECONDS)
    const preview = await createViewTokenUntil(SECRET, id, now + 3600)
    const responses = await Promise.all([
      get(`/p/${id}/h/${share}/1/index.html`),
      get(`/p/${id}/h/${preview}/1/index.html`),
      get(`/p/${id}/h/${preview}/1/a.css`, { headers: ADMIN }),
      get(`/p/${id}/h/1.invalid/1/index.html`),
    ])
    for (const res of responses) expect(res.status).toBe(404)
  })

  it('does not accept a history token on the current tree, the shell or the source view', async () => {
    const id = await createTree('index.html', { 'index.html': 'private' })
    const token = tokenOf(await historyBase(id))
    expect((await get(`/p/${id}/t/${token}/index.html`)).status).toBe(404)
    expect((await get(`/p/${id}?token=${token}`)).status).toBe(404)
    expect((await get(`/p/${id}/source?token=${token}`)).status).toBe(404)
  })

  it('answers 410 for an expired history token and 404 for a forged one', async () => {
    const id = await createTree('index.html', { 'index.html': 'expiring' })
    const expired = await createViewTokenUntil(SECRET, id, 1, 'history')
    expect((await get(`/p/${id}/h/${expired}/1/index.html`)).status).toBe(410)
    // Verify the signature first: even if the expiry is past, a forged signature is 404 (not an
    // existence oracle)
    const forged = `1.${expired.split('.')[1]?.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'))}`
    expect((await get(`/p/${id}/h/${forged}/1/index.html`)).status).toBe(404)
    // If the Site does not exist, it is 404 rather than 410 even when expired (same as the shell's
    // share link)
    const other = await createViewTokenUntil(SECRET, MISSING_ID, 1, 'history')
    expect((await get(`/p/${MISSING_ID}/h/${other}/1/index.html`)).status).toBe(404)
  })

  it('answers the same 404 for a pruned version, a missing path and a missing site', async () => {
    const id = await createTree('index.html', { 'index.html': 'v1' })
    const token = tokenOf(await historyBase(id))
    const missingSite = await createViewTokenUntil(
      SECRET,
      MISSING_ID,
      Math.floor(Date.now() / 1000) + 3600,
      'history',
    )
    const responses = await Promise.all([
      get(`/p/${id}/h/${token}/99/index.html`),
      get(`/p/${id}/h/${token}/0/index.html`),
      get(`/p/${id}/h/${token}/x/index.html`),
      get(`/p/${id}/h/${token}/1/nothere.css`),
      get(`/p/${MISSING_ID}/h/${missingSite}/1/index.html`),
    ])
    const bodies = await Promise.all(responses.map((r) => r.text()))
    for (const res of responses) expect(res.status).toBe(404)
    expect(new Set(bodies).size).toBe(1)
  })

  it('issues history tokens that last as long as the admin session', async () => {
    const id = await createTree('index.html', { 'index.html': 'session' })
    const now = Math.floor(Date.now() / 1000)
    const exp = Number(tokenOf(await historyBase(id)).split('.')[0])
    expect(exp).toBeGreaterThanOrEqual(now + 3600 - 5)
    expect(exp).toBeLessThanOrEqual(now + 3600 + 5)
  })
})
