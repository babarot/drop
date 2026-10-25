// Checks drop's own token authentication (src/backend/token-auth.ts) over real HTTP against a drop
// on the Bun backend. The same authentication as Workers' AUTH = "token". Runs only in the Bun
// project

import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { askCredential, detectAuth } from '../../cli/login'
import { app } from '../../src/app'
import { applyMigrations, bunBackend } from '../../src/backend/bun'
import { SESSION_COOKIE, tokenAuth } from '../../src/backend/token-auth'
import type { DropEnv } from '../../src/backend/types'

const TOKEN = 't'.repeat(48)
const SECRET = 's'.repeat(48)
const API = { 'X-Drop-Request': '1' }

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function start(adminToken = TOKEN): string {
  const raw = new Database(':memory:')
  const dir = join(import.meta.dirname, '../../migrations')
  applyMigrations(
    raw,
    readdirSync(dir).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
  )
  const backend = bunBackend({
    raw,
    blobsDir: mkdtempSync(join(tmpdir(), 'drop-token-')),
    auth: tokenAuth({ adminToken, sessionSecret: SECRET }),
    assets: { fetch: async () => new Response('<!doctype html>') },
    previewSecret: 'p'.repeat(48),
  })
  const server = new Hono<DropEnv>()
  server.use('*', async (c, next) => {
    c.set('backend', backend)
    await next()
  })
  server.route('/', app)
  const bun = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: server.fetch })
  stops.push(() => bun.stop(true))
  return `http://127.0.0.1:${bun.port}`
}

async function login(url: string, token = TOKEN, origin = url) {
  return fetch(`${url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  })
}

const cookieOf = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0] as string

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('browser login', () => {
  it('shows a script-free login form', async () => {
    const url = start()
    const res = await fetch(`${url}/login`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('type="password"')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
  })

  it('sets a strict, http-only cookie for the right token and refuses a wrong one', async () => {
    const url = start()
    expect((await login(url, 'wrong')).status).toBe(401)
    const res = await login(url)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sites')
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    // http, so no Secure (Workers over https sets it)
    expect(setCookie).not.toContain('Secure')
    const cookie = cookieOf(res)
    expect((await fetch(`${url}/api/sites`, { headers: { ...API, Cookie: cookie } })).status).toBe(
      200,
    )
  })

  it('refuses a login or logout posted from another origin', async () => {
    const url = start()
    expect((await login(url, TOKEN, 'https://evil.example')).status).toBe(403)
    const res = await fetch(`${url}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('logs out by clearing the cookie', async () => {
    const url = start()
    const res = await fetch(`${url}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: url, Cookie: cookieOf(await login(url)) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  it('checks the expiry of the cookie on the server and refuses forged ones', async () => {
    const url = start()
    const past = Math.floor(Date.now() / 1000) - 60
    const expired = `${SESSION_COOKIE}=${past}.${await hmacHex(SECRET, `drop-session:${past}`)}`
    const future = Math.floor(Date.now() / 1000) + 3600
    const forged = `${SESSION_COOKIE}=${future}.${'0'.repeat(64)}`
    const otherSecret = `${SESSION_COOKIE}=${future}.${await hmacHex('x'.repeat(48), `drop-session:${future}`)}`
    for (const cookie of [expired, forged, otherSecret]) {
      expect(
        (await fetch(`${url}/api/sites`, { headers: { ...API, Cookie: cookie } })).status,
      ).toBe(401)
    }
  })
})

describe('the CLI token and misconfiguration', () => {
  it('accepts the admin token as a bearer and still needs X-Drop-Request', async () => {
    const url = start()
    const bearer = { Authorization: `Bearer ${TOKEN}` }
    expect((await fetch(`${url}/api/sites`, { headers: { ...API, ...bearer } })).status).toBe(200)
    expect((await fetch(`${url}/api/sites`, { headers: bearer })).status).toBe(403)
  })

  it('locks everyone out when the admin token is too short', async () => {
    const short = 'short-token'
    const url = start(short)
    const bearer = { Authorization: `Bearer ${short}` }
    expect((await fetch(`${url}/api/sites`, { headers: { ...API, ...bearer } })).status).toBe(503)
    expect((await login(url, short)).status).toBe(503)
  })
})

describe('drop login', () => {
  const answering = (status: number, location?: string) => async (_input: string | URL | Request) =>
    new Response(null, { status, headers: location ? { Location: location } : {} })

  it('tells Access, the admin token and no authentication apart', async () => {
    const access = answering(302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x')
    expect(await detectAuth('https://drop.example', access)).toBe('access')
    expect(await detectAuth('https://drop.example', answering(401))).toBe('token')
    const open = async () => Response.json({ sites: [], total: 0 })
    expect(await detectAuth('https://drop.example', open)).toBe('none')
    await expect(detectAuth('https://drop.example', answering(503))).rejects.toThrow(
      'no admin authentication configured',
    )
  })

  it('detects a real token-authenticated drop', async () => {
    expect(await detectAuth(start())).toBe('token')
  })

  it('asks for the credential of the detected kind', async () => {
    const answers = ['id.access', 'secret']
    const ask = async () => answers.shift() as string
    expect(await askCredential('access', ask)).toEqual({
      kind: 'access',
      clientId: 'id.access',
      clientSecret: 'secret',
    })
    expect(await askCredential('token', async () => TOKEN)).toEqual({ kind: 'token', token: TOKEN })
  })
})
