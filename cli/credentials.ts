// Credentials for the remote. Two kinds:
// - access: a Cloudflare Access service token (CF-Access-Client-Id / Secret), for AUTH = "access"
// - token: drop's own admin token (Authorization: Bearer), for AUTH = "token"
// Stored per remote origin: in the Keychain on macOS, otherwise in a 0600 file
// ($XDG_DATA_HOME/drop/credentials.json). Config ($XDG_CONFIG_HOME) is often shared via dotfiles,
// so secrets never go there.
// DROP_ACCESS_CLIENT_ID / DROP_ACCESS_CLIENT_SECRET, or DROP_ADMIN_TOKEN, take precedence if set

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config'

export type Credential =
  | { kind: 'access'; clientId: string; clientSecret: string }
  | { kind: 'token'; token: string }

const SERVICE = 'drop-cli'
const useKeychain = process.platform === 'darwin'

const fileOf = () => join(dataDir(), 'credentials.json')

// The shape saved in stage 1 ({ clientId, clientSecret }) is read as access
function parse(raw: unknown): Credential | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'token' && typeof r.token === 'string') return { kind: 'token', token: r.token }
  if (typeof r.clientId === 'string' && typeof r.clientSecret === 'string') {
    return { kind: 'access', clientId: r.clientId, clientSecret: r.clientSecret }
  }
  return null
}

function readFileStore(): Record<string, unknown> {
  const path = fileOf()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export function loadCredential(origin: string): Credential | null {
  const env = process.env
  if (env.DROP_ACCESS_CLIENT_ID && env.DROP_ACCESS_CLIENT_SECRET) {
    return {
      kind: 'access',
      clientId: env.DROP_ACCESS_CLIENT_ID,
      clientSecret: env.DROP_ACCESS_CLIENT_SECRET,
    }
  }
  if (env.DROP_ADMIN_TOKEN) return { kind: 'token', token: env.DROP_ADMIN_TOKEN }
  if (useKeychain) {
    const r = Bun.spawnSync([
      'security',
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      origin,
      '-w',
    ])
    if (r.exitCode !== 0) return null
    return parse(JSON.parse(atob(r.stdout.toString().trim())))
  }
  return parse(readFileStore()[origin])
}

export function saveCredential(origin: string, credential: Credential): void {
  if (useKeychain) {
    // A value in the command arguments is visible to other users via ps, so pass it on the stdin
    // of security -i. Base64 keeps quotes out of it. -U overwrites an existing item
    const value = btoa(JSON.stringify(credential))
    const r = Bun.spawnSync(['security', '-i'], {
      stdin: new TextEncoder().encode(
        `add-generic-password -U -s ${SERVICE} -a "${origin}" -w ${value}\n`,
      ),
    })
    if (r.exitCode !== 0) throw new Error(`could not save to the Keychain: ${r.stderr}`)
    return
  }
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const store = { ...readFileStore(), [origin]: credential }
  writeFileSync(fileOf(), JSON.stringify(store, null, 2), { mode: 0o600 })
  chmodSync(fileOf(), 0o600)
}

// Headers to add to requests. Empty without credentials
export function authHeaders(credential: Credential | null): Record<string, string> {
  if (!credential) return {}
  if (credential.kind === 'token') return { Authorization: `Bearer ${credential.token}` }
  return {
    'CF-Access-Client-Id': credential.clientId,
    'CF-Access-Client-Secret': credential.clientSecret,
  }
}
