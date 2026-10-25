// Checks drop serve (cli/serve.ts, src/backend/token-auth.ts) over real HTTP. Runs only in the Bun
// project

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DropClient } from '../../cli/client'
import { pushSite } from '../../cli/push'
import { cliTokenPath, type LocalServer, startServer } from '../../cli/serve'
import { State } from '../../cli/state'
import { isLocalHost, SESSION_COOKIE } from '../../src/backend/token-auth'

const API = { 'X-Drop-Request': '1' }

let server: LocalServer | null = null
let dataDir: string

function start(dir = mkdtempSync(join(tmpdir(), 'drop-serve-'))): LocalServer {
  dataDir = dir
  server = startServer({ dataDir: dir, port: 0 })
  return server
}

afterEach(() => {
  server?.stop()
  server = null
})

const bearer = () => ({ Authorization: `Bearer ${readFileSync(cliTokenPath(dataDir), 'utf8')}` })

async function login(s: LocalServer): Promise<string> {
  const res = await fetch(`${s.url}/login?code=${s.auth.issueLoginCode()}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const cookie = res.headers.get('Set-Cookie') ?? ''
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';')[0] as string
}

// Create a private Site with an Entry and an image via the CLI's push
async function pushDemo(s: LocalServer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'drop-serve-sync-'))
  mkdirSync(join(dir, 'demo'))
  writeFileSync(join(dir, 'demo', 'index.html'), '<title>Demo</title><img src="dot.svg">')
  writeFileSync(join(dir, 'demo', 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const ctx = {
    client: new DropClient(s.url, bearer()),
    state: new State(':memory:'),
    dir,
    notify: { warn() {}, clear() {}, info() {} },
    backupDir: mkdtempSync(join(tmpdir(), 'drop-serve-backup-')),
  }
  expect(await pushSite(ctx, 'demo')).toBe('created')
  return ctx.state.byDir('demo')?.siteId as string
}

describe('authentication', () => {
  it('refuses the API without credentials and accepts the CLI token', async () => {
    const s = start()
    expect((await fetch(`${s.url}/api/sites`, { headers: API })).status).toBe(401)
    expect((await fetch(`${s.url}/api/sites`, { headers: { ...API, ...bearer() } })).status).toBe(
      200,
    )
    const wrong = { Authorization: 'Bearer nope' }
    expect((await fetch(`${s.url}/api/sites`, { headers: { ...API, ...wrong } })).status).toBe(401)
  })

  it('logs the browser in once per code with a strict, http-only cookie', async () => {
    const s = start()
    const code = s.auth.issueLoginCode()
    const first = await fetch(`${s.url}/login?code=${code}`, { redirect: 'manual' })
    expect(first.status).toBe(302)
    expect(first.headers.get('Location')).toBe('/sites')
    const again = await fetch(`${s.url}/login?code=${code}`, { redirect: 'manual' })
    expect(again.status).toBe(403)
    const cookie = (first.headers.get('Set-Cookie') ?? '').split(';')[0] as string
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(
      (await fetch(`${s.url}/api/sites`, { headers: { ...API, Cookie: cookie } })).status,
    ).toBe(200)
  })

  it('still needs X-Drop-Request with the cookie (CSRF)', async () => {
    const s = start()
    const cookie = await login(s)
    expect((await fetch(`${s.url}/api/sites`, { headers: { Cookie: cookie } })).status).toBe(403)
  })

  it('answers 403 to a Host other than this machine (DNS rebinding)', async () => {
    const s = start()
    const res = await fetch(`${s.url}/llms.txt`, { headers: { Host: 'evil.example' } })
    expect(res.status).toBe(403)
    expect(isLocalHost('127.0.0.1:8789')).toBe(true)
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('[::1]:8789')).toBe(true)
    expect(isLocalHost('127.0.0.1.evil.example')).toBe(false)
    expect(isLocalHost(undefined)).toBe(false)
  })
})

describe('serving', () => {
  it('does not treat a request without the cookie as the admin, even from this machine', async () => {
    const s = start()
    const id = await pushDemo(s)
    // Requests from a sandboxed iframe carry no cookie. From there, another private Site's files
    // must not be readable
    expect((await fetch(`${s.url}/p/${id}/f/dot.svg`)).status).toBe(404)
    expect((await fetch(`${s.url}/p/${id}`)).status).toBe(404)
    const cookie = await login(s)
    // The admin can open non-HTML files ("open in new tab" in the admin UI). Pages still require a
    // token
    expect(
      (await fetch(`${s.url}/p/${id}/f/dot.svg`, { headers: { Cookie: cookie } })).status,
    ).toBe(200)
    expect(
      (await fetch(`${s.url}/p/${id}/f/index.html`, { headers: { Cookie: cookie } })).status,
    ).toBe(404)
    const shell = await fetch(`${s.url}/p/${id}`, { headers: { Cookie: cookie } })
    expect(shell.status).toBe(200)
    const src = (await shell.text()).match(/src="(\/p\/[^"]+\/t\/[^"]+)"/)?.[1]
    expect(src).toBeDefined()
    const page = await fetch(`${s.url}${src}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(page.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin')
  })

  it('serves the admin app, its assets and llms.txt', async () => {
    const s = start()
    expect((await fetch(`${s.url}/llms.txt`)).status).toBe(200)
    expect((await fetch(`${s.url}/llms.txt`).then((r) => r.text())).length).toBeGreaterThan(100)
    const shell = await fetch(`${s.url}/sites`)
    expect(shell.status).toBe(200)
    const asset = (await shell.text()).match(/\/sites\/assets\/[^"]+\.js/)?.[0]
    expect(asset).toBeDefined()
    expect((await fetch(`${s.url}${asset}`)).status).toBe(200)
  })

  it('keeps data and the browser session across restarts, with secrets readable only by the user', async () => {
    const s = start()
    const id = await pushDemo(s)
    const cookie = await login(s)
    s.stop()
    server = null
    const again = start(dataDir)
    const res = await fetch(`${again.url}/api/sites/${id}`, { headers: { ...API, Cookie: cookie } })
    expect(res.status).toBe(200)
    for (const name of ['cli-token', 'session-secret', 'preview-secret']) {
      expect(statSync(join(dataDir, name)).mode & 0o077).toBe(0)
    }
  })
})
