// The shared app (the full set of routes). Each runtime's entry point (src/index.ts and others)
// puts the Backend on c.var.backend and then hands requests to this

import { Hono } from 'hono'
import themingGuide from '../docs/theming.md'
import type { DropContext, DropEnv } from './backend/types'
import { requireAdmin } from './middleware/access'
import { csrfGuard } from './middleware/csrf'
import { api } from './routes/api'
import { view } from './routes/view'

export const app = new Hono<DropEnv>()

// Protected namespace: defense in depth, verified inside the Worker as well as by Cloudflare Access
// at the edge
app.use('/api/*', csrfGuard, requireAdmin)
app.route('/api', api)

// Browser login (with authentication by drop's own token). With Access, send to /sites so the
// login happens at the edge
app.get('/login', async (c) => {
  const auth = c.var.backend.auth
  return auth.loginPage ? auth.loginPage(c) : c.redirect('/sites', 302)
})
app.post('/login', async (c) => {
  const auth = c.var.backend.auth
  return auth.loginSubmit ? auth.loginSubmit(c) : c.notFound()
})
app.post('/logout', async (c) => {
  const auth = c.var.backend.auth
  return auth.logout ? auth.logout(c) : c.notFound()
})

// Public namespace: anyone who knows the URL (private sites are 404)
app.route('/p', view)

// Public document: the theming convention for uploaded HTML (docs/theming.md is the source of
// truth as is). Meant to be handed to AI tools as "generate HTML following the convention at
// this URL"
app.get('/llms.txt', (c) => {
  c.header('Cache-Control', 'public, max-age=3600')
  return c.text(themingGuide)
})

// The root goes to the admin UI. /sites is behind Access, so unauthenticated users are asked to
// log in there
app.get('/', (c) => c.redirect('/sites'))

// Old paths. For bookmarks and tabs left open, redirect to /sites keeping the path and query
app.get('/pages', (c) => c.redirect(`/sites${new URL(c.req.url).search}`))
app.get('/pages/*', (c) => {
  const url = new URL(c.req.url)
  return c.redirect(`/sites${url.pathname.slice('/pages'.length)}${url.search}`)
})

// Admin SPA: assets are served asset-first (already protected by Access at the edge), and only
// SPA routes fall back to index.html through the Worker.
// COOP blocks renavigation through the window handle from a popup that escaped the sandbox
// (see shared/security.ts)
async function serveAppShell(c: DropContext): Promise<Response> {
  const url = new URL(c.req.url)
  url.pathname = '/sites/index.html'
  const res = await c.var.backend.assets.fetch(new Request(url.toString()))
  const withCoop = new Response(res.body, res)
  withCoop.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  return withCoop
}
app.get('/sites', serveAppShell)
app.get('/sites/*', serveAppShell)
