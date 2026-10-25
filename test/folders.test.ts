import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { FolderMeta, SiteMeta } from '../src/types'

const CSRF = { 'X-Drop-Request': '1' }
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' }

async function upload(html = '<h1>hello</h1>', name = 'test.html'): Promise<SiteMeta> {
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

async function createFolder(name: string): Promise<FolderMeta> {
  const res = await SELF.fetch('https://drop.test/api/folders', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  return res.json()
}

async function listFolders(): Promise<{ folders: FolderMeta[]; unfiledCount: number }> {
  const res = await SELF.fetch('https://drop.test/api/folders', { headers: CSRF })
  expect(res.status).toBe(200)
  return res.json()
}

async function listSites(params = ''): Promise<{ sites: SiteMeta[]; total: number }> {
  const res = await SELF.fetch(`https://drop.test/api/sites${params}`, { headers: CSRF })
  expect(res.status).toBe(200)
  return res.json()
}

async function moveSite(id: string, folderId: string | null): Promise<SiteMeta> {
  const res = await SELF.fetch(`https://drop.test/api/sites/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ folderId }),
  })
  expect(res.status).toBe(200)
  return res.json()
}

describe('folders CRUD', () => {
  it('creates, lists, renames, reorders and deletes folders', async () => {
    const a = await createFolder('alpha')
    const b = await createFolder('beta')
    expect(a.position).toBe(0)
    expect(b.position).toBe(1)
    expect(a.siteCount).toBe(0)

    const list = await listFolders()
    expect(list.folders.map((f) => f.name)).toEqual(['alpha', 'beta'])

    const renameRes = await SELF.fetch(`https://drop.test/api/folders/${a.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'alpha2' }),
    })
    expect(renameRes.status).toBe(200)
    expect(((await renameRes.json()) as FolderMeta).name).toBe('alpha2')

    // Swapping position changes the list order
    await SELF.fetch(`https://drop.test/api/folders/${a.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ position: 1 }),
    })
    await SELF.fetch(`https://drop.test/api/folders/${b.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ position: 0 }),
    })
    const reordered = await listFolders()
    expect(reordered.folders.map((f) => f.name)).toEqual(['beta', 'alpha2'])

    const delRes = await SELF.fetch(`https://drop.test/api/folders/${a.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(delRes.status).toBe(204)
    const delGone = await SELF.fetch(`https://drop.test/api/folders/${a.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(delGone.status).toBe(404)
  })

  it('rejects empty and duplicate folder names', async () => {
    const empty = await SELF.fetch('https://drop.test/api/folders', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: '  ' }),
    })
    expect(empty.status).toBe(400)

    await createFolder('dup')
    const dup = await SELF.fetch('https://drop.test/api/folders', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'dup' }),
    })
    expect(dup.status).toBe(409)

    // A duplicate on rename is also 409
    const other = await createFolder('other')
    const renameDup = await SELF.fetch(`https://drop.test/api/folders/${other.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'dup' }),
    })
    expect(renameDup.status).toBe(409)
  })

  it('moves contained sites back to unfiled when a folder is deleted', async () => {
    const folder = await createFolder('doomed')
    const site = await upload('<p>in folder</p>', 'doomed-site.html')
    await moveSite(site.id, folder.id)

    expect((await listFolders()).folders.find((f) => f.id === folder.id)?.siteCount).toBe(1)

    const delRes = await SELF.fetch(`https://drop.test/api/folders/${folder.id}`, {
      method: 'DELETE',
      headers: CSRF,
    })
    expect(delRes.status).toBe(204)

    // The site is not deleted; it goes back to unfiled
    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, { headers: CSRF })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SiteMeta).folderId).toBeNull()
  })
})

describe('site folder assignment', () => {
  it('moves a site via PATCH folderId without bumping updatedAt', async () => {
    const folder = await createFolder('dest')
    const site = await upload('<p>mv</p>', 'mv.html')
    expect(site.folderId).toBeNull()

    const moved = await moveSite(site.id, folder.id)
    expect(moved.folderId).toBe(folder.id)
    // Moving between folders is an organizing action, so it does not advance updatedAt
    expect(moved.updatedAt).toBe(site.updatedAt)

    const back = await moveSite(site.id, null)
    expect(back.folderId).toBeNull()
  })

  it('rejects moving to a nonexistent folder', async () => {
    const site = await upload('<p>orphan</p>', 'orphan.html')
    const res = await SELF.fetch(`https://drop.test/api/sites/${site.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ folderId: 'no-such-folder' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts folderId on upload and rejects unknown folders', async () => {
    const folder = await createFolder('inbox')
    const form = new FormData()
    form.append('file', new File(['<p>direct</p>'], 'direct.html', { type: 'text/html' }))
    form.append('folderId', folder.id)
    const res = await SELF.fetch('https://drop.test/api/sites', {
      method: 'POST',
      headers: CSRF,
      body: form,
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as SiteMeta).folderId).toBe(folder.id)

    const bad = new FormData()
    bad.append('file', new File(['<p>x</p>'], 'bad.html', { type: 'text/html' }))
    bad.append('folderId', 'no-such-folder')
    const badRes = await SELF.fetch('https://drop.test/api/sites', {
      method: 'POST',
      headers: CSRF,
      body: bad,
    })
    expect(badRes.status).toBe(400)
  })
})

describe('site list filters', () => {
  it('filters by folder, unfiled, and combines with q', async () => {
    const folder = await createFolder('work')
    const inFolder = await upload('<title>report a</title><p>1</p>', 'report-a.html')
    await moveSite(inFolder.id, folder.id)
    const unfiled = await upload('<title>report b</title><p>2</p>', 'report-b.html')

    const byFolder = await listSites(`?folder=${folder.id}`)
    expect(byFolder.sites.map((p) => p.id)).toEqual([inFolder.id])
    expect(byFolder.total).toBe(1)

    // Storage is shared by the tests in the same file, so tolerate sites from other tests
    const byUnfiled = await listSites('?folder=unfiled')
    const unfiledIds = byUnfiled.sites.map((p) => p.id)
    expect(unfiledIds).toContain(unfiled.id)
    expect(unfiledIds).not.toContain(inFolder.id)

    // Narrow with AND on q (the folder has report a but not b)
    const combined = await listSites(`?folder=${folder.id}&q=report`)
    expect(combined.sites.map((p) => p.id)).toEqual([inFolder.id])
    const miss = await listSites(`?folder=${folder.id}&q=nothing`)
    expect(miss.total).toBe(0)

    // The unfiled count matches the total of the unfiled filter
    expect((await listFolders()).unfiledCount).toBe(byUnfiled.total)
  })

  it('finds same-source-name sites beyond the default list limit via ?sourceName=', async () => {
    // Create the match target first, then add 55 fillers to push it out of the first 50 in the list
    const target = await upload('<p>original</p>', 'target.html')
    for (let i = 0; i < 55; i++) {
      await upload(`<p>filler ${i}</p>`, `filler-${i}.html`)
    }

    // It does not appear in the normal list (createdAt desc, limit 50)
    const firstPage = await listSites()
    expect(firstPage.sites.some((p) => p.id === target.id)).toBe(false)

    // The dedicated exact-sourceName path finds it (regression test for the 50-item cap bug in
    // re-drop matching)
    const matches = await listSites('?sourceName=target')
    expect(matches.sites.map((p) => p.id)).toEqual([target.id])

    // No partial match (exact match only)
    const partial = await listSites('?sourceName=targ')
    expect(partial.total).toBe(0)
  })
})
