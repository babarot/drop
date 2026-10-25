// The single definition of the sandbox settings that isolate uploaded HTML.
// The CSP header (Page delivery; src/lib/delivery.ts) and the iframe sandbox attribute (SSR shell
// and admin UI) apply as an intersection, so both must always use the same set of flags.
// src/types.ts depends on the Worker's binding types and cannot be imported from app, so this
// lives here, readable from both browser and server (the same pattern as shared/theme.ts).
//
// What the flags are for:
// - allow-scripts: lets scripts in uploaded HTML run (the origin is opaque, so they cannot touch
//   cookies (including the Access JWT) or the shell's DOM)
// - allow-popups + allow-popups-to-escape-sandbox: needed so <a target="_blank"> in the HTML can
//   open a PDF asset in the browser's viewer in a new tab. A popup inherits its opener's sandbox
//   flags, so without escape the PDF is not displayed and gets downloaded instead.
//   Escaping makes it possible to open an unsandboxed same-site window, but the opener has an
//   opaque origin and cannot read the popup's DOM, and state-changing /api calls require the CSRF
//   custom header, so a navigation cannot hit them. The remaining risk, renavigation through the
//   window handle, is prevented by cutting the handle with COOP: same-origin on admin surfaces and
//   asset responses. This relaxation assumes only the admin uploads (do not widen it on a whim)
// - Never add allow-same-origin (it would collapse the same-origin boundary)
const SANDBOX_FLAGS = ['allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox']

// The CSP header value for Page delivery (/p/:id/f/*, /p/:id/t/:token/*)
export const RAW_SANDBOX_CSP = `sandbox ${SANDBOX_FLAGS.join(' ')}`

// The iframe sandbox attribute value for the SSR shell and admin UI
export const IFRAME_SANDBOX = SANDBOX_FLAGS.join(' ')
