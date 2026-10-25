import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { RAW_SANDBOX_CSP } from '../shared/security'
import { decodeFilePath, fileHeaders } from '../src/lib/delivery'
import type { SiteMeta } from '../src/types'
import { addFile } from './helpers'

const CSRF = { 'X-Drop-Request': '1' }
const ADMIN = { Cookie: 'CF_Authorization=dev' }
const MISSING_ID = '00000000-0000-4000-8000-000000000000'

async function upload(html: string, name: string): Promise<SiteMeta> {
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

async function publish(id: string): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
}

async function previewToken(id: string): Promise<string> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/preview-url`, { headers: CSRF })
  const { url } = (await res.json()) as { url: string }
  const token = url.match(/\/t\/([A-Za-z0-9_.-]+)\//)?.[1]
  expect(token).toBeDefined()
  return token as string
}

const get = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://drop.test${path}`, { redirect: 'manual', ...init })

describe('decodeFilePath', () => {
  it('fills in index.html for directories', () => {
    expect(decodeFilePath('')).toBe('index.html')
    expect(decodeFilePath('about/')).toBe('about/index.html')
    expect(decodeFilePath('about/index.html')).toBe('about/index.html')
  })

  it('decodes reserved characters that Hono leaves encoded', () => {
    expect(decodeFilePath('a%23b.png')).toBe('a#b.png')
    expect(decodeFilePath('q%3Fid%3D1.html')).toBe('q?id=1.html')
    expect(decodeFilePath('%E6%97%A5%E6%9C%AC.png')).toBe('日本.png')
  })

  it('normalizes to NFC so macOS-style NFD refs match stored paths', () => {
    const nfd = '図か.png'.normalize('NFD')
    expect(decodeFilePath(encodeURIComponent(nfd))).toBe('図か.png'.normalize('NFC'))
  })

  it('rejects encoded separators, empty segments, dot segments and malformed escapes', () => {
    expect(decodeFilePath('a%2Fb.png')).toBeNull()
    expect(decodeFilePath('a//b.png')).toBeNull()
    expect(decodeFilePath('%2e%2e/x')).toBeNull()
    expect(decodeFilePath('a/./b')).toBeNull()
    expect(decodeFilePath('%E6%97')).toBeNull()
  })
})

// Header decisions are gathered in one place (fileHeaders). Pin the values here to catch a
// forgotten header or a loosening change (ADR-004)
describe('fileHeaders', () => {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Access-Control-Allow-Origin': '*',
  }

  it('sandboxes HTML with the raw CSP (scripts, never same-origin)', () => {
    expect(fileHeaders('text/html', false)).toEqual({
      ...common,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': RAW_SANDBOX_CSP,
      'Content-Type': 'text/html; charset=utf-8',
    })
    expect(RAW_SANDBOX_CSP).not.toContain('allow-same-origin')
  })

  it('serves PDF without CSP and everything else with sandbox', () => {
    expect(fileHeaders('application/pdf', true)).toEqual({
      ...common,
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/pdf',
    })
    expect(fileHeaders('image/svg+xml', true)['Content-Security-Policy']).toBe('sandbox')
    expect(fileHeaders('text/css', true)).toMatchObject({
      'Content-Security-Policy': 'sandbox',
      'Content-Type': 'text/css; charset=utf-8',
    })
  })

  it('turns types outside the allowlist into a sandboxed download', () => {
    expect(fileHeaders('application/xhtml+xml', true)).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'Content-Security-Policy': 'sandbox',
      'Content-Disposition': 'attachment',
    })
  })
})

describe('file tree routes', () => {
  it('serves the entry at /f/index.html and /f/, and moves /f to /f/', async () => {
    const site = await upload('<h1>entry</h1>', 'entry.html')
    await publish(site.id)

    for (const path of [`/p/${site.id}/f/index.html`, `/p/${site.id}/f/`]) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('Content-Security-Policy')).toBe(RAW_SANDBOX_CSP)
      expect(await res.text()).toContain('<h1>entry</h1>')
    }

    const bare = await get(`/p/${site.id}/f`)
    expect(bare.status).toBe(302)
    expect(bare.headers.get('Location')).toBe(`/p/${site.id}/f/`)
  })

  it('takes the token from the path, so relative refs carry it without rewriting', async () => {
    const site = await upload('<img src="pic.png">', 'tok.html')
    await addFile(site.id, 'pic.png', 'img')
    const token = await previewToken(site.id)

    const page = await get(`/p/${site.id}/t/${token}/index.html`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('src="pic.png"')
    expect((await get(`/p/${site.id}/t/${token}/pic.png`)).status).toBe(200)

    const bare = await get(`/p/${site.id}/t/${token}`)
    expect(bare.status).toBe(302)
    expect(bare.headers.get('Location')).toBe(`/p/${site.id}/t/${token}/`)
  })

  it('answers the same 404 for a private site, a missing path and a missing site', async () => {
    const site = await upload('<h1>hidden</h1>', 'hidden.html')
    await addFile(site.id, 'pic.png', 'img')

    const responses = await Promise.all([
      get(`/p/${site.id}/f/index.html`),
      get(`/p/${site.id}/f/pic.png`),
      get(`/p/${site.id}/f/nothere.png`),
      get(`/p/${MISSING_ID}/f/index.html`),
      get(`/p/${site.id}/t/1.invalid/index.html`),
    ])
    const bodies = await Promise.all(responses.map((r) => r.text()))
    for (const res of responses) expect(res.status).toBe(404)
    expect(new Set(bodies).size).toBe(1)
  })

  it('does not let the admin cookie open pages, only other files', async () => {
    const site = await upload('<h1>admin</h1>', 'admin-page.html')
    await addFile(site.id, 'pic.png', 'img')
    expect((await get(`/p/${site.id}/f/index.html`, { headers: ADMIN })).status).toBe(404)
    expect((await get(`/p/${site.id}/f/pic.png`, { headers: ADMIN })).status).toBe(200)
  })

  it('serves assets whose names need reserved-character escapes, and rejects %2F', async () => {
    const site = await upload('<h1>names</h1>', 'names.html')
    await publish(site.id)
    await addFile(site.id, 'pic.png', 'img')
    expect((await get(`/p/${site.id}/f/pic.png`)).status).toBe(200)
    expect((await get(`/p/${site.id}/f/x%2Fpic.png`)).status).toBe(404)
    expect((await get(`/p/${site.id}/f/a//pic.png`)).status).toBe(404)
  })
})

describe('admin preview token lifetime', () => {
  // Admin tokens last as long as the Access session (the test environment's session is 1 hour).
  // Browsing several Pages does not hit 410 midway while the session is valid
  it('lasts as long as the admin session on the shell and the preview url', async () => {
    const site = await upload('<h1>long preview</h1>', 'long-preview.html')
    const now = Math.floor(Date.now() / 1000)
    const expOf = (s: string) => Number(s.match(/\/t\/(\d+)\./)?.[1])

    const shell = await (await get(`/p/${site.id}`, { headers: ADMIN })).text()
    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/preview-url`, {
      headers: CSRF,
    })
    const { url } = (await res.json()) as { url: string }
    for (const exp of [expOf(shell), expOf(url)]) {
      expect(exp).toBeGreaterThanOrEqual(now + 3600 - 5)
      expect(exp).toBeLessThanOrEqual(now + 3600 + 5)
    }
  })
})

describe('page revalidation', () => {
  // Public Pages get no-cache + ETag. Reopening right after a replace does not show stale content
  it('answers 304 for an unchanged page and serves the new body right after a replace', async () => {
    const site = await upload('<h1>first</h1>', 'etag.html')
    await publish(site.id)
    const url = `/p/${site.id}/f/index.html`

    const first = await get(url)
    expect(first.headers.get('Cache-Control')).toBe('no-cache')
    const etag = first.headers.get('ETag') as string
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect((await get(url, { headers: { 'If-None-Match': etag } })).status).toBe(304)

    const form = new FormData()
    form.append('file', new File(['<h1>second</h1>'], 'etag.html', { type: 'text/html' }))
    await SELF.fetch(`https://drop.test/api/sites/${site.id}/file`, {
      method: 'PUT',
      headers: CSRF,
      body: form,
    })
    const after = await get(url, { headers: { 'If-None-Match': etag } })
    expect(after.status).toBe(200)
    expect(await after.text()).toContain('<h1>second</h1>')

    // The theme changes the body, so the ETag changes too
    const dark = await get(`${url}?theme=dark`)
    expect(dark.headers.get('ETag')).not.toBe(after.headers.get('ETag'))
  })
})

describe('legacy routes', () => {
  it('moves /raw to the entry, putting ?token= in the path and keeping ?theme=', async () => {
    const site = await upload('<h1>legacy</h1>', 'legacy.html')
    const token = await previewToken(site.id)

    const plain = await get(`/p/${site.id}/raw`)
    expect(plain.status).toBe(302)
    expect(plain.headers.get('Location')).toBe(`/p/${site.id}/f/index.html`)

    const withToken = await get(`/p/${site.id}/raw?token=${token}&theme=dark`)
    expect(withToken.headers.get('Location')).toBe(`/p/${site.id}/t/${token}/index.html?theme=dark`)
    // The response carries a token, so keep it out of the referrer and caches
    expect(withToken.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(withToken.headers.get('Cache-Control')).toBe('no-store')

    const followed = await SELF.fetch(`https://drop.test/p/${site.id}/raw?token=${token}`)
    expect(followed.status).toBe(200)
    expect(await followed.text()).toContain('<h1>legacy</h1>')
  })

  it('moves /:filename to the file tree, keeping the percent-encoding', async () => {
    const site = await upload('<h1>legacy asset</h1>', 'legacy-asset.html')
    const token = await previewToken(site.id)
    const jp = encodeURIComponent('資料.pdf')

    const res = await get(`/p/${site.id}/${jp}?token=${token}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/p/${site.id}/t/${token}/${jp}`)
  })

  it('answers missing sites with the same redirect, leaving the 404 to the target', async () => {
    const res = await get(`/p/${MISSING_ID}/raw`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/p/${MISSING_ID}/f/index.html`)
    expect((await SELF.fetch(`https://drop.test/p/${MISSING_ID}/raw`)).status).toBe(404)
  })
})
