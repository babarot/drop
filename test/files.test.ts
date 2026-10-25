import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { SiteMeta } from '../src/types'
import { addFile, addLegacyPair, patchTree } from './helpers'

const CSRF = { 'X-Drop-Request': '1' }

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

async function publish(id: string): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published: true }),
  })
  expect(res.status).toBe(200)
}

async function replace(id: string, html: string): Promise<void> {
  const form = new FormData()
  form.append('file', new File([html], 'x.html', { type: 'text/html' }))
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/file`, {
    method: 'PUT',
    headers: CSRF,
    body: form,
  })
  expect(res.status).toBe(200)
}

async function restore(id: string, version?: number): Promise<void> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}/restore`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify(version === undefined ? {} : { version }),
  })
  expect(res.status).toBe(200)
}

interface FileRow {
  version: number
  path: string
  object_key: string
}

async function fileRows(id: string): Promise<FileRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT version, path, object_key FROM version_files WHERE site_id = ? ORDER BY version, path',
  )
    .bind(id)
    .all<FileRow>()
  return results
}

const paths = (rows: FileRow[], version: number) =>
  rows.filter((r) => r.version === version).map((r) => r.path)

// R2 cleanup in waitUntil is async, so wait until the condition holds
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(await check()).toBe(true)
}

const exists = async (key: string) => (await env.BUCKET.head(key)) !== null

describe('version_files', () => {
  it('writes the entry on upload and carries the other files over on replace', async () => {
    const site = await upload('<h1>v1</h1>', 'tree.html')
    expect(await fileRows(site.id)).toMatchObject([{ version: 1, path: 'index.html' }])

    await addFile(site.id, 'pic.png', 'img')
    await replace(site.id, '<h1>v2</h1>')
    const rows = await fileRows(site.id)
    expect(paths(rows, 2)).toEqual(['index.html', 'pic.png'])
    const pic = rows.filter((r) => r.path === 'pic.png').map((r) => r.object_key)
    expect(new Set(pic).size).toBe(1)
    const html = rows.filter((r) => r.path === 'index.html').map((r) => r.object_key)
    expect(new Set(html).size).toBe(2)
  })

  // Assets are part of the Version (phase 3). Adding, replacing and deleting each create a new
  // Version, and old Versions keep pointing to the files of their time
  it('versions assets: adding, swapping and removing each create a version', async () => {
    const site = await upload('<h1>v1</h1>', 'assets-versioned.html')
    await replace(site.id, '<h1>v2</h1>')

    await addFile(site.id, '図.png', 'img')
    let rows = await fileRows(site.id)
    expect(paths(rows, 2)).toEqual(['index.html'])
    expect(paths(rows, 3)).toEqual(['index.html', '図.png'])
    const before = rows.find((r) => r.version === 3 && r.path === '図.png')?.object_key as string

    await addFile(site.id, '図.png', 'img2')
    rows = await fileRows(site.id)
    const after = rows.find((r) => r.version === 4 && r.path === '図.png')?.object_key
    expect(after).not.toBe(before)
    expect(paths(rows, 3)).toEqual(['index.html', '図.png'])
    expect(await exists(before)).toBe(true)

    expect((await patchTree(site.id, { delete: ['図.png'] })).status).toBe(200)
    rows = await fileRows(site.id)
    expect(paths(rows, 5)).toEqual(['index.html'])
    expect(paths(rows, 4)).toEqual(['index.html', '図.png'])
  })

  // With content addressing, different assets with the same content point to the same Object. Do
  // not confuse them with a legacy asset's canonical name / display name pair, and deleting one
  // does not delete the other
  it('deletes one of two assets with identical bytes without touching the other', async () => {
    const site = await upload('<h1>twins</h1>', 'twins.html')
    expect((await patchTree(site.id, { put: { 'a.pdf': 'same', 'b.pdf': 'same' } })).status).toBe(
      200,
    )
    const DOC = await addLegacyPair(site.id, '資料.pdf', 'same')
    expect((await patchTree(site.id, { delete: ['a.pdf'] })).status).toBe(200)
    const rows = await fileRows(site.id)
    expect(paths(rows, Math.max(...rows.map((r) => r.version)))).toEqual(
      ['b.pdf', DOC, 'index.html', '資料.pdf'].sort(),
    )
  })

  it('restores by pointing at the old tree, without copying objects in R2', async () => {
    const site = await upload('<h1>v1</h1>', 'restore-tree.html')
    await replace(site.id, '<h1>v2</h1>')
    const listed = await env.BUCKET.list({ prefix: `versions/${site.id}/` })

    await restore(site.id, 1)
    const rows = await fileRows(site.id)
    const key = (v: number) =>
      rows.find((r) => r.version === v && r.path === 'index.html')?.object_key
    expect(key(3)).toBe(key(1))
    expect((await env.BUCKET.list({ prefix: `versions/${site.id}/` })).objects.length).toBe(
      listed.objects.length,
    )

    await publish(site.id)
    const page = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await page.text()).toContain('<h1>v1</h1>')
  })

  // Reproduce, by deleting rows, the state where a concurrent replace pruned the source before
  // restore's batch ran
  it('refuses a restore whose source was pruned meanwhile, instead of committing an empty version', async () => {
    const site = await upload('<h1>v1</h1>', 'restore-race.html')
    await replace(site.id, '<h1>v2</h1>')
    await env.DB.prepare('DELETE FROM version_files WHERE site_id = ? AND version = 1')
      .bind(site.id)
      .run()

    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}/restore`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })
    expect(res.status).toBe(409)
    const { results } = await env.DB.prepare(
      'SELECT max(version) AS v FROM versions WHERE site_id = ?',
    )
      .bind(site.id)
      .all<{ v: number }>()
    expect(results[0]?.v).toBe(2)
    await publish(site.id)
    const page = await SELF.fetch(`https://drop.test/p/${site.id}/f/index.html`)
    expect(await page.text()).toContain('<h1>v2</h1>')
  })
})

describe('pruning shared objects', () => {
  // Pruning deletes only "Objects no longer referenced by any row".
  // Deleting a Version's object_key as is would delete shared assets and HTML
  it('keeps objects still pointed at by surviving versions', async () => {
    const site = await upload('<h1>v1</h1>', 'prune-shared.html')
    for (let i = 2; i <= 20; i++) await replace(site.id, `<h1>v${i}</h1>`)
    const rows = await fileRows(site.id)
    const v1 = rows.find((r) => r.version === 1 && r.path === 'index.html')?.object_key as string
    const v2 = rows.find((r) => r.version === 2 && r.path === 'index.html')?.object_key as string

    // Exactly at the retention limit (20). Restoring the oldest, v1, prunes v1, but
    // the new v21 points to the same HTML, so the Object must remain
    await restore(site.id, 1)
    // Replacing again prunes v2, and since nothing points to v2's HTML anymore, it is deleted
    await replace(site.id, '<h1>v22</h1>')
    await eventually(async () => !(await exists(v2)))

    expect(await exists(v1)).toBe(true)
    const after = await fileRows(site.id)
    expect(after.some((r) => r.version === 1)).toBe(false)
  })
})

describe('file tree serving', () => {
  // In phase 2 there is no API to create directories, so add rows directly to check
  async function addFile(id: string, path: string, html: string): Promise<void> {
    const key = `versions/${id}/${crypto.randomUUID()}.html`
    await env.BUCKET.put(key, html)
    await env.DB.prepare(
      `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
       SELECT site_id, max(version), ?, ?, 'text/html', ? FROM versions WHERE site_id = ?`,
    )
      .bind(path, key, html.length, id)
      .run()
  }

  it('moves a directory without a trailing slash to the slashed url, keeping the prefix and query', async () => {
    const site = await upload('<h1>root</h1>', 'dirs.html')
    await addFile(site.id, 'about/index.html', '<h1>about</h1>')
    const token = (
      (await (
        await SELF.fetch(`https://drop.test/api/sites/${site.id}/preview-url`, { headers: CSRF })
      ).json()) as { url: string }
    ).url.match(/\/t\/([^/]+)\//)?.[1]

    const base = `https://drop.test/p/${site.id}/t/${token}/`
    const res = await SELF.fetch(`${base}about?theme=dark`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('Location') as string, `${base}about`).href).toBe(
      `${base}about/?theme=dark`,
    )
    const page = await SELF.fetch(`${base}about/`)
    expect(await page.text()).toContain('<h1>about</h1>')
    // A nonexistent directory is not redirected; 404
    expect((await SELF.fetch(`${base}nothere`, { redirect: 'manual' })).status).toBe(404)
  })

  it('points the shell, preview url and source at the entry path', async () => {
    const site = await upload('<h1>root</h1>', 'entry-path.html')
    await addFile(site.id, 'docs/start.html', '<h1>start</h1>')
    await env.DB.prepare("UPDATE sites SET entry_path = 'docs/start.html' WHERE id = ?")
      .bind(site.id)
      .run()
    await publish(site.id)

    const shell = await (await SELF.fetch(`https://drop.test/p/${site.id}`)).text()
    expect(shell).toContain(`/p/${site.id}/f/docs/start.html`)
    const { url } = (await (
      await SELF.fetch(`https://drop.test/api/sites/${site.id}/preview-url`, { headers: CSRF })
    ).json()) as { url: string }
    expect(url).toBe(`/p/${site.id}/f/docs/start.html`)
    const source = await SELF.fetch(`https://drop.test/p/${site.id}/source`)
    expect(await source.text()).toBe('<h1>start</h1>')
  })
})
