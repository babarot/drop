// Short-lived HMAC tokens that grant temporary read access to a private site. There are two uses.
//
// 1. Preview in the admin UI: a sandboxed iframe gets an opaque origin and is not guaranteed to
//    send cookies, so private access to the file tree (/p/:id/t/:token/*) is authorized with a
//    token. The token is in the path, so relative references carry it too (ADR-004).
//    Its expiry matches the admin's Access session (while the session is valid, the admin can
//    view as the admin inside the iframe too, and both end at the same time)
// 2. Short-lived share links: show a site to someone else for 10 minutes without publishing it
//    (/p/:id?token=...)
//
// These two share one scope (view), signing `siteId.exp` (only the expiry differs).
// History preview (/p/:id/h/:token/:version/*) has a separate scope (history) and signs
// `history:siteId.exp`. So that a share link's token cannot open past versions, each token is
// invalid on the other's route (Site ids are UUIDs, so the strings never overlap).
// exp is inside the signature, so it cannot be tampered with. There is no way to revoke a token
// individually; expiring is the only revocation.
// The expiry is a fixed value set at issue time and does not extend with use

const encoder = new TextEncoder()

// For share links handed to others. Allows for the round trip of copying, pasting and the other
// person opening it
export const SHARE_TTL_SECONDS = 600

// Distinguishes a valid signature that has expired (expired) from a forgery (invalid).
// Callers turn expired into 410 and invalid into 404. This distinction only holds after the
// signature has been verified, so verifyViewToken always verifies the signature first
export type TokenResult = 'valid' | 'expired' | 'invalid'

export type TokenScope = 'view' | 'history'

const signedText = (scope: TokenScope, siteId: string, exp: number) =>
  scope === 'view' ? `${siteId}.${exp}` : `${scope}:${siteId}.${exp}`

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

function toBase64Url(buf: ArrayBuffer): string {
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

// For share links. Expires ttlSeconds after issue. ttlSeconds deliberately has no default
export async function createViewToken(
  secret: string,
  siteId: string,
  ttlSeconds: number,
): Promise<string> {
  return createViewTokenUntil(secret, siteId, Math.floor(Date.now() / 1000) + ttlSeconds)
}

// Issue with an explicit expiry (Unix seconds). The admin's preview and history preview pass the
// expiry of the Access session
export async function createViewTokenUntil(
  secret: string,
  siteId: string,
  exp: number,
  scope: TokenScope = 'view',
): Promise<string> {
  const key = await hmacKey(secret, 'sign')
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedText(scope, siteId, exp)))
  return `${exp}.${toBase64Url(sig)}`
}

export async function verifyViewToken(
  secret: string,
  siteId: string,
  token: string,
  scope: TokenScope = 'view',
): Promise<TokenResult> {
  const dot = token.indexOf('.')
  if (dot < 0) return 'invalid'
  const expStr = token.slice(0, dot)
  // Accept digits only. This stops normalization such as Number(' 300') from shifting what is
  // signed
  if (!/^\d+$/.test(expStr)) return 'invalid'
  const exp = Number(expStr)
  if (!Number.isSafeInteger(exp)) return 'invalid'
  const sig = fromBase64Url(token.slice(dot + 1))
  if (!sig) return 'invalid'

  const key = await hmacKey(secret, 'verify')
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig.slice().buffer,
    encoder.encode(signedText(scope, siteId, exp)),
  )
  // The expiry check must come after signature verification. Checking it first and returning
  // expired would let a forged token, which needs no signature, reveal whether a site with that ID
  // exists (410 if it does, 404 if not). See docs/adr/002-view-token.md
  if (!ok) return 'invalid'
  return exp < Math.floor(Date.now() / 1000) ? 'expired' : 'valid'
}
