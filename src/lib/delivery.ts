// Path parsing and security header decisions for file tree delivery (/p/:id/f/*,
// /p/:id/t/:token/*). HTML is served on the same origin, so every header decision lives in this
// one place (ADR-004). Delivery routes only attach the headers returned here and must never add or
// remove CSP on their own

import { ASSET_TYPES } from '../../shared/files'
import { RAW_SANDBOX_CSP } from '../../shared/security'

// The Content-Types, determined by extension, that delivery can handle. HTML is not in
// ASSET_TYPES (allowing HTML through the asset path would serve it outside the sandbox), so it is
// added only here
const SERVABLE_TYPES = new Set([...Object.values(ASSET_TYPES), 'text/html'])

// Turn the part of a delivery URL after the Site root (still percent-encoded) into a Path in the
// same form as stored. Anything unparsable is null (404 at the caller).
// Hono's decoding is like decodeURI and leaves %3F %23 %2F and the like, so decodeURIComponent is
// applied segment by segment to the raw pathname. Stored Paths are NFC, so normalize to NFC.
// An empty Path and a Path ending in / are directories, and index.html is filled in
export function decodeFilePath(raw: string): string | null {
  const segments = raw.split('/')
  const out: string[] = []
  for (const [i, seg] of segments.entries()) {
    if (seg === '') {
      // Only a trailing empty segment means a directory. An empty one in the middle (a//b) is
      // rejected
      if (i !== segments.length - 1) return null
      out.push('index.html')
      break
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      return null
    }
    // %2F must not turn into a separator. . and .. should be gone after URL resolution, so reject
    // them if they arrive
    if (decoded.includes('/') || decoded === '.' || decoded === '..') return null
    out.push(decoded.normalize('NFC'))
  }
  return out.join('/')
}

export const isPagePath = (path: string): boolean => /\.html?$/i.test(path)

// The default Entry of a new Site (same as the DEFAULT of sites.entry_path)
export const ENTRY_PATH = 'index.html'

// Putting a Path into a URL (the inverse of decodeFilePath) is also used by the SPA, so it lives
// in shared
export { encodePath } from '../../shared/files'

// Security headers and Content-Type for a delivered file. contentType must be the value the server
// determined from the extension (not what the client claimed).
// - HTML: RAW_SANDBOX_CSP (scripts allowed, no allow-same-origin; shared/security.ts is the source
//   of truth)
// - PDF: the only exception without a CSP, because Chrome does not display a sandboxed top-level
//   PDF and downloads it instead. JS inside the PDF viewer (PDFium) cannot touch the DOM/origin,
//   and only the admin uploads, so this is acceptable. Do not extend this exception to other types
// - Everything else: sandbox (defense in depth that gives an opaque origin on navigation; also
//   covers svg)
// - Types that cannot be handled: application/octet-stream + attachment, so the browser never
//   interprets them
export function fileHeaders(contentType: string, published: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Cut the handle so a popup that escaped the sandbox cannot be renavigated from its opener
    // (see shared/security.ts). Especially important for PDFs, which are returned without a CSP
    'Cross-Origin-Opener-Policy': 'same-origin',
    // A sandboxed iframe has an opaque origin, so @font-face, module scripts and fetch() need CORS.
    // Published sites are public anyway and private ones are protected by the token in the URL,
    // so * is fine
    'Access-Control-Allow-Origin': '*',
    // Published files are also revalidated every time (304 via ETag). With max-age, reopening right
    // after a replace or restore would keep showing the old content. Private ones carry a token in
    // the URL, so they are not stored
    'Cache-Control': published ? 'no-cache' : 'no-store',
  }
  if (!SERVABLE_TYPES.has(contentType)) {
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Security-Policy'] = 'sandbox'
    headers['Content-Disposition'] = 'attachment'
    return headers
  }
  if (contentType === 'text/html') {
    // This CSP sandbox header is the keystone of the same-origin boundary. It gives uploaded HTML
    // an opaque origin, isolating it from cookies (including the Access JWT) and the DOM. Never
    // remove it
    headers['Content-Security-Policy'] = RAW_SANDBOX_CSP
    headers['Content-Type'] = 'text/html; charset=utf-8'
    return headers
  }
  if (contentType !== 'application/pdf') {
    headers['Content-Security-Policy'] = 'sandbox'
  }
  // Only text types get an explicit charset (it means nothing on binary, so it is left off)
  headers['Content-Type'] =
    contentType.startsWith('text/') || contentType === 'application/json'
      ? `${contentType}; charset=utf-8`
      : contentType
  return headers
}
