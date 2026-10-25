// The single definition of a Site file tree's Path rules, Content-Type derivation and limits
// (ADR-004). Both the server (src/lib/tree.ts) and the client (validation before Ingest) use it,
// so it lives in shared/ (the same pattern as shared/theme.ts). The server always validates
// received Paths again with this

// Limits (initial values; revisit when there is evidence)
// One Page: because it is fully buffered and modified at delivery time
export const MAX_PAGE_SIZE = 5 * 1024 * 1024
// One File: carried over from the old asset limit (20MB)
export const MAX_FILE_SIZE = 20 * 1024 * 1024
export const MAX_FILES = 1000
export const MAX_TOTAL_SIZE = 200 * 1024 * 1024

// Extension → Content-Type. The table of types delivery can handle; an extension not listed here
// is an octet-stream download (contentTypeOf). The Content-Type the client claims is never
// trusted; it always comes from this table.
// HTML (.html / .htm) is not listed here and is handled only in contentTypeOf (it is served as a
// Page with a sandbox). XML types are not listed either (scripts may run on navigation)
export const ASSET_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
}

const MAX_SEGMENT_LENGTH = 255
const MAX_PATH_LENGTH = 1024

// Rejected characters:
// - C0/C1 control characters: they break headers and logs
// - bidi control characters (U+202A-202E, U+2066-2069): visual spoofing (RTL override)
// - `\`: the Windows path separator. Browsers read it as / in some URLs, making separators
//   ambiguous
// `?` `#` `%` are allowed. Delivery (decodeFilePath in src/lib/delivery.ts) decodes each segment,
// so they can be looked up (to reference them from HTML, the author must percent-encode them)
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate deny list of control chars
const PATH_DENY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/

export type PathResult = { path: string } | { error: string }

// Normalize the input to NFC, then validate it and return the normalized value as the Path
export function normalizePath(raw: string): PathResult {
  const path = raw.normalize('NFC')
  if (path === '') return { error: 'path is empty' }
  if ([...path].length > MAX_PATH_LENGTH) {
    return { error: `path must be at most ${MAX_PATH_LENGTH} chars` }
  }
  if (PATH_DENY.test(path)) {
    return { error: 'path must not contain control, bidi or backslash chars' }
  }
  for (const segment of path.split('/')) {
    // A leading /, a trailing / and // all show up as empty segments
    if (segment === '')
      return { error: 'path must not have empty segments or a leading/trailing /' }
    if (segment === '.' || segment === '..') return { error: 'path must not contain . or ..' }
    if ([...segment].length > MAX_SEGMENT_LENGTH) {
      return { error: `path segments must be at most ${MAX_SEGMENT_LENGTH} chars` }
    }
  }
  return { path }
}

// The Content-Type comes from the extension (lowercased) of the last segment. What the client
// claims is not used.
// HTML is not added to ASSET_TYPES and is handled only here (see the comment on ASSET_TYPES).
// Anything not on the allow list is octet-stream and delivered as a sandboxed attachment
// (src/lib/delivery.ts)
export function contentTypeOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  const ext = name.slice(dot + 1).toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'text/html'
  return ASSET_TYPES[ext] ?? 'application/octet-stream'
}

export const isPageType = (contentType: string): boolean => contentType === 'text/html'

// Junk created by macOS. Dropped from directories and zips alike (shared by Ingest and CLI sync)
export const isJunk = (path: string) => {
  const segments = path.split('/')
  return segments.includes('__MACOSX') || segments[segments.length - 1] === '.DS_Store'
}

// How a new Site's Entry is chosen: index.html at the root > exactly one HTML file > undecided
// (null). When undecided, the admin UI asks the user to pick and the CLI does not sync (ADR-004)
export function pickEntry(pages: string[]): string | null {
  const root =
    pages.find((p) => p.toLowerCase() === 'index.html') ??
    pages.find((p) => p.toLowerCase() === 'index.htm')
  if (root) return root
  return pages.length === 1 ? (pages[0] as string) : null
}

// Turn a Path into its URL form (/ stays as the separator). The inverse of the Worker's
// decodeFilePath
export const encodePath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/')
