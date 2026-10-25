import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { AuthProvider, DropContext, DropEnv } from '../backend/types'

// Cloudflare Access JWT verification.
// /api/* requires verifying the Cf-Access-Jwt-Assertion header (double-checking alongside Access at
// the edge).
// On public paths (/p/:id), the admin is identified by optionally verifying the CF_Authorization
// cookie. The header is injected only on paths Access protects, so public paths can only look at
// the cookie.

// Settings of the Access application (vars in wrangler.toml)
export interface AccessConfig {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
}

interface Jwk {
  kid: string
  kty: string
  alg: string
  [key: string]: string
}

interface JwksCache {
  keys: Jwk[]
  fetchedAt: number
}

const JWKS_TTL_MS = 60 * 60 * 1000
const REFETCH_COOLDOWN_MS = 60 * 1000

let jwksCache: JwksCache | null = null
let lastForcedFetchAt = 0

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`failed to fetch JWKS: ${res.status}`)
  const body = (await res.json()) as { keys: Jwk[] }
  return body.keys
}

async function getKey(teamDomain: string, kid: string): Promise<Jwk | null> {
  const now = Date.now()
  if (!jwksCache || now - jwksCache.fetchedAt > JWKS_TTL_MS) {
    jwksCache = { keys: await fetchJwks(teamDomain), fetchedAt: now }
  }
  let key = jwksCache.keys.find((k) => k.kid === kid)
  if (!key && now - lastForcedFetchAt > REFETCH_COOLDOWN_MS) {
    // An unknown kid may mean the keys were just rotated, so fetch again.
    // There is a cooldown so forged tokens cannot trigger a flood of external fetches
    lastForcedFetchAt = now
    jwksCache = { keys: await fetchJwks(teamDomain), fetchedAt: now }
    key = jwksCache.keys.find((k) => k.kid === kid)
  }
  return key ?? null
}

function decodeSegment(seg: string): Uint8Array | null {
  try {
    const bin = atob(seg.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function decodeJson<T>(seg: string): T | null {
  const bytes = decodeSegment(seg)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

// Returns the JWT's exp (Unix seconds) if verification passes, otherwise null.
// exp is used as the expiry of the admin's View tokens (so viewing lasts as long as the Access
// session)
export async function verifyAccessJwt(env: AccessConfig, token: string): Promise<number | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts as [string, string, string]

  const header = decodeJson<{ alg?: string; kid?: string }>(h)
  if (header?.alg !== 'RS256' || !header.kid) return null

  const payload = decodeJson<{ exp?: number; aud?: string | string[]; iss?: string }>(p)
  if (!payload) return null
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < now) return null
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(env.ACCESS_AUD)
    : payload.aud === env.ACCESS_AUD
  if (!audOk) return null
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null

  const sig = decodeSegment(s)
  if (!sig) return null

  try {
    const jwk = await getKey(env.ACCESS_TEAM_DOMAIN, header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig.slice().buffer,
      new TextEncoder().encode(`${h}.${p}`),
    )
    return ok ? payload.exp : null
  } catch {
    return null
  }
}

// Access in production. /api/* uses the Cf-Access-Jwt-Assertion header (double-checking alongside
// Access at the edge), and the public side identifies the admin by the CF_Authorization cookie.
// The decision rests on the verification result, not on whether the cookie exists
export function accessAuth(env: AccessConfig): AuthProvider {
  return {
    async guardApi(c) {
      const token = c.req.header('Cf-Access-Jwt-Assertion')
      if (!token || (await verifyAccessJwt(env, token)) === null) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      return null
    },
    // Read the JWT from the same header as guardApi (the public keys are cached, so verifying
    // again is cheap)
    async apiSessionExpiry(c) {
      const token = c.req.header('Cf-Access-Jwt-Assertion')
      const exp = token === undefined ? null : await verifyAccessJwt(env, token)
      // This has passed guardApi, so it is never null. Just in case, fall back to a token that
      // expires immediately
      return exp ?? Math.floor(Date.now() / 1000)
    },
    async adminSessionExpiry(c) {
      const token = getCookie(c, 'CF_Authorization')
      if (!token) return null
      return verifyAccessJwt(env, token)
    },
  }
}

// development and test do not go through Access and have no JWT expiry, so assume a length for
// the admin session
const LOCAL_SESSION_SECONDS = 60 * 60

const localSession = () => Math.floor(Date.now() / 1000) + LOCAL_SESSION_SECONDS

// Local development (wrangler dev). There is no Access and no cookie, so it is always the admin
export const developmentAuth: AuthProvider = {
  guardApi: async () => null,
  apiSessionExpiry: async () => localSession(),
  adminSessionExpiry: async () => localSession(),
}

// Tests. To reproduce both visitors and the admin, the public side treats "a CF_Authorization
// cookie exists" as the admin
export const testAuth: AuthProvider = {
  guardApi: async () => null,
  apiSessionExpiry: async () => localSession(),
  adminSessionExpiry: async (c) => (getCookie(c, 'CF_Authorization') ? localSession() : null),
}

// When authentication is missing or misconfigured (AUTH in wrangler.toml). Nobody gets in as the
// admin
export const lockedAuth: AuthProvider = {
  guardApi: async (c) => c.json({ error: 'admin authentication is not configured' }, 503),
  apiSessionExpiry: async () => Math.floor(Date.now() / 1000),
  adminSessionExpiry: async () => null,
}

// The gatekeeper for /api/* (defense in depth: verified inside the Worker as well as by Access at
// the edge)
export const requireAdmin = createMiddleware<DropEnv>(async (c, next) => {
  const denied = await c.var.backend.auth.guardApi(c)
  if (denied) return denied
  await next()
})

// On the public side (/p/:id), the admin's session expiry (Unix seconds). null if not the admin
export const adminSessionExpiry = (c: DropContext): Promise<number | null> =>
  c.var.backend.auth.adminSessionExpiry(c)

export async function isAdminViewer(c: DropContext): Promise<boolean> {
  return (await adminSessionExpiry(c)) !== null
}

// The session expiry (Unix seconds) of an /api/* request (after passing requireAdmin)
export const apiSessionExpiry = (c: DropContext): Promise<number> =>
  c.var.backend.auth.apiSessionExpiry(c)
