import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { faviconHref, faviconHrefFor, faviconLocalHref } from '../shared/favicon'
import { MAX_PAGE_SIZE } from '../shared/files'
import { IFRAME_SANDBOX, RAW_SANDBOX_CSP } from '../shared/security'
import { accentHex, dropTokensCss, themeCss } from '../shared/theme'
import { createViewToken, SHARE_TTL_SECONDS } from '../src/lib/view-token'
import type { SiteMeta, VersionMeta } from '../src/types'

const CSRF = { 'X-Drop-Request': '1' }
// Same values as the miniflare bindings in vitest.config.ts
const SECRET = 'test-preview-secret'

async function upload(html = '<h1>hello</h1>', name = 'test.html'): Promise<SiteMeta> {
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

async function publish(id: string): Promise<SiteMeta> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
  return res.json()
}

describe('CSRF guard', () => {
  it('rejects /api requests without the custom header', async () => {
    const res = await SELF.fetch('https://drop.test/api/sites')
    expect(res.status).toBe(403)
  })

  it('rejects /api requests with a foreign Origin', async () => {
    const res = await SELF.fetch('https://drop.test/api/sites', {
      headers: { ...CSRF, Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts /api requests with the same Origin', async () => {
    const res = await SELF.fetch('https://drop.test/api/sites', {
      headers: { ...CSRF, Origin: 'https://drop.test' },
    })
    expect(res.status).toBe(200)
  })
})

describe('sites CRUD', () => {
  it('uploads, lists, gets, patches and deletes a site', async () => {
    const site = await upload('<p>crud</p>', 'crud.html')
    expect(site.title).toBe('crud')
    expect(site.published).toBe(false)

    const listRes = await SELF.fetch('https://drop.test/api/sites?q=crud', { headers: CSRF })
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { sites: SiteMeta[]; total: number }
    expect(list.sites.some((p) => p.id === site.id)).toBe(true)

    const getRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, { headers: CSRF })
    expect(getRes.status).toBe(200)

    const patched = await publish(site.id)
    expect(patched.published).toBe(true)

    const delRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(delRes.status).toBe(204)

    const gone = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, { headers: CSRF })
    expect(gone.status).toBe(404)
  })

  it('rejects non-HTML uploads', async () => {
    const form = new FormData()
    form.append('file', new File(['{}'], 'data.json', { type: 'application/json' }))
    const res = await SELF.fetch('https://drop.test/api/sites', {
      method: 'POST',
      headers: CSRF,
      body: form,
    })
    expect(res.status).toBe(400)
  })

  it('rejects files over the HTML size limit', async () => {
    const big = 'x'.repeat(MAX_PAGE_SIZE + 1)
    const form = new FormData()
    form.append('file', new File([big], 'big.html', { type: 'text/html' }))
    const res = await SELF.fetch('https://drop.test/api/sites', {
      method: 'POST',
      headers: CSRF,
      body: form,
    })
    expect(res.status).toBe(413)
  })
})

describe('public raw delivery', () => {
  it('serves published HTML with the CSP sandbox header', async () => {
    const site = await upload('<h1>published</h1>', 'pub.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(res.status).toBe(200)
    // This assertion is the crux of the same-origin boundary. Never remove it.
    // sandbox is required; never add allow-same-origin.
    // For the intent and justification of the popup flags, see shared/security.ts
    expect(res.headers.get('Content-Security-Policy')).toBe(RAW_SANDBOX_CSP)
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(res.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toContain('published')
  })

  it('returns 404 for private and missing sites identically', async () => {
    const site = await upload('<h1>private</h1>', 'private.html')

    const privateRes = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    const missingRes = await SELF.fetch(
      'https://drop.test/p/00000000-0000-4000-8000-000000000000/f/index.html',
    )
    expect(privateRes.status).toBe(404)
    expect(missingRes.status).toBe(404)
    expect(await privateRes.text()).toBe(await missingRes.text())
  })
})

describe('raw design injection', () => {
  async function publishAndFetchRaw(html: string, query = ''): Promise<string> {
    const site = await upload(html, 'inject.html')
    await publish(site.id)
    const res = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html${query}`)
    expect(res.status).toBe(200)
    return res.text()
  }

  it('injects defaults, viewport and OS-following color-scheme into unstyled HTML', async () => {
    // A fragment without head is injected at the start of the document (absorbed into the implicit
    // head)
    const body = await publishAndFetchRaw('<h1>plain</h1>')
    expect(body).toContain('@layer drop-defaults')
    expect(body).toContain('name="viewport"')
    expect(body).toContain('color-scheme: light dark')
    expect(body.indexOf('name="viewport"')).toBeLessThan(body.indexOf('<h1>plain</h1>'))
  })

  it('pins color-scheme via the theme query param, ignoring bogus values', async () => {
    const site = await upload('<h1>themed</h1>', 'themed.html')
    await publish(site.id)

    const dark = await (
      await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html?theme=dark`)
    ).text()
    expect(dark).toContain('color-scheme: dark')

    const bogus = await (
      await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html?theme=hacker`)
    ).text()
    expect(bogus).toContain('color-scheme: light dark')
  })

  it('skips color-scheme when the site has its own <style>', async () => {
    const body = await publishAndFetchRaw(
      '<html><head><style>body { background: #fff }</style></head><body><h1>styled</h1></body></html>',
    )
    expect(body).toContain('@layer drop-defaults')
    expect(body).not.toContain(':where(html) { color-scheme')
  })

  it('skips color-scheme for inline style attributes', async () => {
    // Darkening HTML that sets only a background, not a text color, breaks it with white on white
    const body = await publishAndFetchRaw('<body style="background:#fff"><h1>inline</h1></body>')
    expect(body).not.toContain(':where(html) { color-scheme')
  })

  it('skips color-scheme for legacy presentation attributes', async () => {
    const body = await publishAndFetchRaw('<body bgcolor="white"><h1>legacy</h1></body>')
    expect(body).not.toContain(':where(html) { color-scheme')
  })

  it('keeps drop-defaults as the first declared layer when the author uses layers', async () => {
    // If declared after the author's layer, drop-defaults would win (Tailwind v4, etc)
    const body = await publishAndFetchRaw(
      '<html><head><style>@layer app { h1 { color: red } }</style></head><body><h1>layered</h1></body></html>',
    )
    expect(body.indexOf('@layer drop-defaults')).toBeGreaterThan(-1)
    expect(body.indexOf('@layer drop-defaults')).toBeLessThan(body.indexOf('@layer app'))
  })

  it('does not duplicate an existing viewport meta', async () => {
    const body = await publishAndFetchRaw(
      '<html><head><meta name="viewport" content="width=device-width"></head><body>v</body></html>',
    )
    expect(body.match(/name="viewport"/g)).toHaveLength(1)
  })

  it('injects right after the doctype for head-less documents', async () => {
    const body = await publishAndFetchRaw('<!doctype html>\n<h1>doc</h1>')
    expect(body.indexOf('<!doctype html>')).toBeLessThan(body.indexOf('name="viewport"'))
    expect(body.indexOf('name="viewport"')).toBeLessThan(body.indexOf('<h1>doc</h1>'))
  })

  it('never rewrites the source view', async () => {
    const html = '<h1>pristine</h1>'
    const site = await upload(html, 'pristine.html')
    await publish(site.id)
    const res = await SELF.fetch(`https://drop.test/p/${site.id}/source`)
    expect(await res.text()).toBe(html)
  })
})

describe('drop theme tokens', () => {
  it('injects --drop-* variables into every site, styled or not', async () => {
    const unstyled = await upload('<h1>bare</h1>', 'bare.html')
    await publish(unstyled.id)
    const styled = await upload(
      '<html><head><style>body { color: red }</style></head><body>s</body></html>',
      'styled.html',
    )
    await publish(styled.id)

    for (const id of [unstyled.id, styled.id]) {
      const body = await (await SELF.fetch(`https://drop.test/p/${id}/f/index.html`)).text()
      expect(body).toContain('--drop-bg:')
      expect(body).toContain('--drop-text:')
    }
  })

  it('follows the OS by default: light values in :root, dark behind the media query', async () => {
    const site = await upload('<h1>os</h1>', 'os.html')
    await publish(site.id)
    const body = await (await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)).text()
    expect(body).toContain(dropTokensCss(null))
    expect(body).toContain('prefers-color-scheme: dark')
  })

  it('pins token values and sets data-theme on <html> when the theme is forced', async () => {
    const site = await upload('<html><body><h1>forced</h1></body></html>', 'forced.html')
    await publish(site.id)
    const body = await (
      await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html?theme=dark`)
    ).text()

    expect(body).toContain(dropTokensCss('dark'))
    // When pinned, media queries do not sway it
    expect(body).not.toContain('prefers-color-scheme')
    expect(body).toMatch(/<html[^>]*data-theme="dark"/)
  })

  it('keeps public token values in sync with the shell palette', () => {
    // Guards the single source (the token map in shared/theme.ts).
    // The shell's --bg and the public --drop-bg are generated from the same value
    for (const [name, mode] of [
      ['bg', 'light'],
      ['text', 'light'],
    ] as const) {
      const shell = themeCss.match(new RegExp(`--${name}: ([^;]+);`))?.[1]
      const pub = dropTokensCss(mode).match(new RegExp(`--drop-${name}: ([^;]+);`))?.[1]
      expect(pub).toBeDefined()
      expect(pub).toBe(shell)
    }
  })
})

describe('favicon', () => {
  it('takes its color from the theme accent, not a copied hex', () => {
    // CSS variables do not reach the favicon, so it uses literal hex. Guards against it drifting
    // from shared/theme.ts (%23 is the escape for #)
    expect(faviconHref).toContain(`%23${accentHex.light.slice(1)}`)
    expect(faviconHref).toContain(`%23${accentHex.dark.slice(1)}`)
    expect(faviconHref).toContain('prefers-color-scheme:dark')
  })

  it('goes monochrome on localhost so it is not mistaken for production', () => {
    expect(faviconHrefFor('localhost')).toBe(faviconLocalHref)
    expect(faviconHrefFor('127.0.0.1')).toBe(faviconLocalHref)
    expect(faviconHrefFor('drop.example.dev')).toBe(faviconHref)
    // The achromatic version also follows the OS light/dark setting, not the app theme
    expect(faviconLocalHref).toContain('prefers-color-scheme:dark')
  })

  it('serves the icon on the site shell and allows it in the CSP', async () => {
    const site = await upload('<h1>icon</h1>', 'icon.html')
    await publish(site.id)
    const res = await SELF.fetch(`https://drop.test/p/${site.id}`)
    const body = await res.text()

    expect(body).toContain(`<link rel="icon" href="${faviconHref}" />`)
    // data URIs are blocked under default-src 'none', so img-src must allow them explicitly
    expect(res.headers.get('Content-Security-Policy')).toContain('img-src data:')
  })

  it('serves the icon on the 404 site too', async () => {
    const res = await SELF.fetch('https://drop.test/p/nonexistent')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain(`<link rel="icon" href="${faviconHref}" />`)
  })
})

describe('public site view', () => {
  it('returns 404 for private sites to visitors', async () => {
    const site = await upload('<h1>private view</h1>', 'private-view.html')
    const res = await SELF.fetch(`https://drop.test/p/${site.id}`)
    expect(res.status).toBe(404)
  })

  it('renders published sites without admin chrome for visitors', async () => {
    const site = await upload('<h1>view</h1>', 'view.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}`)
    expect(res.status).toBe(200)
    // Blocks re-navigation from a popup that escaped the sandbox (see shared/security.ts)
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    const body = await res.text()
    expect(body).toContain(`/p/${site.id}/f/index.html`)
    expect(body).toContain(`sandbox="${IFRAME_SANDBOX}"`)
    expect(body).not.toContain('publish')
    expect(body).not.toContain('/sites')
    // Visitors get no bar at all (content fills the screen)
    expect(body).not.toContain('<header')
  })

  it('lets the admin preview a private site via the signed token', async () => {
    const site = await upload('<h1>secret private</h1>', 'secret.html')

    // With ENVIRONMENT=test, the cookie being present means admin
    const viewRes = await SELF.fetch(`https://drop.test/p/${site.id}`, {
      headers: { Cookie: 'CF_Authorization=dev' },
    })
    expect(viewRes.status).toBe(200)
    const body = await viewRes.text()

    const match = body.match(/\/t\/([A-Za-z0-9_.-]+)\/index\.html/)
    expect(match).not.toBeNull()
    const token = match?.[1]

    // Raw with a token is 200 even when private (no cookie = like a sandboxed iframe)
    const rawRes = await SELF.fetch(`https://drop.test/p/${site.id}/t/${token}/index.html`)
    expect(rawRes.status).toBe(200)
    expect(await rawRes.text()).toContain('secret private')

    // An invalid token is 404
    const badRes = await SELF.fetch(`https://drop.test/p/${site.id}/t/1.invalid/index.html`)
    expect(badRes.status).toBe(404)
  })

  it('issues a preview url that unlocks a private raw', async () => {
    const site = await upload('<h1>sheet private</h1>', 'sheet.html')

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/preview-url`, {
      headers: CSRF,
    })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toMatch(new RegExp(`^/p/${site.id}/t/[A-Za-z0-9_.-]+/index\\.html$`))

    // The issued URL is 200 even without a cookie (like a sandboxed iframe), and the isolation
    // contract holds
    const rawRes = await SELF.fetch(`https://drop.test${url}`)
    expect(rawRes.status).toBe(200)
    expect(rawRes.headers.get('Content-Security-Policy')).toBe(RAW_SANDBOX_CSP)
    expect(await rawRes.text()).toContain('sheet private')
  })

  it('issues a plain raw url for published sites', async () => {
    const site = await upload('<h1>sheet pub</h1>', 'sheet-pub.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/preview-url`, {
      headers: CSRF,
    })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toBe(`/p/${site.id}/f/index.html`)

    const missing = await SELF.fetch(
      'https://drop.test/api/sites/00000000-0000-4000-8000-000000000000/preview-url',
      { headers: CSRF },
    )
    expect(missing.status).toBe(404)
  })

  it('shows admin chrome when the admin cookie is present', async () => {
    const site = await upload('<h1>admin view</h1>', 'admin.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}`, {
      headers: { Cookie: 'CF_Authorization=dev' },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('unpublish')
    expect(body).toContain('/sites')
  })
})

describe('share link (short-lived token)', () => {
  it('opens a private shell with a valid token, without the admin bar', async () => {
    const site = await upload('<h1>shared body</h1>', 'shared.html')
    const token = await createViewToken(SECRET, site.id, SHARE_TTL_SECONDS)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}?token=${token}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // A visitor, so no chrome (the admin bar only appears once Access is verified)
    expect(body).not.toContain('<header')
    // Pass the received token to the iframe as is (reissuing would allow extending the expiry
    // forever)
    expect(body).toContain(`/p/${site.id}/t/${token}/index.html`)
    // The token is in the URL here, so keep it out of the referrer and intermediate caches
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('serves raw and assets through the same token', async () => {
    const site = await upload('<h1>shared raw</h1>', 'shared-raw.html')
    const token = await createViewToken(SECRET, site.id, SHARE_TTL_SECONDS)

    const raw = await SELF.fetch(`https://drop.test/p/${site.id}/t/${token}/index.html`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain('shared raw')
  })

  it('answers 410 for an expired token', async () => {
    const site = await upload('<h1>expired</h1>', 'expired.html')
    const token = await createViewToken(SECRET, site.id, -1)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}?token=${token}`)
    expect(res.status).toBe(410)
    const body = await res.text()
    expect(body).toContain('expired')
    // Do not mix hints about the content into the expired view
    expect(body).not.toContain('expired.html')

    // Expiry takes precedence over the admin cookie. Answering for the state of the credential in
    // the URL is more consistent, and since isAdminViewer always returns true in development,
    // checking admin first would make the 410 impossible to reproduce locally
    const asAdmin = await SELF.fetch(`https://drop.test/p/${site.id}?token=${token}`, {
      headers: { Cookie: 'CF_Authorization=dev' },
    })
    expect(asAdmin.status).toBe(410)
  })

  it('answers 404 (not 410) for a forged token, so 410 is not an existence oracle', async () => {
    const site = await upload('<h1>oracle</h1>', 'oracle.html')

    // A token with a missing or broken signature is invalid even if expired
    for (const bogus of ['1.invalid', '1.', '0.AAAA', 'abc.AAAA']) {
      const res = await SELF.fetch(`https://drop.test/p/${site.id}?token=${bogus}`)
      expect(res.status).toBe(404)
    }

    // The response matches that of a nonexistent site (two 404s are indistinguishable)
    const missing = await SELF.fetch(
      'https://drop.test/p/00000000-0000-4000-8000-000000000000?token=1.invalid',
    )
    expect(missing.status).toBe(404)
  })

  it('rejects a token minted for another site', async () => {
    const a = await upload('<h1>a</h1>', 'a.html')
    const b = await upload('<h1>b</h1>', 'b.html')
    const token = await createViewToken(SECRET, b.id, SHARE_TTL_SECONDS)

    const res = await SELF.fetch(`https://drop.test/p/${a.id}?token=${token}`)
    expect(res.status).toBe(404)
  })

  it('returns 404, not 410, when the site itself is gone', async () => {
    const token = await createViewToken(SECRET, '00000000-0000-4000-8000-000000000000', -1)
    const res = await SELF.fetch(
      `https://drop.test/p/00000000-0000-4000-8000-000000000000?token=${token}`,
    )
    expect(res.status).toBe(404)
  })

  it('keeps serving a published site even with an expired token', async () => {
    const site = await upload('<h1>public</h1>', 'public.html')
    await publish(site.id)
    const token = await createViewToken(SECRET, site.id, -1)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}?token=${token}`)
    expect(res.status).toBe(200)
  })

  it('issues an absolute url with the share TTL', async () => {
    const site = await upload('<h1>issue</h1>', 'issue.html')

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/share-link`, {
      headers: CSRF,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const { url, expiresIn } = (await res.json()) as { url: string; expiresIn: number }
    expect(expiresIn).toBe(SHARE_TTL_SECONDS)
    // An absolute URL, since the value goes to the clipboard and on to others
    expect(url.startsWith(`https://drop.test/p/${site.id}?token=`)).toBe(true)

    const exp = Number(new URL(url).searchParams.get('token')?.split('.')[0])
    const now = Math.floor(Date.now() / 1000)
    expect(exp).toBeGreaterThan(now + SHARE_TTL_SECONDS - 30)
    expect(exp).toBeLessThanOrEqual(now + SHARE_TTL_SECONDS)

    // The issued link opens as is (no cookie)
    const view = await SELF.fetch(url)
    expect(view.status).toBe(200)
  })

  it('refuses to issue a share link for a published site', async () => {
    const site = await upload('<h1>already</h1>', 'already.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/share-link`, {
      headers: CSRF,
    })
    expect(res.status).toBe(400)
  })
})

describe('source view', () => {
  it('serves the published site source as text/plain', async () => {
    const site = await upload('<h1>source view</h1>', 'src.html')
    await publish(site.id)

    const res = await SELF.fetch(`https://drop.test/p/${site.id}/source`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(await res.text()).toBe('<h1>source view</h1>')
  })

  it('hides private sources from visitors but shows them to the admin', async () => {
    const site = await upload('<h1>private source</h1>', 'private-src.html')

    const anon = await SELF.fetch(`https://drop.test/p/${site.id}/source`)
    expect(anon.status).toBe(404)

    const admin = await SELF.fetch(`https://drop.test/p/${site.id}/source`, {
      headers: { Cookie: 'CF_Authorization=dev' },
    })
    expect(admin.status).toBe(200)
    expect(await admin.text()).toBe('<h1>private source</h1>')
  })
})

describe('title and source name', () => {
  it('derives the title from the html <title> tag', async () => {
    const site = await upload(
      '<html><head><title>  My  Great\n Doc </title></head><body><h1>hi</h1></body></html>',
      'notes.html',
    )
    expect(site.title).toBe('My Great Doc')
    expect(site.sourceName).toBe('notes')
  })

  it('falls back to the source name when <title> is missing', async () => {
    const site = await upload('<h1>no title tag</h1>', 'plain.html')
    expect(site.title).toBe('plain')
    expect(site.sourceName).toBe('plain')
  })

  it('re-derives the title on replace and restore, keeping the source name', async () => {
    const site = await upload('<title>v1 title</title><h1>v1</h1>', 'doc.html')
    expect(site.title).toBe('v1 title')

    // Replacing with a Version that has no <title> reverts title to sourceName.
    // sourceName is not overwritten by the file name used for the replace
    const form = new FormData()
    form.append('file', new File(['<h1>v2 no title</h1>'], 'renamed.html', { type: 'text/html' }))
    const putRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}/file`, {
      method: 'PUT',
      headers: CSRF,
      body: form,
    })
    expect(putRes.status).toBe(200)
    const v2 = (await putRes.json()) as SiteMeta
    expect(v2.title).toBe('doc')
    expect(v2.sourceName).toBe('doc')

    // restore brings title back to the old Version's value along with the content
    const restoreRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: CSRF,
    })
    expect(restoreRes.status).toBe(200)
    const restored = (await restoreRes.json()) as SiteMeta
    expect(restored.title).toBe('v1 title')
    expect(restored.sourceName).toBe('doc')
  })

  it('searches by source name as well as title', async () => {
    await upload('<title>Quarterly Report</title>', 'q3-fy26.html')

    const byTitle = (await (
      await SELF.fetch('https://drop.test/api/sites?q=Quarterly', { headers: CSRF })
    ).json()) as { total: number }
    const bySourceName = (await (
      await SELF.fetch('https://drop.test/api/sites?q=q3-fy26', { headers: CSRF })
    ).json()) as { total: number }
    expect(byTitle.total).toBeGreaterThanOrEqual(1)
    expect(bySourceName.total).toBeGreaterThanOrEqual(1)
  })
})

describe('file replace and restore', () => {
  async function putFile(id: string, html: string, name = 'replace.html'): Promise<Response> {
    const form = new FormData()
    form.append('file', new File([html], name, { type: 'text/html' }))
    return SELF.fetch(`https://drop.test/api/sites/${id}/file`, {
      method: 'PUT',
      headers: CSRF,
      body: form,
    })
  }

  it('replaces content keeping id, url and published state', async () => {
    const site = await upload('<h1>v1</h1>', 'replace-target.html')
    await publish(site.id)

    const res = await putFile(site.id, '<h1>v2</h1>', 'replace-target.html')
    expect(res.status).toBe(200)
    const meta = (await res.json()) as SiteMeta
    expect(meta.id).toBe(site.id)
    expect(meta.published).toBe(true)
    expect(meta.title).toBe('replace-target')

    const raw = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await raw.text()).toContain('v2')
  })

  it('restores the previous version and swaps again on repeat', async () => {
    const site = await upload('<h1>gen1</h1>', 'restore-target.html')
    await publish(site.id)
    await putFile(site.id, '<h1>gen2</h1>')

    const restoreRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: CSRF,
    })
    expect(restoreRes.status).toBe(200)
    const raw1 = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await raw1.text()).toContain('gen1')

    // restore swaps the current Version with the saved one, so running it again goes back to gen2
    await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: CSRF,
    })
    const raw2 = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await raw2.text()).toContain('gen2')
  })

  it('reports hasHistory once a site has more than one version', async () => {
    const site = await upload('<h1>hh1</h1>', 'hashistory.html')
    expect(site.hasHistory).toBe(false)

    const getRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, { headers: CSRF })
    expect(((await getRes.json()) as SiteMeta).hasHistory).toBe(false)

    const putRes = await putFile(site.id, '<h1>hh2</h1>')
    expect(((await putRes.json()) as SiteMeta).hasHistory).toBe(true)

    const listRes = await SELF.fetch('https://drop.test/api/sites?q=hashistory', { headers: CSRF })
    const list = (await listRes.json()) as { sites: SiteMeta[] }
    expect(list.sites.find((p) => p.id === site.id)?.hasHistory).toBe(true)
  })

  it('shows the history link in admin chrome only when history exists', async () => {
    const site = await upload('<h1>pill1</h1>', 'restore-pill.html')
    await publish(site.id)
    const admin = { Cookie: 'CF_Authorization=dev' }
    const view = async () =>
      (await SELF.fetch(`https://drop.test/p/${site.id}`, { headers: admin })).text()

    expect(await view()).not.toContain(`/sites?history=`)

    await putFile(site.id, '<h1>pill2</h1>')
    expect(await view()).toContain(`/sites?history=${site.id}`)
  })

  it('returns 409 when there is nothing to restore', async () => {
    const site = await upload('<h1>fresh</h1>', 'fresh.html')
    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: CSRF,
    })
    expect(res.status).toBe(409)
  })

  it('lists versions newest first and restores a specific version', async () => {
    const site = await upload('<title>g1</title><h1>gen1</h1>', 'multi.html')
    await publish(site.id)
    await putFile(site.id, '<title>g2</title><h1>gen2</h1>')
    await putFile(site.id, '<title>g3</title><h1>gen3</h1>')

    const listRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}/versions`, {
      headers: CSRF,
    })
    expect(listRes.status).toBe(200)
    const { versions } = (await listRes.json()) as { versions: VersionMeta[] }
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])
    expect(versions.map((v) => v.title)).toEqual(['g3', 'g2', 'g1'])
    expect(versions[0]?.current).toBe(true)
    expect(versions.slice(1).every((v) => !v.current)).toBe(true)

    // restore with version 1: content and title come back, and a new Version (v4) is added
    const restoreRes = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })
    expect(restoreRes.status).toBe(200)
    expect(((await restoreRes.json()) as SiteMeta).title).toBe('g1')

    const raw = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await raw.text()).toContain('gen1')

    const after = (await (
      await SELF.fetch(`https://drop.test/api/sites/${site.id}/versions`, { headers: CSRF })
    ).json()) as { versions: VersionMeta[] }
    expect(after.versions.map((v) => v.version)).toEqual([4, 3, 2, 1])
    expect(after.versions[0]?.title).toBe('g1')
  })

  it('rejects restoring the current version or an unknown version', async () => {
    const site = await upload('<h1>rr1</h1>', 'restore-reject.html')
    await putFile(site.id, '<h1>rr2</h1>')

    const current = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2 }),
    })
    expect(current.status).toBe(409)

    const unknown = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 99 }),
    })
    expect(unknown.status).toBe(409)

    const invalid = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'x' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('serves the original of an old version inertly, with sandbox headers', async () => {
    const site = await upload('<h1>src v1</h1>', 'version-src.html')
    await putFile(site.id, '<h1>src v2</h1>')

    const res = await SELF.fetch(
      `https://drop.test/api/sites/${site.id}/versions/1/files/index.html`,
      { headers: CSRF },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe('attachment')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(await res.text()).toBe('<h1>src v1</h1>')
  })

  it('prunes versions beyond the retention cap, keeping numbering monotonic', async () => {
    const site = await upload('<h1>v1</h1>', 'prune.html')
    for (let i = 2; i <= 22; i++) {
      const res = await putFile(site.id, `<h1>v${i}</h1>`)
      expect(res.status).toBe(200)
    }

    const { versions } = (await (
      await SELF.fetch(`https://drop.test/api/sites/${site.id}/versions`, { headers: CSRF })
    ).json()) as { versions: VersionMeta[] }
    expect(versions.length).toBe(20)
    expect(versions[0]?.version).toBe(22)
    expect(versions[versions.length - 1]?.version).toBe(3)

    // A pruned Version can be neither fetched nor restored
    const gone = await SELF.fetch(
      `https://drop.test/api/sites/${site.id}/versions/1/files/index.html`,
      { headers: CSRF },
    )
    expect(gone.status).toBe(404)
  })

  it('removes version objects and rows when the site is deleted', async () => {
    const site = await upload('<h1>del v1</h1>', 'del-versions.html')
    await putFile(site.id, '<h1>del v2</h1>')

    const del = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(del.status).toBe(204)

    // R2 cleanup runs in waitUntil (async), so poll until it finishes
    let left = await env.BUCKET.list({ prefix: `versions/${site.id}/` })
    for (let i = 0; i < 20 && left.objects.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      left = await env.BUCKET.list({ prefix: `versions/${site.id}/` })
    }
    expect(left.objects.length).toBe(0)

    const gone = await SELF.fetch(`https://drop.test/api/sites/${site.id}/versions`, {
      headers: CSRF,
    })
    expect(gone.status).toBe(404)
  })

  it('returns 404 when replacing an unknown site', async () => {
    const res = await putFile('00000000-0000-4000-8000-000000000000', '<h1>x</h1>')
    expect(res.status).toBe(404)
  })

  it('rejects non-HTML replacement', async () => {
    const site = await upload('<h1>keep</h1>', 'keep.html')
    const form = new FormData()
    form.append('file', new File(['{}'], 'data.json', { type: 'application/json' }))
    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/file`, {
      method: 'PUT',
      headers: CSRF,
      body: form,
    })
    expect(res.status).toBe(400)
  })
})

describe('download', () => {
  it('serves the original bytes as a non-renderable attachment, private sites included', async () => {
    const site = await upload('<h1>dl target</h1>', 'dl-target.html')

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/download`, {
      headers: CSRF,
    })
    expect(res.status).toBe(200)
    // This surface returns HTML on the same origin, so it must not render. Do not remove this
    // assertion
    expect(res.headers.get('Content-Disposition')).toBe('attachment')
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toContain('dl target')
  })

  it('returns 404 for unknown sites', async () => {
    const res = await SELF.fetch(
      'https://drop.test/api/sites/00000000-0000-4000-8000-000000000000/download',
      { headers: CSRF },
    )
    expect(res.status).toBe(404)
  })
})

describe('llms.txt', () => {
  it('serves the theming convention publicly as plain text', async () => {
    const res = await SELF.fetch('https://drop.test/llms.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('--drop-bg')
    expect(body).toContain('color-scheme: light dark')
  })
})

describe('root', () => {
  it('redirects / to /sites', async () => {
    const res = await SELF.fetch('https://drop.test/', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sites')
  })

  it('redirects the old /pages paths to /sites, keeping the rest of the URL', async () => {
    for (const [from, to] of [
      ['/pages', '/sites'],
      ['/pages?history=abc', '/sites?history=abc'],
      ['/pages/', '/sites/'],
    ]) {
      const res = await SELF.fetch(`https://drop.test${from}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toBe(to)
    }
  })
})

describe('admin shell', () => {
  it('sets COOP on /sites to cut escaped-popup handles', async () => {
    const res = await SELF.fetch('https://drop.test/sites')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })
})
