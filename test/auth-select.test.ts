import { SELF } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { DropEnv } from '../src/backend/types'
import { authFor, type Env } from '../src/backend/workers'
import { requireAdmin } from '../src/middleware/access'

// How admin authentication is chosen from AUTH in wrangler.toml (authFor in src/backend/workers.ts)

const TOKEN = 'a'.repeat(40)
const SECRET = 'b'.repeat(40)

// A small app carrying only the chosen auth, to check the /api gatekeeper
function guarded(env: Partial<Env>) {
  const app = new Hono<DropEnv>()
  app.use('*', async (c, next) => {
    c.set('backend', { auth: authFor(env as Env) } as DropEnv['Variables']['backend'])
    await next()
  })
  app.use('/api/*', requireAdmin)
  app.get('/api/ping', (c) => c.text('ok'))
  return (headers: Record<string, string> = {}) =>
    app.fetch(new Request('https://drop.test/api/ping', { headers }))
}

describe('choosing the admin authentication', () => {
  it('uses Cloudflare Access when AUTH is access', async () => {
    const ping = guarded({ AUTH: 'access', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.example' })
    expect((await ping()).status).toBe(401)
    // drop's token has no effect under Access
    expect((await ping({ Authorization: `Bearer ${TOKEN}` })).status).toBe(401)
  })

  it('uses the admin token when AUTH is token', async () => {
    const ping = guarded({ AUTH: 'token', DROP_ADMIN_TOKEN: TOKEN, DROP_SESSION_SECRET: SECRET })
    expect((await ping()).status).toBe(401)
    expect((await ping({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    expect((await ping({ Authorization: 'Bearer wrong' })).status).toBe(401)
  })

  it('locks admins out when AUTH is missing, unknown, or the token is too short', async () => {
    for (const env of [
      {},
      { AUTH: 'none' },
      { AUTH: 'Token', DROP_ADMIN_TOKEN: TOKEN, DROP_SESSION_SECRET: SECRET },
      { AUTH: 'token', DROP_ADMIN_TOKEN: 'short', DROP_SESSION_SECRET: SECRET },
      { AUTH: 'token', DROP_ADMIN_TOKEN: TOKEN },
    ]) {
      const ping = guarded(env)
      expect((await ping({ Authorization: `Bearer ${TOKEN}` })).status, JSON.stringify(env)).toBe(
        503,
      )
    }
  })

  it('keeps development and test ahead of AUTH', async () => {
    expect((await guarded({ ENVIRONMENT: 'development', AUTH: 'access' })()).status).toBe(200)
    expect((await guarded({ ENVIRONMENT: 'test' })()).status).toBe(200)
  })

  it('sends GET /login to /sites when the authentication has no login form (Access)', async () => {
    const res = await SELF.fetch('https://drop.test/login', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sites')
    expect(
      (await SELF.fetch('https://drop.test/login', { method: 'POST', redirect: 'manual' })).status,
    ).toBe(404)
  })
})
