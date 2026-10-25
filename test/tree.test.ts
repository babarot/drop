import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_SIZE, MAX_FILES } from '../shared/files'
import type { SiteMeta } from '../src/types'
import { patchTree } from './helpers'

const CSRF = { 'X-Drop-Request': '1' }
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }

async function sha256(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function putObject(id: string, hash: string, body: string | Uint8Array): Promise<Response> {
  return SELF.fetch(`https://drop.test/api/sites/${id}/objects/${hash}`, {
    method: 'PUT',
    headers: CSRF,
    body,
  })
}

interface TreeFile {
  path: string
  body: string
}

// The flow of sending a tree (store Objects, then Commit). For the tests' sake, skip missing and
// PUT everything
async function sendTree(
  id: string,
  entry: string,
  files: TreeFile[],
  create?: { sourceName: string },
): Promise<Response> {
  const listed = []
  for (const f of files) {
    const hash = await sha256(f.body)
    const res = await putObject(id, hash, f.body)
    expect([200, 201]).toContain(res.status)
    listed.push({ path: f.path, sha256: hash, size: new TextEncoder().encode(f.body).length })
  }
  return commit(id, { entry, files: listed, create })
}

function commit(id: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

async function createTree(entry: string, files: TreeFile[]): Promise<SiteMeta> {
  const id = crypto.randomUUID()
  const res = await sendTree(id, entry, files, { sourceName: 'archive' })
  expect(res.status).toBe(201)
  return res.json()
}

async function publish(id: string): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
}

async function restore(id: string, version: number): Promise<Response> {
  return SELF.fetch(`https://drop.test/api/sites/${id}/restore`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ version }),
  })
}

async function upload(html: string, name: string): Promise<SiteMeta> {
  const form = new FormData()
  form.append('file', new File([html], name, { type: 'text/html' }))
  const res = await SELF.fetch('https://drop.test/api/sites', {
    method: 'POST',
    headers: CSRF,
    body: form,
  })
  expect(res.status).toBe(201)
  return res.json()
}

async function replace(id: string, html: string): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([html], 'x.html', { type: 'text/html' }))
  return SELF.fetch(`https://drop.test/api/sites/${id}/file`, {
    method: 'PUT',
    headers: CSRF,
    body: form,
  })
}

async function rows(id: string, version?: number) {
  const { results } = await env.DB.prepare(
    `SELECT version, path, object_key, sha256 FROM version_files WHERE site_id = ?
     AND version = coalesce(?, (SELECT max(version) FROM versions WHERE site_id = ?)) ORDER BY path`,
  )
    .bind(id, version ?? null, id)
    .all<{ version: number; path: string; object_key: string; sha256: string | null }>()
  return results
}

const exists = async (key: string) => (await env.BUCKET.head(key)) !== null

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(await check()).toBe(true)
}

const page = (title: string, extra = '') => `<title>${title}</title><h1>${title}</h1>${extra}`

describe('PUT /api/sites/:id/objects/:sha256', () => {
  it('stores verified content once, keyed by its hash', async () => {
    const id = crypto.randomUUID()
    const hash = await sha256('hello')
    expect((await putObject(id, hash, 'hello')).status).toBe(201)
    expect((await putObject(id, hash, 'hello')).status).toBe(200)
    expect(await exists(`sites/${id}/objects/${hash}`)).toBe(true)
  })

  it('rejects content that does not match the hash, writing nothing', async () => {
    const id = crypto.randomUUID()
    const hash = await sha256('expected')
    expect((await putObject(id, hash, 'tampered')).status).toBe(400)
    expect(await exists(`sites/${id}/objects/${hash}`)).toBe(false)
  })

  it('validates the site id and hash formats before touching R2', async () => {
    const hash = await sha256('x')
    expect((await putObject('not-a-uuid', hash, 'x')).status).toBe(400)
    expect((await putObject(crypto.randomUUID(), 'ABC', 'x')).status).toBe(400)
    expect((await putObject(crypto.randomUUID(), hash.toUpperCase(), 'x')).status).toBe(400)
  })

  it('answers 411 to a body without Content-Length', async () => {
    const body = new TextEncoder().encode('streamed')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(body)
        controller.close()
      },
    })
    const res = await SELF.fetch(
      `https://drop.test/api/sites/${crypto.randomUUID()}/objects/${await sha256(body)}`,
      { method: 'PUT', headers: CSRF, body: stream, duplex: 'half' } as RequestInit,
    )
    expect(res.status).toBe(411)
  })

  it('rejects bodies over the file size limit', async () => {
    const big = new Uint8Array(MAX_FILE_SIZE + 1)
    const res = await putObject(crypto.randomUUID(), await sha256(big), big)
    expect(res.status).toBe(413)
  })
})

describe('POST /api/sites/:id/objects/missing', () => {
  it('returns only the hashes the site does not have yet', async () => {
    const id = crypto.randomUUID()
    const have = await sha256('have')
    const lack = await sha256('lack')
    await putObject(id, have, 'have')
    const res = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/missing`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sha256: [have, lack] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ missing: [lack] })

    const bad = await SELF.fetch(`https://drop.test/api/sites/${id}/objects/missing`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sha256: ['nope'] }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('PUT /api/sites/:id/tree', () => {
  it('creates a site from a tree and serves every path', async () => {
    const site = await createTree('index.html', [
      { path: 'index.html', body: page('Archive', '<link rel="stylesheet" href="css/a.css">') },
      { path: 'css/a.css', body: 'body { color: red }' },
      { path: 'about/index.html', body: page('About') },
    ])
    expect(site.title).toBe('Archive')
    expect(site.sourceName).toBe('archive')
    expect(site.published).toBe(false)

    const files = await rows(site.id)
    expect(files.map((f) => f.path)).toEqual(['about/index.html', 'css/a.css', 'index.html'])
    expect(files.every((f) => f.object_key === `sites/${site.id}/objects/${f.sha256}`)).toBe(true)
    const bytes = (s: string) => new TextEncoder().encode(s).length
    expect(site.size).toBe(
      bytes(page('Archive', '<link rel="stylesheet" href="css/a.css">')) +
        bytes('body { color: red }') +
        bytes(page('About')),
    )

    await publish(site.id)
    expect(await (await SELF.fetch(`https://drop.test/p/${site.id}/f/css/a.css`)).text()).toBe(
      'body { color: red }',
    )
    expect(await (await SELF.fetch(`https://drop.test/p/${site.id}/f/about/`)).text()).toContain(
      '<h1>About</h1>',
    )
  })

  it('counts each object once in the site size', async () => {
    const body = 'same bytes'
    const site = await createTree('index.html', [
      { path: 'index.html', body: page('Size') },
      { path: 'a.txt', body },
      { path: 'copy/a.txt', body },
    ])
    const expected =
      new TextEncoder().encode(page('Size')).length + new TextEncoder().encode(body).length
    expect(site.size).toBe(expected)
  })

  it('answers 404 without create for a missing site, and 409 when create hits an existing id', async () => {
    const missing = await sendTree(crypto.randomUUID(), 'index.html', [
      { path: 'index.html', body: page('Nope') },
    ])
    expect(missing.status).toBe(404)

    const site = await createTree('index.html', [{ path: 'index.html', body: page('Once') }])
    const again = await sendTree(
      site.id,
      'index.html',
      [{ path: 'index.html', body: page('Twice') }],
      {
        sourceName: 'again',
      },
    )
    expect(again.status).toBe(409)
  })

  it('rejects invalid trees with 400', async () => {
    const site = await createTree('index.html', [{ path: 'index.html', body: page('Valid') }])
    const hash = await sha256(page('Valid'))
    const size = new TextEncoder().encode(page('Valid')).length
    const file = (path: string, extra: Partial<{ sha256: string; size: number }> = {}) => ({
      path,
      sha256: hash,
      size,
      ...extra,
    })
    const cases: [string, unknown][] = [
      ['entry not in tree', { entry: 'other.html', files: [file('index.html')] }],
      ['entry not a page', { entry: 'a.css', files: [file('index.html'), file('a.css')] }],
      ['invalid path', { entry: 'index.html', files: [file('index.html'), file('../x.css')] }],
      [
        'duplicate after NFC',
        {
          entry: 'index.html',
          files: [
            file('index.html'),
            file('é.css'.normalize('NFC')),
            file('é.css'.normalize('NFD')),
          ],
        },
      ],
      ['size mismatch', { entry: 'index.html', files: [file('index.html', { size: size + 1 })] }],
      [
        'missing object',
        {
          entry: 'index.html',
          files: [file('index.html'), file('x.css', { sha256: 'f'.repeat(64) })],
        },
      ],
      [
        'too many files',
        {
          entry: 'index.html',
          files: [
            file('index.html'),
            ...Array.from({ length: MAX_FILES }, (_, i) => file(`f/${i}.css`)),
          ],
        },
      ],
      [
        'file over the limit',
        {
          entry: 'index.html',
          files: [file('index.html'), file('big.bin', { size: MAX_FILE_SIZE + 1 })],
        },
      ],
      [
        'page over the limit',
        { entry: 'index.html', files: [file('index.html', { size: 5 * 1024 * 1024 + 1 })] },
      ],
    ]
    for (const [name, body] of cases) {
      expect((await commit(site.id, body)).status, name).toBe(400)
    }
    // None of them created a new Version
    expect((await rows(site.id)).every((r) => r.version === 1)).toBe(true)
  })

  it('replaces the whole tree: dropped files leave the new version but stay in the old one', async () => {
    const site = await createTree('index.html', [
      { path: 'index.html', body: page('One') },
      { path: 'old.css', body: 'old' },
    ])
    const res = await sendTree(site.id, 'index.html', [{ path: 'index.html', body: page('Two') }])
    expect(res.status).toBe(200)
    expect((await rows(site.id)).map((r) => r.path)).toEqual(['index.html'])
    expect((await rows(site.id, 1)).map((r) => r.path)).toEqual(['index.html', 'old.css'])

    await publish(site.id)
    expect((await SELF.fetch(`https://drop.test/p/${site.id}/f/old.css`)).status).toBe(404)
    expect((await restore(site.id, 1)).status).toBe(200)
    expect(await (await SELF.fetch(`https://drop.test/p/${site.id}/f/old.css`)).text()).toBe('old')
  })
})

describe('entry per version', () => {
  // Regression test for fatal issue 2: a previous Version can still be restored after the Entry
  // changes
  it('restores, previews and downloads versions across an entry change', async () => {
    const site = await upload(page('Legacy'), 'legacy.html')
    const res = await sendTree(site.id, 'report.html', [
      { path: 'report.html', body: page('Report') },
    ])
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).title).toBe('Report')

    const v1 = await SELF.fetch(
      `https://drop.test/api/sites/${site.id}/versions/1/files/index.html`,
      {
        headers: CSRF,
      },
    )
    expect(await v1.text()).toBe(page('Legacy'))
    const v2 = await SELF.fetch(
      `https://drop.test/api/sites/${site.id}/versions/2/files/report.html`,
      {
        headers: CSRF,
      },
    )
    expect(await v2.text()).toBe(page('Report'))

    expect((await restore(site.id, 1)).status).toBe(200)
    await publish(site.id)
    const shell = await (await SELF.fetch(`https://drop.test/p/${site.id}`)).text()
    expect(shell).toContain(`/p/${site.id}/f/index.html`)
    const download = await SELF.fetch(`https://drop.test/api/sites/${site.id}/download`, {
      headers: CSRF,
    })
    expect(await download.text()).toBe(page('Legacy'))
  })
})

describe('object safety under content addressing', () => {
  // Regression test for fatal issue 1: the same content has the same key, so deleting "the keys I
  // wrote" on failure would delete the current Version's Objects
  it('keeps the current entry when a re-upload of the same bytes fails to commit', async () => {
    const site = await upload(page('Same'), 'same.html')
    const [entry] = await rows(site.id)
    await env.DB.exec(
      "CREATE TRIGGER fail_versions BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    try {
      const res = await replace(site.id, page('Same'))
      expect(res.status).toBe(500)
    } finally {
      await env.DB.exec('DROP TRIGGER fail_versions')
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(await exists(entry?.object_key as string)).toBe(true)
  })

  it('keeps an object that a new tree reuses while the only old version pointing at it is pruned', async () => {
    const shared = 'shared asset'
    const site = await createTree('index.html', [
      { path: 'index.html', body: page('v1') },
      { path: 'shared.txt', body: shared },
    ])
    const key = `sites/${site.id}/objects/${await sha256(shared)}`
    for (let i = 2; i <= 20; i++) {
      expect(
        (await sendTree(site.id, 'index.html', [{ path: 'index.html', body: page(`v${i}`) }]))
          .status,
      ).toBe(200)
    }
    // v21 reuses the Object that only the pruned v1 pointed to
    const res = await sendTree(site.id, 'index.html', [
      { path: 'index.html', body: page('v21') },
      { path: 'shared.txt', body: shared },
    ])
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 100))
    expect(await exists(key)).toBe(true)
    expect((await rows(site.id, 1)).length).toBe(0)
  })

  it('versions assets: a replaced asset stays for old versions until they are pruned', async () => {
    const site = await upload(page('Assets'), 'assets.html')
    const putAsset = (body: string) => patchTree(site.id, { put: { 'pic.png': body } })
    expect((await putAsset('one')).status).toBe(200)
    const oldKey = (await rows(site.id)).find((r) => r.path === 'pic.png')?.object_key as string
    expect((await putAsset('two')).status).toBe(200)

    // A replace creates a new Version, and the old Version keeps pointing to the old image
    const versions = await env.DB.prepare(
      'SELECT max(version) AS v FROM versions WHERE site_id = ?',
    )
      .bind(site.id)
      .first<{ v: number }>()
    expect(versions?.v).toBe(3)
    expect((await rows(site.id, 2)).find((r) => r.path === 'pic.png')?.object_key).toBe(oldKey)
    expect(await exists(oldKey)).toBe(true)

    // Removed once the Version pointing to the old image (v2) is pruned
    for (let i = 0; i < 19; i++) expect((await replace(site.id, page(`r${i}`))).status).toBe(200)
    await eventually(async () => !(await exists(oldKey)))
  })
})
