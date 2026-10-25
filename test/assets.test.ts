import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SiteMeta } from '../src/types'
import { addFile, addLegacyPair, CSRF, patchTree, previewToken, publish, upload } from './helpers'
import { legacyCanonical } from './legacy-name'

// Delivery of Assets (Files other than HTML). Files are added with PATCH /tree (test/helpers.ts)

const ADMIN = { Cookie: 'CF_Authorization=dev' }

// Adding a file also creates a new Version, so the history preview looks at the latest Version
async function latestVersion(id: string): Promise<number> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/versions`, { headers: CSRF })
  const { versions } = (await res.json()) as { versions: { version: number }[] }
  return versions[0]?.version ?? 0
}

// R2 cleanup runs in waitUntil (async), so poll until the condition holds
async function pollPrefixCount(prefix: string, expected: number): Promise<number> {
  let list = await env.BUCKET.list({ prefix })
  for (let i = 0; i < 20 && list.objects.length !== expected; i++) {
    await new Promise((r) => setTimeout(r, 50))
    list = await env.BUCKET.list({ prefix })
  }
  return list.objects.length
}

describe('asset lifecycle', () => {
  it('serves, replaces and removes a file, each as a new version', async () => {
    const site = await upload('<h1>asset host</h1>', 'asset-host.html')
    await publish(site.id)

    await addFile(site.id, 'pic.png', 'png-bytes-v1')
    const served = await SELF.fetch(`https://drop.test/p/${site.id}/f/pic.png`)
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('png-bytes-v1')

    // The same Path is replaced. The old Object stays, still referenced by old Versions (gone once
    // pruned)
    await addFile(site.id, 'pic.png', 'png-bytes-v2-longer')
    const served2 = await SELF.fetch(`https://drop.test/p/${site.id}/f/pic.png`)
    expect(await served2.text()).toBe('png-bytes-v2-longer')

    expect((await patchTree(site.id, { delete: ['pic.png'] })).status).toBe(200)
    const gone = await SELF.fetch(`https://drop.test/p/${site.id}/f/pic.png`)
    expect(gone.status).toBe(404)
    expect(await latestVersion(site.id)).toBe(4)
  })

  // The legacy asset API was removed in phase 5 (the admin UI uses the files dialog = PATCH /tree)
  it('no longer answers the legacy asset api', async () => {
    const site = await upload('<h1>legacy api</h1>', 'legacy-api.html')
    for (const [method, path] of [
      ['GET', `/api/sites/${site.id}/assets`],
      ['PUT', `/api/sites/${site.id}/assets/pic.png`],
      ['DELETE', `/api/sites/${site.id}/assets/pic.png`],
      ['GET', `/api/sites/${site.id}/versions/1/file`],
    ] as const) {
      const res = await SELF.fetch(`https://drop.test${path}`, {
        method,
        headers: CSRF,
        body: method === 'PUT' ? 'x' : undefined,
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })
})

describe('asset authorization', () => {
  it('mirrors the /source rules: published, preview token, or admin cookie', async () => {
    const site = await upload('<h1>authz</h1>', 'authz.html')
    await addFile(site.id, 'secret.png', 'secret-bytes')

    // Private: anonymous 404 (existence hidden), token 200, admin cookie 200
    const anon = await SELF.fetch(`https://drop.test/p/${site.id}/f/secret.png`)
    expect(anon.status).toBe(404)
    const missing = await SELF.fetch(`https://drop.test/p/${site.id}/f/nothere.png`, {
      headers: ADMIN,
    })
    expect(missing.status).toBe(404)

    const token = await previewToken(site.id)
    const withToken = await SELF.fetch(`https://drop.test/p/${site.id}/t/${token}/secret.png`)
    expect(withToken.status).toBe(200)
    expect(withToken.headers.get('Cache-Control')).toBe('no-store')

    const admin = await SELF.fetch(`https://drop.test/p/${site.id}/f/secret.png`, {
      headers: ADMIN,
    })
    expect(admin.status).toBe(200)

    const bogus = await SELF.fetch(`https://drop.test/p/${site.id}/t/1.invalid/secret.png`)
    expect(bogus.status).toBe(404)

    // Another site's token cannot open it
    const other = await upload('<h1>other</h1>', 'other.html')
    const otherToken = await previewToken(other.id)
    const crossed = await SELF.fetch(`https://drop.test/p/${site.id}/t/${otherToken}/secret.png`)
    expect(crossed.status).toBe(404)

    // Anyone once published
    await publish(site.id)
    const pub = await SELF.fetch(`https://drop.test/p/${site.id}/f/secret.png`)
    expect(pub.status).toBe(200)
    expect(pub.headers.get('Cache-Control')).toBe('no-cache')
  })
})

describe('asset delivery headers', () => {
  it('serves non-PDF assets sandboxed with nosniff, CORS and COOP', async () => {
    const site = await upload('<h1>headers</h1>', 'headers.html')
    await publish(site.id)
    await addFile(site.id, 'pic.png', 'png-bytes')

    const res = await SELF.fetch(`https://drop.test/p/${site.id}/f/pic.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    // Defense in depth that makes the origin opaque on navigation. Do not remove
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    // Needed for @font-face / fetch() from an opaque-origin iframe
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="pic.png"')
  })

  it('keeps the sandbox CSP on svg (top-level svg can run scripts)', async () => {
    const site = await upload('<h1>svg</h1>', 'svg.html')
    await publish(site.id)
    await addFile(site.id, 'vec.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    const res = await SELF.fetch(`https://drop.test/p/${site.id}/f/vec.svg`)
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
  })

  it('serves PDFs without the sandbox CSP so the viewer can render them', async () => {
    const site = await upload('<h1>pdf</h1>', 'pdf.html')
    await publish(site.id)
    await addFile(site.id, 'doc.pdf', '%PDF-1.4 fake')

    const res = await SELF.fetch(`https://drop.test/p/${site.id}/f/doc.pdf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    // Chrome downloads a sandboxed top-level PDF instead of showing it, so only PDFs get no CSP
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="doc.pdf"')
  })

  it('answers HEAD, Range and If-None-Match (PDF viewer probes)', async () => {
    const site = await upload('<h1>range</h1>', 'range.html')
    await publish(site.id)
    await addFile(site.id, 'data.txt', 'hello world')

    const head = await SELF.fetch(`https://drop.test/p/${site.id}/f/data.txt`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('11')
    expect(head.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await head.text()).toBe('')

    const partial = await SELF.fetch(`https://drop.test/p/${site.id}/f/data.txt`, {
      headers: { Range: 'bytes=0-4' },
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 0-4/11')
    expect(await partial.text()).toBe('hello')

    const full = await SELF.fetch(`https://drop.test/p/${site.id}/f/data.txt`)
    const etag = full.headers.get('ETag')
    expect(etag).not.toBeNull()
    const cached = await SELF.fetch(`https://drop.test/p/${site.id}/f/data.txt`, {
      headers: { 'If-None-Match': etag as string },
    })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
  })

  it('does not shadow the raw and source routes', async () => {
    const site = await upload('<h1>routes intact</h1>', 'routes.html')
    await publish(site.id)
    await addFile(site.id, 'pic.png', 'x')

    const raw = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain('routes intact')
    const source = await SELF.fetch(`https://drop.test/p/${site.id}/source`)
    expect(source.status).toBe(200)
    expect(await source.text()).toBe('<h1>routes intact</h1>')
  })
})

describe('relative refs on the file tree', () => {
  const HTML =
    '<html><head><style>body { background: url(bg.png) }</style></head><body>' +
    '<img src="pic.png">' +
    '<img src="./pic.png">' +
    '<img src="https://ext.example/pic.png">' +
    '<img src="/rooted/pic.png">' +
    '<a href="doc.pdf" target="_blank">pdf</a>' +
    '<a href="doc2.pdf">pdf2</a>' +
    '<a href="pic.png">img link</a>' +
    '</body></html>'

  async function setup(): Promise<SiteMeta> {
    const site = await upload(HTML, 'refs.html')
    const res = await patchTree(site.id, {
      put: {
        'pic.png': 'img',
        'bg.png': 'bg',
        'doc.pdf': '%PDF-1.4 fake',
        'doc2.pdf': '%PDF-1.4 fake2',
      },
    })
    expect(res.status).toBe(200)
    return site
  }

  // The token is in the path, so delivery does not rewrite references (ADR-004)
  it('leaves ref values untouched on private and published pages', async () => {
    const site = await setup()
    const token = await previewToken(site.id)
    const privateBody = await (
      await SELF.fetch(`https://drop.test/p/${site.id}/t/${token}/index.html`)
    ).text()
    expect(privateBody).toContain('src="pic.png"')
    expect(privateBody).toContain('src="./pic.png"')
    expect(privateBody).not.toContain('token=')

    await publish(site.id)
    const pubBody = await (await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)).text()
    expect(pubBody).toContain('src="pic.png"')
    expect(pubBody).not.toContain('token=')
  })

  // Regression test for the fixed known limitation where CSS url() returned 404 in private
  // previews. Relative references resolve against the Page's URL, as in a browser, and load as is
  it('resolves relative refs (including CSS url()) against the private page url', async () => {
    const site = await setup()
    const token = await previewToken(site.id)
    const page = `https://drop.test/p/${site.id}/t/${token}/index.html`
    for (const ref of ['bg.png', './pic.png', 'doc.pdf']) {
      const res = await SELF.fetch(new URL(ref, page))
      expect(res.status, ref).toBe(200)
    }
  })

  // Chrome does not render an inline navigation to a PDF inside a sandboxed iframe, so
  // <a> links to PDF assets get target="_blank" on delivery to escape to a new tab
  it('adds target="_blank" to pdf asset links regardless of publish state', async () => {
    const site = await setup()

    const token = await previewToken(site.id)
    const privateSite = await SELF.fetch(`https://drop.test/p/${site.id}/t/${token}/index.html`)
    expect(await privateSite.text()).toContain('<a href="doc2.pdf" target="_blank">')

    // The href value is not rewritten; only target is added. Non-PDF anchors do not get it
    await publish(site.id)
    const pub = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    const pubBody = await pub.text()
    expect(pubBody).toContain('<a href="doc2.pdf" target="_blank">')
    expect(pubBody).toContain('<a href="pic.png">img link</a>')

    // The history preview (/h/) is the same sandboxed iframe, so it gets it too
    const base = (await (
      await SELF.fetch(`https://drop.test/api/sites/${site.id}/history-base`, { headers: CSRF })
    ).json()) as { base: string }
    const history = await SELF.fetch(
      `https://drop.test${base.base}${await latestVersion(site.id)}/index.html`,
    )
    expect(await history.text()).toContain('<a href="doc2.pdf" target="_blank">')
  })

  it('never rewrites the source view or the original version file', async () => {
    const site = await setup()
    const source = await SELF.fetch(`https://drop.test/p/${site.id}/source`, { headers: ADMIN })
    expect(await source.text()).toBe(HTML)
    const version = await SELF.fetch(
      `https://drop.test/api/sites/${site.id}/versions/1/files/index.html`,
      { headers: CSRF },
    )
    expect(await version.text()).toBe(HTML)
  })
})

// Legacy asset pairs (ASCII canonical name + display name) remain only for existing rows. Rows go
// straight into D1
describe('legacy asset pairs', () => {
  const JP = '2026年 旅行のしおり.pdf'.normalize('NFC')
  // The canonical name derived from JP (the name the old dialog gave at upload)
  let NOTICE = ''
  beforeAll(async () => {
    NOTICE = await legacyCanonical(JP)
  })

  it('serves a pair by display name (NFC and NFD requests) and by canonical name', async () => {
    const site = await upload('<h1>serve alias</h1>', 'serve-alias.html')
    await publish(site.id)
    await addLegacyPair(site.id, JP, '%PDF-1.4 alias')

    for (const variant of [JP, JP.normalize('NFD'), NOTICE]) {
      const res = await SELF.fetch(
        `https://drop.test/p/${site.id}/f/${encodeURIComponent(variant)}`,
      )
      expect(res.status, variant).toBe(200)
      expect(await res.text()).toBe('%PDF-1.4 alias')
    }
    const miss = await SELF.fetch(
      `https://drop.test/p/${site.id}/f/${encodeURIComponent('別の名前.pdf')}`,
    )
    expect(miss.status).toBe(404)
  })

  it('adds RFC 5987 filename* only for a pair', async () => {
    const site = await upload('<h1>disposition</h1>', 'disposition.html')
    await publish(site.id)
    await addLegacyPair(site.id, JP, '%PDF-1.4')
    await addFile(site.id, 'plain.pdf', '%PDF-1.4')

    const alias = await SELF.fetch(`https://drop.test/p/${site.id}/f/${NOTICE}`)
    expect(alias.headers.get('Content-Disposition')).toBe(
      `inline; filename="${NOTICE}"; filename*=UTF-8''${encodeURIComponent(JP)}`,
    )
    // A non-pair file stays in the old form (even with the same content, it is not a pair unless
    // its name is derived from the display name)
    const plain = await SELF.fetch(`https://drop.test/p/${site.id}/f/plain.pdf`)
    expect(plain.headers.get('Content-Disposition')).toBe('inline; filename="plain.pdf"')
  })

  it('resolves display-name refs (raw and percent-encoded) and marks PDF links reached by them', async () => {
    const html =
      '<html><body>' +
      `<a href="${JP}">notice</a>` +
      `<img src="${encodeURIComponent('図.png')}">` +
      '</body></html>'
    const site = await upload(html, 'alias-refs.html')
    await addLegacyPair(site.id, JP, '%PDF-1.4')
    await addLegacyPair(site.id, '図.png', 'img')

    // Relative references by display name (both raw Japanese and percent-encoded) load even when
    // private
    const token = await previewToken(site.id)
    const page = `https://drop.test/p/${site.id}/t/${token}/index.html`
    for (const ref of [JP, encodeURIComponent('図.png')]) {
      const res = await SELF.fetch(new URL(ref, page))
      expect(res.status, ref).toBe(200)
    }

    // Adding target to PDF links also works for display name references
    expect(await (await SELF.fetch(page)).text()).toContain(`<a href="${JP}" target="_blank">`)
  })
})

describe('asset lifecycle with the site', () => {
  it('removes file rows and objects when the site is deleted', async () => {
    const site = await upload('<h1>del assets</h1>', 'del-assets.html')
    await addFile(site.id, 'a.png', 'aaa')
    await addFile(site.id, 'b.pdf', 'bbb')
    expect(await pollPrefixCount(`sites/${site.id}/objects/`, 3)).toBe(3)

    const del = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(del.status).toBe(204)

    expect(await pollPrefixCount(`sites/${site.id}/objects/`, 0)).toBe(0)
    const files = await SELF.fetch(`https://drop.test/api/sites/${site.id}/files`, {
      headers: CSRF,
    })
    expect(files.status).toBe(404)
  })
})
