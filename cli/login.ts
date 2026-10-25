// drop login: ask for the remote's credentials and save them. Which kind is needed is told by the
// response to a request without credentials (a 302 to the Access login means a service token, a 401
// means drop's admin token)

import { ApiError, DropClient, type Fetch } from './client'
import type { Credential } from './credentials'

export type RemoteAuth = 'access' | 'token' | 'none'

export async function detectAuth(remote: string, fetchImpl?: Fetch): Promise<RemoteAuth> {
  // Going through DropClient adds X-Drop-Request (without it, a drop with AUTH = "token" returns
  // csrfGuard's 403)
  const client = new DropClient(remote, {}, fetchImpl)
  try {
    await client.sitesBySourceName('')
    return 'none'
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    if (e.status >= 300 && e.status < 400) return 'access'
    if (e.status === 401) return 'token'
    if (e.status === 503) throw new Error(`${remote} has no admin authentication configured`)
    throw e
  }
}

// Read one line without echoing it (when not a terminal, just read one line)
export async function readSecret(label: string): Promise<string> {
  process.stdout.write(label)
  const stdin = process.stdin
  if (!stdin.isTTY) {
    for await (const line of console) return line.trim()
    return ''
  }
  return new Promise((resolve, reject) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    const done = (result: string | Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      if (result instanceof Error) reject(result)
      else resolve(result.trim())
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(value)
        if (ch === '\u0003') return done(new Error('interrupted'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

export async function askCredential(
  kind: Exclude<RemoteAuth, 'none'>,
  ask: (label: string) => Promise<string> = readSecret,
): Promise<Credential> {
  if (kind === 'token') {
    const token = await ask('Admin token: ')
    if (token === '') throw new Error('empty input')
    return { kind: 'token', token }
  }
  const clientId = await ask('Client ID: ')
  const clientSecret = await ask('Client Secret: ')
  if (clientId === '' || clientSecret === '') throw new Error('empty input')
  return { kind: 'access', clientId, clientSecret }
}
