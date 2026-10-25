// Design injection into uploaded HTML at delivery time. The original in R2 never changes; this
// applies only as a modification of the Page delivery response (/p/:id/f/*) (/source and download
// keep returning the original).
// The upload limit is a few MB, so the whole document is buffered and processed in two passes:
// detect, then inject. The content and position of the injection are decided once detection is
// complete, so streaming order imposes no constraints

import { dropTokensCss } from '../../shared/theme'
import { decodeFilePath, encodePath } from './delivery'

export type ForcedTheme = 'dark' | 'light' | null

// Defensive defaults. Rules inside @layer always lose to author CSS outside layers, and :where()
// has zero specificity, so they only apply where the author did not set the same property.
// When the author also uses layers (Tailwind v4 and the like), the layer declared later wins, so
// the injection always goes at the very start of the document, making drop-defaults the first
// declared layer = the weakest
const DEFAULTS_CSS = `@layer drop-defaults {
  :where(img, video, canvas) { max-width: 100%; height: auto; }
  :where(pre) { overflow-x: auto; }
  :where(body) { overflow-wrap: break-word; }
  /* Horizontal scrolling for tables guards against broken mobile layouts, so it applies only at
     narrow widths. The display change must not spill over into desktop layouts.
     This is the one deliberate exception to the "defaults lose to the author" rule, using
     !important: if only overflow-x lost to table { overflow: hidden } for rounded corners (common
     in LLM-generated HTML), the block-ified table would be clipped and the overflowing columns
     would become completely unreachable.
     This guarantees readability rather than styling, so it takes precedence over the author.
     Note that display and overflow-x must both win together, or the mismatch where only one of
     them takes the author's value comes back.
     Do not extend this exception to purposes like "making it look nicer" */
  @media (max-width: 640px) {
    :where(table) { display: block !important; overflow-x: auto !important; max-width: 100%; }
  }
}`

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'

interface Detected {
  hasViewport: boolean
  hasHead: boolean
  hasHtml: boolean
  isStyled: boolean
}

// isStyled means "the author specified some appearance". Erring toward styled is safe (it only
// skips dark mode and breaks nothing), so the net is wide:
// besides <style> / <link rel=stylesheet>, it also covers inline style attributes and old
// presentational attributes (bgcolor and the like, common in exported HTML)
async function detect(html: string): Promise<Detected> {
  const d: Detected = { hasViewport: false, hasHead: false, hasHtml: false, isStyled: false }
  const styled = {
    element: () => {
      d.isStyled = true
    },
  }
  const rewriter = new HTMLRewriter()
    .on('html', {
      element: () => {
        d.hasHtml = true
      },
    })
    .on('head', {
      element: () => {
        d.hasHead = true
      },
    })
    .on('meta[name="viewport" i]', {
      element: () => {
        d.hasViewport = true
      },
    })
    .on('style', styled)
    .on('link[rel]', {
      element: (el) => {
        // rel may hold several space-separated values, so an exact attribute selector would miss it
        const rel = el.getAttribute('rel') ?? ''
        if (rel.toLowerCase().split(/\s+/).includes('stylesheet')) d.isStyled = true
      },
    })
    .on('*[style]', styled)
    .on('*[bgcolor]', styled)
    .on('body[text]', styled)
    .on('font[color]', styled)
  await rewriter.transform(new Response(html)).arrayBuffer()
  return d
}

function buildInjection(d: Detected, theme: ForcedTheme): string {
  const parts: string[] = []
  if (!d.hasViewport) parts.push(VIEWPORT_META)
  // The --drop-* tokens are an opt-in convention (docs/theming.md). Variables do nothing unless
  // referenced, so they are always injected into every page, styled or not
  let css = `${dropTokensCss(theme)}\n${DEFAULTS_CSS}`
  // color-scheme is for unstyled HTML only. When the author has styles, it is left alone, since
  // switching HTML that sets only a background and no text color to dark breaks it (white text on
  // a white background). theme is the shell's explicit setting (received in the query). Unset
  // means follow the OS
  if (!d.isStyled) {
    const scheme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'light dark'
    css += `\n:where(html) { color-scheme: ${scheme}; }`
  }
  parts.push(`<style>${css}</style>`)
  return parts.join('\n')
}

export async function applyDropDefaults(html: string, theme: ForcedTheme): Promise<string> {
  const d = await detect(html)
  const block = buildInjection(d, theme)

  // The injection point is also decided with HTMLRewriter (a string search would misfire on
  // tag-like strings inside comments or scripts). Preference: start of head > start of html
  if (d.hasHead || d.hasHtml) {
    const rewriter = new HTMLRewriter()
    // The explicit theme is also passed as a data-theme attribute, for pages following the
    // convention that hook into [data-theme] themselves. It may target a different element than
    // prepend, so it is registered as a separate handler
    if (theme && d.hasHtml) {
      rewriter.on('html', {
        element: (el) => {
          el.setAttribute('data-theme', theme)
        },
      })
    }
    rewriter.on(d.hasHead ? 'head' : 'html', {
      element: (el) => {
        el.prepend(block, { html: true })
      },
    })
    return await rewriter.transform(new Response(html)).text()
  }

  // A fragment with neither <head> nor <html>: right after the doctype if there is one, otherwise
  // at the start of the document. The browser folds a leading <meta>/<style> into the implicit
  // <head>. The regex is anchored to the start of the document, so it never misfires on text in
  // the body
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)
  if (doctype) {
    const end = doctype[0].length
    return html.slice(0, end) + block + html.slice(end)
  }
  return block + html
}

export interface PdfLinkTargets {
  // The set of PDF Paths in this version (old assets have both the canonical and the display name)
  pdfPaths: Set<string>
  // The Path of the HTML being rewritten, the base for relative references (defaults to
  // index.html at the Site root)
  pagePath?: string
}

// A delivery-time modification that adds target="_blank" to <a href> links to PDFs. The original
// in R2 never changes (the same contract as applyDropDefaults). Chrome refuses to render a PDF
// navigated to inline inside a sandboxed iframe, so such links always escape to a new tab via
// allow-popups-to-escape-sandbox (shared/security.ts is the source of truth).
// The reference values themselves are not rewritten (both a private site's token and a history
// preview's version are in the URL path and carry over when relative references resolve. ADR-004).
// Each reference is resolved against the Page's URL with the browser's rules, and the attribute
// is added only when it matches a PDF Path. Other origins (absolute URLs, data:, mailto: and the
// like), root-relative references, and references of only # or ? pass through untouched
export async function targetPdfLinks(html: string, opts: PdfLinkTargets): Promise<string> {
  if (opts.pdfPaths.size === 0) return html

  // Resolving references is left to the same URL rules the browser uses (collapsing ../ and ./,
  // percent-encoding non-ASCII). The origin is a placeholder used only for resolution and has
  // nothing to do with the delivery URL
  const pageUrl = new URL(encodePath(opts.pagePath ?? 'index.html'), 'https://site.invalid/')
  const isPdf = (value: string): boolean => {
    const v = value.trim()
    // Root-relative references (/x and //host/x) and ones of only # or ? are not references within
    // the Page, so leave them alone
    if (v === '' || v.startsWith('/') || v.startsWith('#') || v.startsWith('?')) return false
    let url: URL
    try {
      url = new URL(v, pageUrl)
    } catch {
      return false
    }
    if (url.origin !== pageUrl.origin) return false
    // Stored Paths are NFC, so decode segment by segment and normalize to NFC with the same rules
    // as delivery. A malformed % is not a file reference, so let it pass silently
    const path = decodeFilePath(url.pathname.slice(1))
    return path !== null && opts.pdfPaths.has(path)
  }

  const rewriter = new HTMLRewriter().on('a[href]', {
    element(el) {
      const v = el.getAttribute('href')
      if (v !== null && isPdf(v)) el.setAttribute('target', '_blank')
    },
  })
  return rewriter.transform(new Response(html)).text()
}
