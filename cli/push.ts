// push: commit a sync directory folder's content to drop, with the synced version as base.
// If drop is ahead, it stops with 409 and overwrites nothing (a pull is needed)

import { lstatSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { contentTypeOf, isJunk, isPageType, pickEntry } from '../shared/files'
import type { DropClient, TreeFile } from './client'
import type { Notifier } from './notify'
import { type LocalFile, readSnapshot, scanSite } from './scan'
import type { State, SyncedTree } from './state'

export interface SyncContext {
  client: DropClient
  state: State
  dir: string
  notify: Notifier
  // Where pull --theirs copies the local files it discards
  backupDir: string
}

export type PushOutcome =
  | 'created'
  | 'pushed'
  | 'unchanged'
  | 'behind'
  | 'gone'
  | 'detached'
  | 'problem'

const UPLOAD_CONCURRENCY = 4

const treeOf = (files: LocalFile[]): SyncedTree =>
  Object.fromEntries(files.map((f) => [f.path, { sha256: f.sha256, size: f.size }]))

function sameTree(a: SyncedTree, b: SyncedTree): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => b[k]?.sha256 === a[k]?.sha256)
}

// Ask about every hash in the tree and upload only the missing Objects. Being in the synced version
// does not prove an Object exists (Files from before ADR-004 live only under legacy keys, and PUT
// /tree requires Objects under content-addressed keys)
async function uploadMissing(client: DropClient, siteId: string, files: LocalFile[]) {
  const byHash = new Map(files.map((f) => [f.sha256, f]))
  const queue = await client.missing(siteId, [...byHash.keys()])
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
      for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) {
        const f = byHash.get(sha) as LocalFile
        await client.putObject(siteId, sha, new Blob([await readSnapshot(f)]))
      }
    }),
  )
}

const asTree = (files: LocalFile[]): TreeFile[] =>
  files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }))

export interface PushOptions {
  // On conflict, keep local: commit the local tree with drop's latest as base.
  // drop's content stays in history as the previous Version
  force?: boolean
}

export async function pushSite(
  ctx: SyncContext,
  dirName: string,
  opts: PushOptions = {},
): Promise<PushOutcome> {
  const { client, state, notify } = ctx
  const root = join(ctx.dir, dirName)
  const synced = state.byDir(dirName)
  const key = synced?.siteId ?? `dir:${dirName}`

  const info = lstatSync(root, { throwIfNoEntry: false })
  if (info?.isSymbolicLink()) {
    // Do not follow a Site folder that is itself a link (so files behind it not meant to be shown
    // are never sent)
    notify.warn(key, `${dirName}: symlinked folders are not synced`)
    return 'problem'
  }
  if (!info?.isDirectory()) {
    if (!synced) return 'unchanged'
    // Deleting the folder does not delete the Site on drop. Detach it from sync
    state.setStatus(synced.siteId, 'detached')
    notify.warn(key, `${dirName}: folder is gone; detached (the Site on drop is kept)`)
    return 'detached'
  }
  if (synced?.status === 'gone' || (synced?.status === 'behind' && !opts.force)) {
    // Do not send until pulled (the previous push already reported the state)
    return synced.status
  }

  const scanned = await scanSite(root, new Set(Object.keys(synced?.syncedTree ?? {})))
  if (scanned.problems.length > 0) {
    notify.warn(key, `${dirName}: cannot sync: ${scanned.problems.join(' / ')}`)
    return 'problem'
  }
  if (scanned.files.length === 0) {
    notify.warn(key, `${dirName}: no files`)
    return 'problem'
  }
  const tree = treeOf(scanned.files)

  if (synced) {
    let base = synced.syncedVersion
    let entry = synced.syncedEntry
    if (opts.force) {
      const latest = await client.currentTree(synced.siteId)
      if (!latest) {
        state.setStatus(synced.siteId, 'gone')
        notify.warn(key, `${dirName}: the Site is gone from drop`)
        return 'gone'
      }
      base = latest.version
      // If the Entry was changed on drop, follow drop as long as that file exists locally
      if (tree[latest.entry]) entry = latest.entry
    } else if (sameTree(tree, synced.syncedTree)) {
      notify.clear(key)
      return 'unchanged'
    }
    // Use drop's Entry as is (the CLI does not overwrite an Entry chosen in the UI)
    if (!tree[entry]) {
      notify.warn(key, `${dirName}: cannot sync: Entry ${entry} is missing`)
      return 'problem'
    }
    await uploadMissing(client, synced.siteId, scanned.files)
    const res = await client.putTree(synced.siteId, {
      base,
      entry,
      files: asTree(scanned.files),
    })
    if (res.kind === 'conflict') {
      state.setStatus(synced.siteId, 'behind')
      notify.warn(key, `${dirName}: drop is ahead; run drop pull`)
      return 'behind'
    }
    if (res.kind === 'gone') {
      state.setStatus(synced.siteId, 'gone')
      notify.warn(key, `${dirName}: the Site is gone from drop`)
      return 'gone'
    }
    state.saveSynced({
      ...synced,
      syncedVersion: res.version,
      syncedEntry: entry,
      syncedTree: tree,
    })
    notify.clear(key)
    notify.info(`${dirName}: pushed (v${res.version})`)
    return 'pushed'
  }

  // A new folder
  const pages = scanned.files.map((f) => f.path).filter((p) => isPageType(contentTypeOf(p)))
  const entry = pickEntry(pages.sort())
  if (entry === null) {
    notify.warn(
      key,
      `${dirName}: cannot pick the Entry (put index.html at the root, or keep a single HTML file)`,
    )
    return 'problem'
  }
  // Do not duplicate a Site with the same name. Stop for one created on another machine, and for
  // one detached on this machine (folder deleted and recreated), so it is brought in with pull.
  // Sites mapped to another folder are excluded (pulled into a folder named differently from the
  // Source name)
  const same = (await client.sitesBySourceName(dirName)).filter((s) => !state.active(s.id))
  if (same.length > 0) {
    notify.warn(key, `${dirName}: a Site with the same name is on drop; run drop pull first`)
    return 'problem'
  }
  const siteId = crypto.randomUUID()
  await uploadMissing(client, siteId, scanned.files)
  const res = await client.putTree(siteId, {
    entry,
    files: asTree(scanned.files),
    create: { sourceName: dirName },
  })
  if (res.kind !== 'ok') throw new Error(`${dirName}: could not create the Site`)
  state.saveSynced({
    siteId,
    dirName,
    syncedVersion: res.version,
    syncedEntry: entry,
    syncedTree: tree,
  })
  notify.clear(key)
  notify.info(`${dirName}: created the Site`)
  return 'created'
}

// Resolve a folder name typed by the user to the name in the state. On a case-insensitive disk,
// report and Report are the same folder, so look up by file system identity (dev and ino), not name
export function resolveDir(ctx: SyncContext, name: string): string {
  if (ctx.state.byDir(name)) return name
  const target = lstatSync(join(ctx.dir, name), { throwIfNoEntry: false })
  if (!target) return name
  const same = ctx.state.all().find((s) => {
    if (s.status === 'detached') return false
    const info = lstatSync(join(ctx.dir, s.dirName), { throwIfNoEntry: false })
    return info !== undefined && info.dev === target.dev && info.ino === target.ino
  })
  return same?.dirName ?? name
}

// Folders directly under the sync directory (except hidden ones), plus Sites whose folder is gone
export async function siteDirs(ctx: SyncContext): Promise<string[]> {
  const entries = await readdir(ctx.dir, { withFileTypes: true })
  const dirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      dirs.push(e.name)
    } else if (e.isFile() && !isJunk(e.name)) {
      ctx.notify.warn(
        `file:${e.name}`,
        `${e.name}: files directly under the sync directory are not synced (put it in a folder)`,
      )
    }
  }
  const known = ctx.state
    .all()
    .filter((s) => s.status !== 'detached')
    .map((s) => s.dirName)
  return [...new Set([...dirs, ...known])].sort()
}

export async function pushAll(ctx: SyncContext): Promise<Map<string, PushOutcome>> {
  const results = new Map<string, PushOutcome>()
  for (const dirName of await siteDirs(ctx)) {
    try {
      results.set(dirName, await pushSite(ctx, dirName))
    } catch (e) {
      ctx.notify.warn(`dir:${dirName}`, `${dirName}: ${e instanceof Error ? e.message : String(e)}`)
      results.set(dirName, 'problem')
    }
  }
  return results
}
