import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { faviconHrefFor } from '../../shared/favicon'
import { type Backend, type DropContext, type DropEnv, readBlob } from '../backend/types'
import { type SiteRow, sites, type VersionFileRow } from '../db/schema'
import { decodeFilePath, ENTRY_PATH, encodePath, fileHeaders, isPagePath } from '../lib/delivery'
import {
  ASCII_NAME,
  aliasGroup,
  filesOfObject,
  findAliasPairs,
  findFile,
  listFiles,
} from '../lib/files'
import { applyDropDefaults, type ForcedTheme, targetPdfLinks } from '../lib/rewrite'
import { siteHasHistory } from '../lib/versions'
import { createViewTokenUntil, verifyViewToken } from '../lib/view-token'
import { adminSessionExpiry, isAdminViewer } from '../middleware/access'
import { renderGone, renderNotFound, renderShell } from '../views/shell'

export const view = new Hono<DropEnv>()

async function findSite(backend: Backend, id: string): Promise<SiteRow | null> {
  const db = backend.db.orm
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  return row ?? null
}

// Private sites and nonexistent sites return the same 404, so nobody can tell whether a site exists
function notFound(c: DropContext) {
  return c.html(renderNotFound(faviconHrefFor(new URL(c.req.url).hostname)), 404)
}

// An expired share link. It is returned only for tokens with a valid signature, so the only
// people who learn "this site exists" are those the admin gave the link to
function gone(c: DropContext) {
  return c.html(renderGone(faviconHrefFor(new URL(c.req.url).hostname)), 410)
}

// The result of authorization. The allow variants record what let the request through (so the
// shell can decide whether to pass the received token on to the iframe or issue a new one)
type Access = 'public' | 'token' | 'admin' | 'gone' | 'deny'

// The check order is the same on all four surfaces:
//   published → token in the URL → admin cookie.
// The token comes from the query for the shell and source, and from the path (/t/:token/) for
// file delivery. An expired token yields 410 even before admin is checked: answering with the
// state of the credential in the URL is more consistent, and in development isAdminViewer always
// returns true, so checking admin first would make 410 impossible to reproduce locally.
// The admin check is lazy (no JWT is verified for public sites or valid tokens)
async function authorize(
  c: DropContext,
  row: SiteRow,
  token: string | undefined,
  admin: () => boolean | Promise<boolean>,
): Promise<Access> {
  if (row.published === 1) return 'public'
  if (token !== undefined) {
    const result = await verifyViewToken(c.var.backend.previewSecret, row.id, token)
    if (result === 'valid') return 'token'
    if (result === 'expired') return 'gone'
  }
  return (await admin()) ? 'admin' : 'deny'
}

// The URL of the file tree. The token goes in the path rather than the query, so resolving
// relative references carries it along naturally (CSS url() and URLs built by JS work
// without rewriting. ADR-004)
const filesBase = (id: string, token?: string) =>
  token === undefined
    ? `/p/${encodeURIComponent(id)}/f/`
    : `/p/${encodeURIComponent(id)}/t/${encodeURIComponent(token)}/`

view.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await findSite(c.var.backend, id)
  if (!row) return notFound(c)

  const adminUntil = await adminSessionExpiry(c)
  const isAdmin = adminUntil !== null
  const token = c.req.query('token')
  const access = await authorize(c, row, token, () => isAdmin)
  if (access === 'gone') return gone(c)
  if (access === 'deny') return notFound(c)

  // Private preview: requests from a sandboxed iframe are not guaranteed to carry cookies, so a
  // signed token goes in the path of the iframe src. Its expiry matches the admin's Access
  // session, so the admin can keep browsing for as long as the session is valid.
  // A visitor who came through a share link gets the received token passed on as is. Issuing a
  // new one here would let anyone holding the link extend its expiry just by reloading
  const iframeToken =
    access === 'public'
      ? undefined
      : access === 'token'
        ? token
        : await createViewTokenUntil(c.var.backend.previewSecret, id, adminUntil as number)
  const iframeSrc = `${filesBase(id, iframeToken)}${encodePath(row.entryPath)}`

  const nonce = crypto.randomUUID()
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  )
  // The URL of a private site carries a token, so keep it out of referrers and shared caches
  if (row.published === 1) {
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  } else {
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
  }
  // Isolate the browsing context group so that a popup that escaped the sandbox (see
  // shared/security.ts) cannot be renavigated through the opener's window handle
  c.header('Cross-Origin-Opener-Policy', 'same-origin')

  // The restore entry point only appears in the admin bar, so skip the extra query for visitors
  const hasHistory = isAdmin && (await siteHasHistory(c.var.backend, row))

  return c.html(
    renderShell({
      site: {
        id: row.id,
        title: row.title,
        sourceName: row.sourceName,
        size: row.size,
        published: row.published === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        hasHistory,
        folderId: row.folderId,
      },
      isAdmin,
      iframeSrc,
      nonce,
      // The favicon is a data URI, so it is passed with img-src data: allowed
      faviconHref: faviconHrefFor(new URL(c.req.url).hostname),
    }),
  )
})

// File tree delivery. Register these before the old routes (/:id/raw, /:id/:filename)
// (Hono matches in registration order, and /:id/f also matches /:id/:filename).
// Old asset names always have an extension, so they never collide with f / t
view.on(['GET', 'HEAD'], '/:id/t/:token/*', async (c) => {
  const segments = new URL(c.req.url).pathname.split('/')
  // /p/:id/t/:token (no trailing slash) is a directory, so redirect it to the form with /
  if (segments.length === 5)
    return redirectNoStore(c, filesBase(c.req.param('id'), c.req.param('token')))
  return serveFile(c, c.req.param('id'), c.req.param('token'), segments.slice(5).join('/'))
})

view.on(['GET', 'HEAD'], '/:id/f/*', async (c) => {
  const segments = new URL(c.req.url).pathname.split('/')
  if (segments.length === 4) return redirectNoStore(c, filesBase(c.req.param('id')))
  return serveFile(c, c.req.param('id'), undefined, segments.slice(4).join('/'))
})

// History preview: the file tree of a past version (ADR-004).
// Both the token and the version are in the path, so resolving relative references carries both.
// Past versions are shown only to the admin, even for a published site (content removed by a
// replace must not be reachable). So this does not go through authorize (which allows published
// first and also falls back to the admin cookie).
// The checks are only row → signature → expiry, and the Path lookup comes after them (404
// sameness is the same as in serveFile)
view.on(['GET', 'HEAD'], '/:id/h/:token/:version/*', async (c) => {
  const id = c.req.param('id')
  const token = c.req.param('token')
  const row = await findSite(c.var.backend, id)
  if (!row) return notFound(c)
  const result = await verifyViewToken(c.var.backend.previewSecret, id, token, 'history')
  if (result === 'expired') return gone(c)
  if (result === 'invalid') return notFound(c)

  const raw = c.req.param('version')
  if (!/^[1-9]\d{0,8}$/.test(raw)) return notFound(c)
  const segments = new URL(c.req.url).pathname.split('/')
  if (segments.length === 6) return redirectNoStore(c, `${raw}/`)
  const path = decodeFilePath(segments.slice(6).join('/'))
  if (path === null) return notFound(c)
  // The URL carries a token and the content is from the past, so even a published site gets the
  // same headers as a private one
  return serveFromTree(c, row, Number(raw), path, false)
})

// Source view (like Gist's raw). The body is the same as the Entry delivery but returned as
// text/plain, so the browser shows the source instead of rendering it.
// Access rules match the Entry (published / token), and in addition the admin can open private
// sites
view.get('/:id/source', async (c) => {
  const id = c.req.param('id')
  const row = await findSite(c.var.backend, id)
  if (!row) return notFound(c)

  const access = await authorize(c, row, c.req.query('token'), () => isAdminViewer(c))
  if (access === 'gone') return gone(c)
  if (access === 'deny') return notFound(c)

  const entry = await findFile(c.var.backend, id, row.entryPath)
  const obj = entry && (await readBlob(c.var.backend.blobs, entry.objectKey))
  if (!obj) return notFound(c)

  // text/plain + nosniff keeps it from being interpreted as HTML. sandbox is defense in depth
  c.header('Content-Security-Policy', 'sandbox')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', row.published === 1 ? 'no-cache' : 'no-store')
  return c.body(obj.body)
})

// Old routes. Redirect to the file tree for links already handed out and tabs left open.
// The redirect happens without looking up the site, so the response is the same whether the
// site exists or not (the destination decides authorization and 404). ?token= moves into the
// path and ?theme= stays in the query.
// Since the site is not looked up, this sends to the default index.html rather than the Entry
// (every site that uses the old routes is a single HTML file whose Entry is still index.html)
view.on(['GET', 'HEAD'], '/:id/raw', (c) => {
  const theme = c.req.query('theme')
  const query = theme === undefined ? '' : `?theme=${encodeURIComponent(theme)}`
  return redirectNoStore(
    c,
    `${filesBase(c.req.param('id'), c.req.query('token'))}${ENTRY_PATH}${query}`,
  )
})

view.on(['GET', 'HEAD'], '/:id/:filename', (c) => {
  // The file name goes to the destination still percent-encoded (the destination decodes it once)
  const name = new URL(c.req.url).pathname.split('/')[3] ?? ''
  return redirectNoStore(c, `${filesBase(c.req.param('id'), c.req.query('token'))}${name}`)
})

// The destination may carry a token, so keep it out of referrers and caches
function redirectNoStore(c: DropContext, location: string) {
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  return c.redirect(location, 302)
}

async function serveFile(
  c: DropContext,
  id: string,
  token: string | undefined,
  rawPath: string,
): Promise<Response> {
  const row = await findSite(c.var.backend, id)
  if (!row) return notFound(c)

  // Authorize first, look up the Path after. If the response depended on whether the Path
  // exists, the difference between a 404 for a missing Path and a 404 for a private site would
  // leak the site's existence.
  // Pages (HTML) ignore the admin cookie (a sandboxed iframe is not guaranteed to send it, and
  // nothing navigates to them directly; view raw points to /source).
  // Non-Page files accept the admin cookie, so "open in new tab" from the admin UI (a top-level
  // navigation, which sends cookies) works for private sites too
  const path = decodeFilePath(rawPath)
  const isPage = path !== null && isPagePath(path)
  const access = await authorize(c, row, token, () => !isPage && isAdminViewer(c))
  if (access === 'gone') return gone(c)
  if (access === 'deny') return notFound(c)
  if (path === null) return notFound(c)
  return serveFromTree(c, row, undefined, path, row.published === 1)
}

// Lookup in the tree and delivery, after authorization. Without version, it reads from the
// current version. published only affects the headers (caching)
async function serveFromTree(
  c: DropContext,
  row: SiteRow,
  version: number | undefined,
  path: string,
  published: boolean,
): Promise<Response> {
  const id = row.id
  const file = await findFile(c.var.backend, id, path, version)
  if (!file) {
    // Redirect a directory without a trailing slash (about) to about/. Returning
    // about/index.html directly would shift the base of that page's relative references by one
    // level. Location is relative, so both /f/ and /t/:token/ keep the same prefix
    const last = path.split('/').pop() ?? ''
    if (!path.endsWith('/index.html') && path !== 'index.html') {
      if (await findFile(c.var.backend, id, `${path}/index.html`, version)) {
        return redirectNoStore(c, `${encodeURIComponent(last)}/${new URL(c.req.url).search}`)
      }
    }
    return notFound(c)
  }
  if (file.contentType === 'text/html') return servePage(c, row, file, published)
  return serveObject(c, file, published)
}

async function servePage(
  c: DropContext,
  row: SiteRow,
  file: VersionFileRow,
  published: boolean,
): Promise<Response> {
  const obj = await readBlob(c.var.backend.blobs, file.objectKey)
  if (!obj) return notFound(c)

  // The shell's explicit theme cannot reach the sandboxed iframe (opaque origin) through
  // localStorage, so it arrives in the query. Anything other than 'dark'|'light' means unset
  // (follow the OS)
  const t = c.req.query('theme')
  const theme: ForcedTheme = t === 'dark' || t === 'light' ? t : null

  // Design injection at delivery time (defensive default CSS, a filled-in viewport, and
  // color-scheme for unstyled HTML only). The original in R2 never changes, and /source and
  // download keep returning the original
  let body = await applyDropDefaults(await obj.text(), theme)

  // Add target="_blank" to PDF links (published, private and history alike): Chrome does not
  // render PDFs inside a sandboxed frame, so send them to the proper route in a new tab
  // (allow-popups-to-escape-sandbox; see shared/security.ts). The token is in the path, so the
  // reference values are not rewritten.
  // Matching uses the Paths in the same version's file tree (old assets also have a display-name
  // Path)
  const pdfs = (await listFiles(c.var.backend, row.id, file.version)).filter(
    (f) => f.contentType === 'application/pdf',
  )
  body = await targetPdfLinks(body, {
    pdfPaths: new Set(pdfs.map((f) => f.path)),
    pagePath: file.path,
  })

  for (const [k, v] of Object.entries(fileHeaders('text/html', published))) {
    c.header(k, v)
  }
  // The body is modified at delivery time (theme, PDF links, injected CSS), so the ETag comes
  // from the modified body rather than from R2. After a deploy that changes the injection, an
  // old body must not be reused via 304
  const etag = `"${await sha256Hex(body)}"`
  c.header('ETag', etag)
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  return c.body(body)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Non-Page files. The version_files row in D1 is the source of truth for existence and
// Content-Type, and R2 is touched only by object_key. Chrome's PDF viewer sends HEAD and Range,
// so both are supported
async function serveObject(
  c: DropContext,
  file: VersionFileRow,
  published: boolean,
): Promise<Response> {
  const headers = fileHeaders(file.contentType, published)
  for (const [k, v] of Object.entries(headers)) c.header(k, v)
  // fileHeaders already makes types outside the allow list an attachment. Everything else is
  // shown inline, named after the last segment of the Path. Old assets have two Paths, the
  // canonical (ASCII) name and the display name (aliasGroup), so filename= gets the canonical name
  // and filename* (RFC 5987) the display name (browsers that support it prefer filename*, so a
  // download keeps its original non-ASCII name)
  if (headers['Content-Disposition'] === undefined) {
    const same = await filesOfObject(c.var.backend, file)
    const names = aliasGroup(same, file, await findAliasPairs(same)).map(
      (f) => f.path.split('/').pop() ?? f.path,
    )
    const ascii = names.find((n) => ASCII_NAME.test(n))
    const display = names.find((n) => n !== ascii)
    let disposition = ascii === undefined ? 'inline' : `inline; filename="${ascii}"`
    if (display !== undefined) disposition += `; filename*=UTF-8''${encodeRFC5987(display)}`
    c.header('Content-Disposition', disposition)
  }

  if (c.req.method === 'HEAD') {
    const head = await c.var.backend.blobs.head(file.objectKey)
    if (!head) return notFound(c)
    c.header('ETag', head.etag)
    c.header('Accept-Ranges', 'bytes')
    c.header('Content-Length', String(head.size))
    return c.body(null)
  }

  // Parse Range ourselves and pass an explicit range (passing Headers is interpreted differently
  // across implementations, so do not rely on it). Whether to answer 206 is also decided from the
  // request. As the spec says, an unparsable Range is ignored (200) and an unsatisfiable one is 416
  const range = parseRange(c.req.header('Range'), file.size)
  if (range === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${file.size}`)
    return c.body(null, 416)
  }

  const obj = await c.var.backend.blobs.get(file.objectKey, {
    conditional: c.req.raw.headers,
    range,
  })
  if (!obj) return notFound(c)

  c.header('ETag', obj.etag)
  c.header('Accept-Ranges', 'bytes')

  // When the condition (If-None-Match) matches, a BlobMeta without a body comes back
  if (!('body' in obj)) {
    return c.body(null, 304)
  }

  if (range) {
    const end = range.offset + range.length - 1
    c.header('Content-Range', `bytes ${range.offset}-${end}/${file.size}`)
    c.header('Content-Length', String(range.length))
    return c.body(obj.body, 206)
  }

  c.header('Content-Length', String(obj.size))
  return c.body(obj.body)
}

// Encode to RFC 5987 value-chars. Also escape the symbols outside attr-char that
// encodeURIComponent lets through (!'()*)
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

// Supports only a single range: bytes=a-b / bytes=a- / bytes=-n.
// Multiple ranges and unparsable values fall back to undefined (= the whole body with 200)
function parseRange(
  header: string | undefined,
  size: number,
): { offset: number; length: number } | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return undefined
  if (m[1] === '') {
    // suffix: the last n bytes
    const suffix = Number(m[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    const offset = Math.max(0, size - suffix)
    return { offset, length: size - offset }
  }
  const offset = Number(m[1])
  if (offset >= size) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < offset) return 'unsatisfiable'
  return { offset, length: end - offset + 1 }
}
