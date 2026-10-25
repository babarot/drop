// Checks drop pull (cli/pull.ts) and push --force with two machines and one drop. Runs only in the
// Bun project

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { caseCollisions, plan, pullAll } from '../../cli/pull'
import { pushSite } from '../../cli/push'
import { SELF } from '../bun/cloudflare-test'
import {
  addLegacyPair,
  device,
  paths,
  read,
  remotePut,
  remoteTree,
  uniqueName,
  write,
} from './helpers'

let a: ReturnType<typeof device>
let b: ReturnType<typeof device>
let name: string

// Create and push on a, pull on b
async function shared(files: Record<string, string>): Promise<string> {
  for (const [p, body] of Object.entries(files)) write(a, `${name}/${p}`, body)
  expect(await pushSite(a, name)).toBe('created')
  expect((await pullAll(b, { only: [name] })).get(name)).toBe('cloned')
  return a.state.byDir(name)?.siteId as string
}

beforeEach(() => {
  a = device()
  b = device()
  name = uniqueName()
})

describe('pulling a site that is not here yet', () => {
  it('creates the folder with the remote tree and records the synced version', async () => {
    await shared({ 'index.html': '<title>x</title>', 'css/a.css': 'body{}' })
    expect(await read(b, `${name}/css/a.css`)).toBe('body{}')
    const synced = b.state.byDir(name)
    expect(synced?.syncedVersion).toBe(1)
    expect(synced?.syncedEntry).toBe('index.html')
    // Pushing right after pulling does nothing
    expect(await pushSite(b, name)).toBe('unchanged')
  })

  it('picks a free folder name when the name is taken by a file', async () => {
    write(a, `${name}/index.html`, 'x')
    await pushSite(a, name)
    writeFileSync(join(b.dir, name), 'a file with the same name')
    await pullAll(b, { only: [name] })
    expect(b.state.byDir(`${name}-2`)).not.toBeNull()
    expect(await read(b, `${name}-2/index.html`)).toBe('x')
  })

  it('adopts an unmapped folder with the same name, merging its files', async () => {
    write(a, `${name}/index.html`, 'remote')
    write(a, `${name}/r.css`, 'r')
    await pushSite(a, name)
    // b created a folder with the same name, and push stopped
    write(b, `${name}/index.html`, 'remote')
    write(b, `${name}/mine.txt`, 'only here')
    expect(await pushSite(b, name)).toBe('problem')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('cloned')
    expect(await read(b, `${name}/r.css`)).toBe('r')
    expect(await read(b, `${name}/mine.txt`)).toBe('only here')
    // Local-only files go out with the next push
    expect(await pushSite(b, name)).toBe('pushed')
    expect(paths(await remoteTree(b.state.byDir(name)?.siteId as string))).toEqual([
      'index.html',
      'mine.txt',
      'r.css',
    ])
  })

  it('writes both names of a legacy pair and hashes legacy objects', async () => {
    write(a, `${name}/index.html`, 'x')
    await pushSite(a, name)
    await addLegacyPair(a.state.byDir(name)?.siteId as string, '写真.png', 'png-bytes')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('cloned')
    const files = readdirSync(join(b.dir, name)).sort()
    expect(files).toContain('写真.png')
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(2)
    // The push after pulling succeeds by resending legacy Files' Objects under content addresses
    write(b, `${name}/index.html`, 'changed')
    expect(await pushSite(b, name)).toBe('pushed')
  })
})

describe('pulling changes', () => {
  it('applies remote changes when nothing changed here, including deletions', async () => {
    await shared({ 'index.html': 'v1', 'old.css': 'o', 'dir/x.txt': 'x' })
    write(a, `${name}/index.html`, 'v2')
    rmSync(join(a.dir, name, 'old.css'))
    rmSync(join(a.dir, name, 'dir'), { recursive: true })
    await pushSite(a, name)
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('updated')
    expect(await read(b, `${name}/index.html`)).toBe('v2')
    expect(existsSync(join(b.dir, name, 'old.css'))).toBe(false)
    // Directories that became empty are removed too
    expect(existsSync(join(b.dir, name, 'dir'))).toBe(false)
    expect(b.state.byDir(name)?.syncedVersion).toBe(2)
  })

  it('merges changes to different files and keeps the local ones pending', async () => {
    await shared({ 'index.html': 'v1', 'a.css': 'a', 'b.css': 'b' })
    write(a, `${name}/a.css`, 'a2')
    await pushSite(a, name)
    write(b, `${name}/b.css`, 'b2')
    // b's push stops with 409
    expect(await pushSite(b, name)).toBe('behind')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('merged')
    expect(await read(b, `${name}/a.css`)).toBe('a2')
    expect(await read(b, `${name}/b.css`)).toBe('b2')
    // The synced version is the remote's v2. The local b.css goes out with the next push
    expect(b.state.byDir(name)?.syncedVersion).toBe(2)
    expect(await pushSite(b, name)).toBe('pushed')
    const tree = await remoteTree(b.state.byDir(name)?.siteId as string)
    expect(tree.version).toBe(3)
  })

  it('does nothing when the remote has not moved', async () => {
    await shared({ 'index.html': 'v1' })
    write(b, `${name}/index.html`, 'local edit')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('unchanged')
    expect(await read(b, `${name}/index.html`)).toBe('local edit')
  })
})

describe('conflicts', () => {
  async function conflicted() {
    await shared({ 'index.html': 'v1', 'a.css': 'a' })
    write(a, `${name}/a.css`, 'remote edit')
    await pushSite(a, name)
    write(b, `${name}/a.css`, 'local edit')
    write(b, `${name}/index.html`, 'local only')
  }

  it('stops without writing anything when the same file changed on both sides', async () => {
    await conflicted()
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('conflict')
    expect(await read(b, `${name}/a.css`)).toBe('local edit')
    expect(b.state.byDir(name)?.syncedVersion).toBe(1)
    expect([...b.notify.warnings.values()].join()).toContain('a.css')
  })

  it('treats a local edit against a remote deletion as a conflict', async () => {
    await shared({ 'index.html': 'v1', 'a.css': 'a' })
    rmSync(join(a.dir, name, 'a.css'))
    await pushSite(a, name)
    write(b, `${name}/a.css`, 'local edit')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('conflict')
    expect(await read(b, `${name}/a.css`)).toBe('local edit')
  })

  it('--theirs takes the remote and backs up the local file', async () => {
    await conflicted()
    expect((await pullAll(b, { only: [name], theirs: true })).get(name)).toBe('merged')
    expect(await read(b, `${name}/a.css`)).toBe('remote edit')
    // Local-only changes that do not conflict remain
    expect(await read(b, `${name}/index.html`)).toBe('local only')
    const siteId = b.state.byDir(name)?.siteId as string
    const [stamp] = readdirSync(join(b.backupDir, siteId))
    expect(await Bun.file(join(b.backupDir, siteId, stamp as string, 'a.css')).text()).toBe(
      'local edit',
    )
  })

  it('push --force takes the local tree and keeps the remote as the previous version', async () => {
    await conflicted()
    await pullAll(b, { only: [name] })
    expect(await pushSite(b, name)).toBe('behind')
    expect(await pushSite(b, name, { force: true })).toBe('pushed')
    const siteId = b.state.byDir(name)?.siteId as string
    const tree = await remoteTree(siteId)
    expect(tree.version).toBe(3)
    expect(b.state.byDir(name)?.status).toBe('ok')
  })

  it('refuses to overwrite a local file that is ignored and untracked', async () => {
    await shared({ 'index.html': 'v1' })
    // Put .env on drop from a (as if uploaded from the admin UI; the CLI's push does not send .env,
    // so directly)
    const siteId = a.state.byDir(name)?.siteId as string
    await remotePut(siteId, '.env', 'REMOTE=1')
    write(b, `${name}/.env`, 'MY_SECRET=1')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('conflict')
    expect(await read(b, `${name}/.env`)).toBe('MY_SECRET=1')
  })

  it('refuses to write through a symlink in the path', async () => {
    await shared({ 'index.html': 'v1' })
    write(a, `${name}/sub/x.txt`, 'remote')
    await pushSite(a, name)
    const outside = join(tmpdir(), `drop-outside-${crypto.randomUUID()}`)
    mkdirSync(outside)
    symlinkSync(outside, join(b.dir, name, 'sub'))
    expect((await pullAll(b, { only: [name] })).get(name)).not.toBe('updated')
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('sites that went away', () => {
  it('detaches a site deleted on the remote and keeps the folder', async () => {
    const siteId = await shared({ 'index.html': 'v1' })
    expect(
      (
        await SELF.fetch(`https://drop.test/api/sites/${siteId}`, {
          method: 'DELETE',
          headers: { 'X-Drop-Request': '1' },
        })
      ).status,
    ).toBe(204)
    expect((await pullAll(b)).get(name)).toBe('detached')
    expect(existsSync(join(b.dir, name, 'index.html'))).toBe(true)
  })

  it('does not bring back a detached site until --include', async () => {
    await shared({ 'index.html': 'v1' })
    rmSync(join(b.dir, name), { recursive: true })
    expect(await pushSite(b, name)).toBe('detached')
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('skipped')
    expect(existsSync(join(b.dir, name))).toBe(false)
    expect((await pullAll(b, { include: [name], only: [name] })).get(name)).toBe('cloned')
    expect(await read(b, `${name}/index.html`)).toBe('v1')
  })
})

describe('the comparison itself', () => {
  it('treats absence as a value', () => {
    expect(plan({ a: '1' }, { a: '1' }, {})).toEqual({ write: [], remove: ['a'], conflicts: [] })
    expect(plan({ a: '1' }, {}, { a: '1' })).toEqual({ write: [], remove: [], conflicts: [] })
    expect(plan({ a: '1' }, {}, { a: '2' })).toEqual({ write: [], remove: [], conflicts: ['a'] })
    expect(plan({}, { a: '1' }, { a: '1' })).toEqual({ write: [], remove: [], conflicts: [] })
    expect(plan({}, { a: '1' }, { a: '2' })).toEqual({ write: [], remove: [], conflicts: ['a'] })
  })

  it('finds names that differ only by case on the merged tree', () => {
    expect(caseCollisions(['A.txt', 'b.txt', 'a.txt'])).toEqual(['A.txt and a.txt'])
    expect(caseCollisions(['x/が.txt'.normalize('NFD'), 'X/が.txt'])).toHaveLength(1)
  })
})

describe('review fixes', () => {
  it('never adopts a folder outside the sync directory through the source name', async () => {
    const id = crypto.randomUUID()
    const evil = `../escape-${id.slice(0, 8)}`
    const body = new TextEncoder().encode('<title>e</title>')
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(body)
    const sha256 = hasher.digest('hex')
    const api = { 'X-Drop-Request': '1' }
    await SELF.fetch(`https://drop.test/api/sites/${id}/objects/${sha256}`, {
      method: 'PUT',
      headers: api,
      body,
    })
    const res = await SELF.fetch(`https://drop.test/api/sites/${id}/tree`, {
      method: 'PUT',
      headers: { ...api, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: 'index.html',
        files: [{ path: 'index.html', sha256, size: body.length }],
        create: { sourceName: evil },
      }),
    })
    expect(res.status).toBe(201)
    // A folder with the same name exists outside the sync directory
    const outside = join(b.dir, evil)
    mkdirSync(outside, { recursive: true })
    await pullAll(b, { only: [evil] })
    expect(readdirSync(outside)).toEqual([])
    const s = b.state.all().find((x) => x.siteId === id)
    expect(s?.dirName.includes('/')).toBe(false)
    expect(existsSync(join(b.dir, s?.dirName as string, 'index.html'))).toBe(true)
  })

  it('keeps the file when the remote renames it by case only', async () => {
    await shared({ 'index.html': 'v1', 'A.txt': 'same' })
    rmSync(join(a.dir, name, 'A.txt'))
    write(a, `${name}/a.txt`, 'same')
    await pushSite(a, name)
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('updated')
    const files = readdirSync(join(b.dir, name))
    expect(files).toContain('a.txt')
    expect(await read(b, `${name}/a.txt`)).toBe('same')
  })

  it('stops without writing when a file changes while the remote is downloaded', async () => {
    await shared({ 'index.html': 'v1', 'a.css': 'a' })
    write(a, `${name}/a.css`, 'remote edit')
    await pushSite(a, name)
    const fetchBytes = b.client.fileBytes.bind(b.client)
    b.client.fileBytes = async (siteId, version, path) => {
      // While downloading, the user saves the same file
      write(b, `${name}/a.css`, 'saved during pull')
      return fetchBytes(siteId, version, path)
    }
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('problem')
    expect(await read(b, `${name}/a.css`)).toBe('saved during pull')
    expect(b.state.byDir(name)?.syncedVersion).toBe(1)
  })
})

describe('review fixes, round 2', () => {
  it('does not write into a folder created while the first pull downloads', async () => {
    write(a, `${name}/index.html`, 'remote')
    await pushSite(a, name)
    const fetchBytes = b.client.fileBytes.bind(b.client)
    b.client.fileBytes = async (siteId, version, path) => {
      write(b, `${name}/index.html`, 'saved meanwhile')
      return fetchBytes(siteId, version, path)
    }
    expect((await pullAll(b, { only: [name] })).get(name)).toBe('problem')
    expect(await read(b, `${name}/index.html`)).toBe('saved meanwhile')
    expect(b.state.byDir(name)).toBeNull()
  })

  it('--theirs stops when a conflicting file is saved again after its backup', async () => {
    await shared({ 'index.html': 'v1', 'a.css': 'a' })
    write(a, `${name}/a.css`, 'remote edit')
    await pushSite(a, name)
    write(b, `${name}/a.css`, 'local edit')
    const fetchBytes = b.client.fileBytes.bind(b.client)
    b.client.fileBytes = async (siteId, version, path) => {
      write(b, `${name}/a.css`, 'saved after backup')
      return fetchBytes(siteId, version, path)
    }
    expect((await pullAll(b, { only: [name], theirs: true })).get(name)).toBe('problem')
    expect(await read(b, `${name}/a.css`)).toBe('saved after backup')
  })
})

it('creates the sync directory on the first pull of a new machine', async () => {
  write(a, `${name}/index.html`, 'x')
  await pushSite(a, name)
  const fresh = device(join(tmpdir(), `drop-fresh-${crypto.randomUUID()}`, 'sync'))
  expect((await pullAll(fresh, { only: [name] })).get(name)).toBe('cloned')
  expect(await read(fresh, `${name}/index.html`)).toBe('x')
})

it('does not adopt a folder that another site already uses under a different case', async () => {
  const upper = `R${name}`
  write(a, `${upper}/index.html`, 'same')
  write(a, `${upper}/private.txt`, 'only in the private site')
  await pushSite(a, upper)
  await pullAll(b, { only: [upper] })
  // A different Site whose Source name differs only in case
  const other = device()
  const lower = upper.toLowerCase()
  write(other, `${lower}/index.html`, 'same')
  await pushSite(other, lower)
  await pullAll(b, { only: [lower] })
  const lowerId = other.state.byDir(lower)?.siteId
  const lowerState = b.state.all().find((s) => s.siteId === lowerId)
  expect(lowerState).toBeDefined()
  // The two Sites map to different folders, and the private file is not in the lowercase Site's
  // folder
  const ino = (d: string) => lstatSync(join(b.dir, d)).ino
  expect(ino(lowerState?.dirName as string)).not.toBe(ino(upper))
  expect(existsSync(join(b.dir, lowerState?.dirName as string, 'private.txt'))).toBe(false)
})
