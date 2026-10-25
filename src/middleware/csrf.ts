import { createMiddleware } from 'hono/factory'

// CSRF protection for /api. Structurally blocks fetch from uploaded HTML (a sandboxed opaque
// origin). Requiring a custom header forces a CORS preflight for cross-origin requests, and since
// the preflight is never granted, such requests physically cannot be sent.
export const CSRF_HEADER = 'X-Drop-Request'

export const csrfGuard = createMiddleware(async (c, next) => {
  if (c.req.header(CSRF_HEADER) !== '1') {
    return c.json({ error: 'forbidden' }, 403)
  }
  // When Origin is present, require it to match the request's own origin.
  // A fetch from sandboxed HTML has Origin: null, so it is rejected here
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'forbidden' }, 403)
  }
  await next()
})
