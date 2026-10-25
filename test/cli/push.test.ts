// Checks drop push (cli/push.ts) against a drop on the Bun backend. Runs only in the Bun project
// (vitest.bun.config.ts). The drop on the other end is SELF from test/bun/cloudflare-test.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { pushAll, pushSite, resolveDir } from '../../cli/push'
import { Ignore, type LocalFile, readSnapshot, scanSite } from '../../cli/scan'
import type { State } from '../../cli/state'
import { startWatch } from '../../cli/watch'
import { device, paths, remoteTree, uniqueName, write } from './helpers'

let ctx: ReturnType<typeof device>
let name: string
beforeEach(() => {
  ctx = device()
  name = uniqueName()
})

describe('pushing a new folder', () => {
  it('creates a site named after the folder and records the synced version', async () => {
    write(ctx, `${name}/index.html`, '<title>Hello</title>')
    write(ctx, `${name}/css/a.css`, 'body{}')
    expect(await pushSite(ctx, name)).toBe('created')
    const synced = ctx.state.byDir(name)
    expect(synced?.syncedVersion).toBe(1)
    expect(synced?.syncedEntry).toBe('index.html')
    const tree = await remoteTree(synced?.siteId as string)
    expect(paths(tree)).toEqual(['css/a.css', 'index.html'])
  })

  it('does nothing when the folder has not changed', async () => {
    write(ctx, `${name}/index.html`, 'x')
    await pushSite(ctx, name)
    expect(await pushSite(ctx, name)).toBe('unchanged')
    expect((await remoteTree(ctx.state.byDir(name)?.siteId as string)).version).toBe(1)
  })

  it('refuses a folder whose entry cannot be decided', async () => {
    write(ctx, `${name}/a.html`, 'a')
    write(ctx, `${name}/b.html`, 'b')
    expect(await pushSite(ctx, name)).toBe('problem')
    expect(ctx.state.byDir(name)).toBeNull()
  })

  it('refuses to create a second site with the same name made elsewhere', async () => {
    const other = device()
    write(other, `${name}/index.html`, 'from the other machine')
    expect(await pushSite(other, name)).toBe('created')
    write(ctx, `${name}/index.html`, 'here')
    expect(await pushSite(ctx, name)).toBe('problem')
    expect([...ctx.notify.warnings.values()].join()).toContain('drop pull')
  })

  it('warns about files directly in the sync directory and does not push them', async () => {
    write(ctx, 'loose.html', 'x')
    const results = await pushAll(ctx)
    expect(results.has('loose.html')).toBe(false)
    expect(ctx.notify.warnings.get('file:loose.html')).toBeDefined()
  })
})

describe('pushing changes', () => {
  it('pushes a change as a new version based on the synced version', async () => {
    write(ctx, `${name}/index.html`, 'v1')
    await pushSite(ctx, name)
    write(ctx, `${name}/index.html`, 'v2')
    write(ctx, `${name}/b.png`, new Uint8Array([1, 2, 3]))
    expect(await pushSite(ctx, name)).toBe('pushed')
    expect(ctx.state.byDir(name)?.syncedVersion).toBe(2)
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual([
      'b.png',
      'index.html',
    ])
  })

  it('stops with 409 instead of overwriting when the remote moved on', async () => {
    write(ctx, `${name}/index.html`, 'v1')
    await pushSite(ctx, name)
    const siteId = ctx.state.byDir(name)?.siteId as string
    // Another machine (holding the same v1 as its synced version) commits v2 first
    const other = device()
    write(other, `${name}/index.html`, 'v2 from the other machine')
    other.state.saveSynced({
      ...(ctx.state.byDir(name) as NonNullable<ReturnType<State['byDir']>>),
    })
    expect(await pushSite(other, name)).toBe('pushed')

    write(ctx, `${name}/index.html`, 'stale edit')
    expect(await pushSite(ctx, name)).toBe('behind')
    const tree = await remoteTree(siteId)
    expect(tree.version).toBe(2)
    // No sending while behind
    expect(await pushSite(ctx, name)).toBe('behind')
  })

  it('keeps the entry chosen on the remote and refuses to push without it', async () => {
    write(ctx, `${name}/index.html`, 'x')
    await pushSite(ctx, name)
    rmSync(join(ctx.dir, name, 'index.html'))
    write(ctx, `${name}/other.html`, 'y')
    expect(await pushSite(ctx, name)).toBe('problem')
  })

  it('does not create a second site when a deleted folder is recreated', async () => {
    write(ctx, `${name}/index.html`, 'x')
    await pushSite(ctx, name)
    rmSync(join(ctx.dir, name), { recursive: true })
    expect(await pushSite(ctx, name)).toBe('detached')
    write(ctx, `${name}/index.html`, 'again')
    expect(await pushSite(ctx, name)).toBe('problem')
    expect(await ctx.client.sitesBySourceName(name)).toHaveLength(1)
  })

  it('detaches a deleted folder and leaves the remote site alone', async () => {
    write(ctx, `${name}/index.html`, 'x')
    await pushSite(ctx, name)
    const siteId = ctx.state.byDir(name)?.siteId as string
    rmSync(join(ctx.dir, name), { recursive: true })
    expect(await pushSite(ctx, name)).toBe('detached')
    expect(ctx.state.byDir(name)).toBeNull()
    expect((await remoteTree(siteId)).version).toBe(1)
  })
})

describe('ignore rules', () => {
  it('does not add ignored files that are not tracked yet', async () => {
    write(ctx, `${name}/index.html`, 'x')
    write(ctx, `${name}/node_modules/pkg/index.js`, 'junk')
    write(ctx, `${name}/.env`, 'SECRET=1')
    write(ctx, `${name}/notes.tmp`, 'tmp')
    write(ctx, `${name}/.dropignore`, 'drafts/\n')
    write(ctx, `${name}/drafts/a.html`, 'draft')
    await pushSite(ctx, name)
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual(['index.html'])
  })

  it('keeps tracked files even when they match an ignore rule', async () => {
    write(ctx, `${name}/index.html`, 'x')
    write(ctx, `${name}/vendor/lib.js`, 'lib')
    await pushSite(ctx, name)
    // Adding a tracked file to the ignore rules later does not count as deleting it
    write(ctx, `${name}/.dropignore`, 'vendor/\n')
    write(ctx, `${name}/index.html`, 'changed')
    expect(await pushSite(ctx, name)).toBe('pushed')
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual([
      'index.html',
      'vendor/lib.js',
    ])
  })

  it('does not follow symlinks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'drop-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    write(ctx, `${name}/index.html`, 'x')
    symlinkSync(outside, join(ctx.dir, name, 'linked'))
    await pushSite(ctx, name)
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual(['index.html'])
  })

  it('matches names at any depth, anchored paths from the root, and directory-only rules', () => {
    const ignore = Ignore.of(['*.log', '/build/', 'cache/'])
    expect(ignore.matches('a/b/x.log')).toBe(true)
    expect(ignore.matches('build/out.js')).toBe(true)
    expect(ignore.matches('src/build/out.js')).toBe(false)
    expect(ignore.matches('a/cache/x')).toBe(true)
    expect(ignore.matches('cache')).toBe(false)
  })
})

describe('file names', () => {
  it('normalizes names to NFC', async () => {
    const nfd = 'が'.normalize('NFD')
    write(ctx, `${name}/index.html`, 'x')
    write(ctx, `${name}/${nfd}.txt`, 'y')
    await pushSite(ctx, name)
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toContain(
      `${'が'.normalize('NFC')}.txt`,
    )
  })
})

describe('drop watch', () => {
  it('pushes a folder once its files have been quiet for a while', async () => {
    // macOS's recursive watch can miss events for changes right after it starts. Like the product,
    // a periodic scan picks them up, so the tests shorten that interval
    const w = startWatch(ctx, { quietMs: 200, rescanMs: 500 })
    try {
      write(ctx, `${name}/index.html`, '<title>watched</title>')
      write(ctx, `${name}/a.css`, 'x')
      const deadline = Date.now() + 8000
      while (ctx.state.byDir(name) === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        await w.settled()
      }
      expect(ctx.state.byDir(name)?.syncedVersion).toBe(1)
      expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual([
        'a.css',
        'index.html',
      ])
    } finally {
      w.stop()
    }
  }, 15000)
})

describe('things that must never be sent', () => {
  it('ignores every file whose name starts with .env', async () => {
    write(ctx, `${name}/index.html`, 'x')
    for (const f of ['.env', '.env.local', '.envrc', '.env-production'])
      write(ctx, `${name}/${f}`, 'SECRET=1')
    await pushSite(ctx, name)
    expect(paths(await remoteTree(ctx.state.byDir(name)?.siteId as string))).toEqual(['index.html'])
  })

  it('refuses a site folder that is itself a symlink', async () => {
    write(ctx, `${name}/index.html`, 'x')
    await pushSite(ctx, name)
    const siteId = ctx.state.byDir(name)?.siteId as string
    const outside = mkdtempSync(join(tmpdir(), 'drop-outside-'))
    writeFileSync(join(outside, 'index.html'), 'outside')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    rmSync(join(ctx.dir, name), { recursive: true })
    symlinkSync(outside, join(ctx.dir, name))
    expect(await pushSite(ctx, name)).toBe('problem')
    expect(paths(await remoteTree(siteId))).toEqual(['index.html'])
  })

  it('stops instead of dropping the rules when .dropignore cannot be read', async () => {
    write(ctx, `${name}/index.html`, 'x')
    write(ctx, `${name}/.dropignore`, 'private/\n')
    write(ctx, `${name}/private/secret.txt`, 'secret')
    chmodSync(join(ctx.dir, name, '.dropignore'), 0o000)
    try {
      await expect(pushSite(ctx, name)).rejects.toThrow('.dropignore')
      expect(ctx.state.byDir(name)).toBeNull()
    } finally {
      chmodSync(join(ctx.dir, name, '.dropignore'), 0o644)
    }
  })
})

describe('reading what to send', () => {
  it('refuses a file swapped for a symlink, or reached through a swapped directory, after the scan', async () => {
    write(ctx, `${name}/index.html`, 'x')
    write(ctx, `${name}/img/a.txt`, 'a')
    const root = join(ctx.dir, name)
    const { files } = await scanSite(root, new Set())
    const a = files.find((f) => f.path === 'img/a.txt') as LocalFile
    const index = files.find((f) => f.path === 'index.html') as LocalFile
    expect(new TextDecoder().decode(await readSnapshot(a))).toBe('a')

    const outside = mkdtempSync(join(tmpdir(), 'drop-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    rmSync(join(root, 'index.html'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'index.html'))
    await expect(readSnapshot(index)).rejects.toThrow('changed while sending')

    // Swap a whole directory for a link (the last name is not a link)
    mkdirSync(join(outside, 'img'))
    writeFileSync(join(outside, 'img', 'a.txt'), 'a')
    rmSync(join(root, 'img'), { recursive: true })
    symlinkSync(join(outside, 'img'), join(root, 'img'))
    await expect(readSnapshot(a)).rejects.toThrow('changed while sending')
  })

  it('refuses a file whose content changed after the scan', async () => {
    write(ctx, `${name}/index.html`, 'before')
    const { files } = await scanSite(join(ctx.dir, name), new Set())
    write(ctx, `${name}/index.html`, 'after!')
    await expect(readSnapshot(files[0] as LocalFile)).rejects.toThrow('changed while sending')
  })
})

describe('folder names typed by the user', () => {
  it('maps a name typed in another case to the folder already synced', async () => {
    const upper = `R${name}`
    write(ctx, `${upper}/index.html`, 'x')
    await pushSite(ctx, upper)
    const typed = upper.toLowerCase()
    // On a case-insensitive disk it is the same folder, so resolve to the name in the state
    const expected = process.platform === 'darwin' ? upper : typed
    expect(resolveDir(ctx, typed)).toBe(expected)
  })
})

describe('config', () => {
  it('defaults the sync directory to ~/drop and keeps only the origin of remote', async () => {
    const { loadConfig } = await import('../../cli/config')
    const { homedir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'drop-config-'))
    writeFileSync(join(dir, 'config.toml'), 'remote = "https://drop.example.dev/some/path"\n')
    const config = loadConfig(join(dir, 'config.toml'))
    expect(config.dir).toBe(join(homedir(), 'drop'))
    expect(config.remote).toBe('https://drop.example.dev')
  })

  it('is local without a config file: ~/drop and the drop serve on this machine', async () => {
    const { loadConfig } = await import('../../cli/config')
    const { homedir } = await import('node:os')
    const config = loadConfig(join(mkdtempSync(join(tmpdir(), 'drop-noconfig-')), 'config.toml'))
    expect(config).toEqual({ remote: 'http://127.0.0.1:8789', dir: join(homedir(), 'drop') })
  })
})
