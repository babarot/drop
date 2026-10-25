// Admin authentication with drop's own token. It replaces Cloudflare Access and is used by
// Workers with AUTH = "token" and by drop serve (Backend in docs/glossary.md).
//
// The admin is never decided by where a request comes from (127.0.0.1 and the like): uploaded HTML
// inside the sandboxed iframe can send requests from the same place, and if treated as the admin
// it could read files of another private Site (delivery returns non-HTML files of private sites to
// the admin and adds Access-Control-Allow-Origin: *). Being the admin is decided by credentials
// alone:
//
// - CLI: sends the admin token with Authorization: Bearer
// - Browser: entering the token at /login (or, with drop serve, opening a one-time URL) sets an
//   HttpOnly, SameSite=Strict cookie. The sandboxed iframe has an opaque origin (treated as another
//   site), so the cookie is attached neither to its requests nor to top-level navigations of popups
//   that escaped it (Lax would not do)

import { getCookie, setCookie } from 'hono/cookie'
import type { AuthProvider, DropContext } from './types'

export const SESSION_COOKIE = 'drop_session'
// The minimum length of the admin token. A short token can be brute-forced, so it is treated as a
// configuration error and nobody gets in
export const MIN_TOKEN_LENGTH = 32
// There is no Access session, so the admin's View tokens get a fixed expiry (the ADR-002 order of
// "verify the signature first" stays the same)
const VIEW_SECONDS = 12 * 60 * 60
const SESSION_SECONDS = 30 * 24 * 60 * 60
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000

export interface TokenSecrets {
  // The value the CLI sends as Bearer and the browser enters on the login page
  adminToken: string
  // The secret that signs the browser cookie (the secret itself never reaches the browser).
  // Changing it logs out every browser
  sessionSecret: string
}

const encoder = new TextEncoder()

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(text))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// For equal lengths, the comparison takes the same time wherever the strings differ
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const now = () => Math.floor(Date.now() / 1000)

// The cookie value is <expiry>.<signature of expiry>. The server checks the expiry (so a copied
// cookie also stops working when it expires)
const sessionValue = async (secret: string, exp: number) =>
  `${exp}.${await hmacHex(secret, `drop-session:${exp}`)}`

// Verify the signature before looking at the expiry (the same order as View tokens). Returns the
// expiry (Unix seconds) if valid and unexpired, otherwise null
async function verifySession(secret: string, value: string | undefined): Promise<number | null> {
  if (value === undefined) return null
  const dot = value.indexOf('.')
  const exp = Number(value.slice(0, dot))
  if (dot <= 0 || !Number.isSafeInteger(exp)) return null
  if (!sameText(value, await sessionValue(secret, exp))) return null
  return exp > now() ? exp : null
}

// Whether the POST comes from the same origin as the request URL (CSRF for the form; the same
// idea as csrfGuard)
function sameOrigin(c: DropContext): boolean {
  const origin = c.req.header('Origin')
  return origin !== undefined && origin === new URL(c.req.url).origin
}

const LOGIN_PAGE = (message: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>drop</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:360px;margin:15vh auto;padding:0 16px}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:8px;margin-top:8px}
p{color:#b00}</style></head><body>
<form method="post" action="/login"><label for="token">Admin token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Log in</button></form>${message === '' ? '' : `<p>${message}</p>`}
</body></html>`

function page(c: DropContext, html: string, status: 200 | 401 | 403 | 503) {
  // A page with only a form. It has no scripts and loads nothing external, so CSP blocks everything
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(html, status)
}

export interface TokenAuth extends AuthProvider {
  // The code for the one-time login URL that drop serve prints to the terminal (only when
  // loginCodes is enabled)
  issueLoginCode(): string
}

export function tokenAuth(secrets: TokenSecrets, opts: { loginCodes?: boolean } = {}): TokenAuth {
  const configured =
    secrets.adminToken.length >= MIN_TOKEN_LENGTH &&
    secrets.sessionSecret.length >= MIN_TOKEN_LENGTH
  const codes = new Map<string, number>()

  const session = (c: DropContext) =>
    configured ? verifySession(secrets.sessionSecret, getCookie(c, SESSION_COOKIE)) : null
  const hasBearer = (c: DropContext) => {
    const header = c.req.header('Authorization')
    return configured && header !== undefined && sameText(header, `Bearer ${secrets.adminToken}`)
  }
  const startSession = async (c: DropContext) => {
    const exp = now() + SESSION_SECONDS
    setCookie(c, SESSION_COOKIE, await sessionValue(secrets.sessionSecret, exp), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: SESSION_SECONDS,
    })
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.redirect('/sites', 302)
  }

  return {
    async guardApi(c) {
      if (!configured) return c.json({ error: 'admin token is not configured' }, 503)
      if (hasBearer(c) || (await session(c)) !== null) return null
      return c.json({ error: 'unauthorized' }, 401)
    },
    apiSessionExpiry: async () => now() + VIEW_SECONDS,
    async adminSessionExpiry(c) {
      const exp = await session(c)
      return exp === null ? null : Math.min(exp, now() + VIEW_SECONDS)
    },
    issueLoginCode() {
      const code = crypto.randomUUID().replaceAll('-', '')
      codes.set(code, Date.now() + LOGIN_CODE_TTL_MS)
      return code
    },
    async loginPage(c) {
      if (!configured) return page(c, LOGIN_PAGE('The admin token is not configured'), 503)
      const code = c.req.query('code')
      if (code !== undefined && opts.loginCodes) {
        const until = codes.get(code)
        codes.delete(code)
        if (until !== undefined && until >= Date.now()) return startSession(c)
        return page(c, LOGIN_PAGE('This login URL cannot be used'), 403)
      }
      return page(c, LOGIN_PAGE(''), 200)
    },
    async loginSubmit(c) {
      if (!configured) return page(c, LOGIN_PAGE('The admin token is not configured'), 503)
      if (!sameOrigin(c)) return c.text('forbidden', 403)
      const form = await c.req.formData().catch(() => null)
      const token = form?.get('token')
      if (typeof token !== 'string' || !sameText(token, secrets.adminToken)) {
        return page(c, LOGIN_PAGE('Wrong token'), 401)
      }
      return startSession(c)
    },
    async logout(c) {
      if (!sameOrigin(c)) return c.text('forbidden', 403)
      setCookie(c, SESSION_COOKIE, '', { path: '/', maxAge: 0 })
      c.header('Cache-Control', 'no-store')
      return c.redirect('/login', 302)
    },
  }
}

// Protection against DNS rebinding (drop serve): accept only when Host is this machine itself
// (localhost / 127.0.0.1 / [::1])
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}
