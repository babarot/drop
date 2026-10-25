// pull: write the content of Sites on drop into the sync directory. Run explicitly by the user.
// If both local and remote changed, do a per-file three-way comparison from the synced version.
// If there is any conflict, stop without writing anything to that Site (--theirs takes remote)

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePath } from '../shared/files'
import type { SiteFilesResponse, SiteMeta } from '../src/types'
import type { SyncContext } from './push'
import { scanSite } from './scan'
import type { SiteState, SyncedTree } from './state'

export interface PullOptions {
  // Take remote for conflicting files. Local files being discarded are copied to backupDir
  theirs?: boolean
  // Bring the Detached Sites with these names (folder name or Source name) back into sync
  include?: string[]
  // If set, pull only the Sites with these names (folder name or Source name)
  only?: string[]
}

export type PullOutcome =
  | 'cloned'
  | 'updated'
  | 'merged'
  | 'unchanged'
  | 'conflict'
  | 'detached'
  | 'skipped'
  | 'problem'

const DOWNLOAD_CONCURRENCY = 4

// A value is the content hash or absent (undefined). Absent counts as a value (deletion is a
// change)
type Side = Record<string, string | undefined>

interface Plan {
  write: string[]
  remove: string[]
  conflicts: string[]
}

// Three-way comparison (synced version, local, remote)
export function plan(base: Side, local: Side, remote: Side): Plan {
  const write: string[] = []
  const remove: string[] = []
  const conflicts: string[] = []
  const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
  for (const p of [...paths].sort()) {
    const b = base[p]
    const l = local[p]
    const r = remote[p]
    if (l === b) {
      // Local is unchanged: apply remote
      if (r === l) continue
      if (r === undefined) remove.push(p)
      else write.push(p)
    } else if (r === b || r === l) {
      // Remote is unchanged, or both reached the same result: keep local (local-only changes go out
      // with the next push)
    } else {
      conflicts.push(p)
    }
  }
  return { write, remove, conflicts }
}

// Pairs of Paths that cannot coexist on a case-insensitive file system (compared lowercased after
// NFC)
export function caseCollisions(paths: string[]): string[] {
  const seen = new Map<string, string>()
  const found: string[] = []
  for (const p of paths) {
    const key = p.normalize('NFC').toLowerCase()
    const prev = seen.get(key)
    if (prev !== undefined && prev !== p) found.push(`${prev} and ${p}`)
    else seen.set(key, p)
  }
  return found
}

const absOf = (root: string, path: string) => join(root, ...path.split('/'))

// Assert there is no symlink along path inside the Site's folder (so a link's target is never
// written)
function assertNoLinks(root: string, path: string): void {
  const segments = path.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const info = lstatSync(absOf(root, segments.slice(0, i).join('/')), { throwIfNoEntry: false })
    if (info?.isSymbolicLink()) {
      throw new PullProblem(`${segments.slice(0, i).join('/')} is a symlink; not writing to it`)
    }
  }
}

class PullProblem extends Error {}

function writeAtomic(root: string, path: string, bytes: Uint8Array): void {
  assertNoLinks(root, path)
  const abs = absOf(root, path)
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = `${abs}.${crypto.randomUUID()}.drop-tmp`
  writeFileSync(tmp, bytes)
  try {
    renameSync(tmp, abs)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

// Remove a deleted file's directories that became empty, up to the Site's folder
function removeFile(root: string, path: string): void {
  assertNoLinks(root, path)
  rmSync(absOf(root, path), { force: true })
  let dir = dirname(path)
  while (dir !== '.' && dir !== '') {
    const abs = absOf(root, dir)
    if (readdirSync(abs).length > 0) break
    rmdirSync(abs)
    dir = dirname(dir)
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

// Map the remote tree to Path -> hash. Legacy Files (sha256 NULL) are downloaded and hashed (each
// Object key only once). The downloaded content is reused when writing
async function remoteSide(
  ctx: SyncContext,
  siteId: string,
  tree: SiteFilesResponse,
  fetched: Map<string, Uint8Array>,
): Promise<{ side: Side; synced: SyncedTree }> {
  const side: Side = {}
  const synced: SyncedTree = {}
  const byKey = new Map<string, string>()
  for (const f of tree.files) {
    const checked = normalizePath(f.path)
    if ('error' in checked || checked.path !== f.path) {
      throw new PullProblem(`${f.path}: Path cannot be written locally`)
    }
    let sha = f.sha256 ?? byKey.get(f.objectKey)
    if (sha === undefined) {
      const bytes = await ctx.client.fileBytes(siteId, tree.version, f.path)
      sha = await sha256Hex(bytes)
      fetched.set(sha, bytes)
      byKey.set(f.objectKey, sha)
    }
    side[f.path] = sha
    synced[f.path] = { sha256: sha, size: f.size }
  }
  return { side, synced }
}

async function download(
  ctx: SyncContext,
  siteId: string,
  tree: SiteFilesResponse,
  remote: Side,
  paths: string[],
  fetched: Map<string, Uint8Array>,
): Promise<void> {
  const queue = paths.filter((p) => !fetched.has(remote[p] as string))
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        const sha = remote[p] as string
        if (fetched.has(sha)) continue
        const bytes = await ctx.client.fileBytes(siteId, tree.version, p)
        if ((await sha256Hex(bytes)) !== sha)
          throw new PullProblem(`${p}: downloaded content does not match`)
        fetched.set(sha, bytes)
      }
    }),
  )
}

// Paths that exist locally but are not in the scan (ignored and untracked files, directories, etc).
// Writing remote content there would silently overwrite local files, so they count as conflicts
function hiddenLocal(
  root: string,
  paths: string[],
  local: Side,
  renamed: Map<string, string>,
): string[] {
  return paths.filter(
    (p) =>
      local[p] === undefined &&
      !renamed.has(p) &&
      lstatSync(absOf(root, p), { throwIfNoEntry: false }) !== undefined,
  )
}

const caseKey = (p: string) => p.normalize('NFC').toLowerCase()

// Paths to write that differ only in case from a Path to remove (write Path -> remove Path). On a
// case-insensitive file system, what is visible before writing is the file being removed, so treat
// them as the same file
function caseRenames(write: string[], remove: string[]): Map<string, string> {
  const removed = new Map(remove.map((r) => [caseKey(r), r]))
  const renamed = new Map<string, string>()
  for (const w of write) {
    const r = removed.get(caseKey(w))
    if (r !== undefined && r !== w) renamed.set(w, r)
  }
  return renamed
}

// Whether a Source name can be used as is as a folder name directly under the sync directory
// (a single name, not . or .., no /, not hidden). The server does not restrict Source names
function isFolderName(name: string): boolean {
  const checked = normalizePath(name)
  return (
    !('error' in checked) && checked.path === name && !name.includes('/') && !name.startsWith('.')
  )
}

// Whether paths are as they were when scanned (local). Throws if any changed, vanished or appeared
async function currentHash(root: string, path: string): Promise<string | undefined> {
  const info = lstatSync(absOf(root, path), { throwIfNoEntry: false })
  if (info === undefined) return undefined
  // Non-files (directories, etc) get a value that matches no hash
  return info.isFile() ? sha256Hex(await Bun.file(absOf(root, path)).bytes()) : `not-a-file:${path}`
}

async function assertUnchanged(root: string, paths: string[], expected: Side): Promise<void> {
  for (const p of paths) {
    if ((await currentHash(root, p)) !== expected[p]) {
      throw new PullProblem(
        `${p} changed locally during download; stopped without writing anything`,
      )
    }
  }
}

// Whether the folder name is the same folder as one of the Sites in the state (Detached included).
// Compares file system identity (dev and ino), not just names (on disks that ignore case or
// NFC/NFD, different names point to the same folder)
function mappedFolder(ctx: SyncContext, name: string, siteId: string): boolean {
  // The Site being pulled itself (when bringing back a Detached one) does not count
  const others = ctx.state.all().filter((s) => s.siteId !== siteId)
  if (others.some((s) => s.dirName === name)) return true
  const target = lstatSync(join(ctx.dir, name), { throwIfNoEntry: false })
  if (!target) return false
  return others.some((s) => {
    const info = lstatSync(join(ctx.dir, s.dirName), { throwIfNoEntry: false })
    return info !== undefined && info.dev === target.dev && info.ino === target.ino
  })
}

// Make an unused folder name from a Source name
function folderNameFor(ctx: SyncContext, sourceName: string, siteId: string): string {
  const base =
    sourceName
      // biome-ignore lint/suspicious/noControlCharactersInRegex: keep control chars out of names
      .replace(/[/\\\u0000-\u001f]/g, '-')
      .replace(/^\.+/, '')
      .trim() || 'site'
  const taken = (name: string) =>
    lstatSync(join(ctx.dir, name), { throwIfNoEntry: false }) !== undefined ||
    mappedFolder(ctx, name, siteId)
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
}

// Copy local files to a backup. Returns what was copied (Path -> hash of the copied content;
// non-files get the same marker as currentHash, missing ones undefined). The recheck right before
// writing compares against this, so anything saved after the copy stops it (content not backed up
// is never overwritten)
async function backup(ctx: SyncContext, root: string, s: SiteState, paths: string[]) {
  const dir = join(ctx.backupDir, s.siteId, new Date().toISOString().replace(/[:.]/g, '-'))
  const saved: Side = {}
  for (const p of paths) {
    const info = lstatSync(absOf(root, p), { throwIfNoEntry: false })
    if (!info?.isFile()) {
      saved[p] = info === undefined ? undefined : `not-a-file:${p}`
      continue
    }
    const bytes = await Bun.file(absOf(root, p)).bytes()
    const dest = absOf(dir, p)
    // May contain .env and the like, so make it readable only by the user
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
    writeFileSync(dest, bytes, { mode: 0o600 })
    saved[p] = await sha256Hex(bytes)
  }
  return { dir, saved }
}

async function pullExisting(
  ctx: SyncContext,
  s: SiteState,
  meta: SiteMeta,
  opts: PullOptions,
): Promise<PullOutcome> {
  const { notify, state } = ctx
  if (meta.version === s.syncedVersion) {
    if (s.status === 'behind') state.setStatus(s.siteId, 'ok')
    return 'unchanged'
  }
  const root = join(ctx.dir, s.dirName)
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new PullProblem('not writing to a symlinked folder')
  }
  const tree = await ctx.client.currentTree(s.siteId)
  if (!tree) return 'detached'
  const fetched = new Map<string, Uint8Array>()
  const remote = await remoteSide(ctx, s.siteId, tree, fetched)
  const base: Side = Object.fromEntries(Object.entries(s.syncedTree).map(([p, f]) => [p, f.sha256]))
  const scanned = await scanSite(root, new Set(Object.keys(s.syncedTree)))
  if (scanned.problems.length > 0) throw new PullProblem(scanned.problems.join(' / '))
  const local: Side = Object.fromEntries(scanned.files.map((f) => [f.path, f.sha256]))

  const p = plan(base, local, remote.side)
  const renamed = caseRenames(p.write, p.remove)
  const conflicts = [...p.conflicts, ...hiddenLocal(root, p.write, local, renamed)]
  let write = p.write
  let remove = p.remove
  // The local state expected by the recheck right before writing. For files overwritten by
  // --theirs, the state when the backup was taken
  const expected: Side = { ...local }
  for (const [w, r] of renamed) {
    // On a case-insensitive file system, what is visible at the write Path is the file being
    // removed
    if (lstatSync(absOf(root, w), { throwIfNoEntry: false }) !== undefined) expected[w] = local[r]
  }
  if (conflicts.length > 0) {
    if (!opts.theirs) {
      state.setStatus(s.siteId, 'behind')
      notify.warn(
        s.siteId,
        `${s.dirName}: files changed both locally and on remote: ${conflicts.join(', ')}.` +
          ' Choose drop pull --theirs (take remote) or drop push --force (keep local)',
      )
      return 'conflict'
    }
    const backedUp = await backup(ctx, root, s, conflicts)
    for (const c of conflicts) expected[c] = backedUp.saved[c]
    notify.info(`${s.dirName}: copied local ${conflicts.join(', ')} to ${backedUp.dir}`)
    write = [...new Set([...write, ...conflicts.filter((c) => remote.side[c] !== undefined)])]
    remove = [...new Set([...remove, ...conflicts.filter((c) => remote.side[c] === undefined)])]
  }

  // Before writing, check the whole resulting tree for case collisions (finding out after writing
  // would overwrite unpushed local files)
  const after = new Set(Object.keys(local))
  for (const r of remove) after.delete(r)
  for (const w of write) after.add(w)
  const collisions = caseCollisions([...after])
  if (collisions.length > 0) {
    throw new PullProblem(`names differing only in case collide: ${collisions.join(', ')}`)
  }

  await download(ctx, s.siteId, tree, remote.side, write, fetched)
  // To not lose anything saved locally during the download, recheck right before writing that
  // nothing changed since the scan. If something did, stop without writing (the next pull retries)
  await assertUnchanged(root, [...write, ...remove], expected)
  // Remove, then write. When A.txt is renamed to a.txt on a case-insensitive file system, writing
  // first and then removing would delete the newly written a.txt too
  for (const r of remove) removeFile(root, r)
  for (const w of write) writeAtomic(root, w, fetched.get(remote.side[w] as string) as Uint8Array)
  state.saveSynced({
    siteId: s.siteId,
    dirName: s.dirName,
    syncedVersion: tree.version,
    syncedEntry: tree.entry,
    syncedTree: remote.synced,
  })
  notify.clear(s.siteId)
  notify.info(`${s.dirName}: pulled (v${tree.version})`)
  // merged if local-only changes remain (they go out with the next push)
  const final: Side = { ...local }
  for (const r of remove) delete final[r]
  for (const w of write) final[w] = remote.side[w]
  const keys = new Set([...Object.keys(final), ...Object.keys(remote.side)])
  return [...keys].some((k) => final[k] !== remote.side[k]) ? 'merged' : 'updated'
}

async function clone(ctx: SyncContext, meta: SiteMeta, opts: PullOptions): Promise<PullOutcome> {
  // If a folder named like the Source name exists and maps to no Site, adopt it (a folder that push
  // stopped on with "a Site with the same name is on drop"). The three-way comparison uses an empty
  // synced version, so local-only files stay and files on both sides with different content
  // conflict
  const adopt = meta.sourceName
  if (
    isFolderName(adopt) &&
    !mappedFolder(ctx, adopt, meta.id) &&
    lstatSync(join(ctx.dir, adopt), { throwIfNoEntry: false })?.isDirectory()
  ) {
    const empty: SiteState = {
      siteId: meta.id,
      dirName: adopt,
      syncedVersion: 0,
      syncedEntry: '',
      syncedTree: {},
      status: 'ok',
    }
    const outcome = await pullExisting(ctx, empty, meta, opts)
    return outcome === 'conflict' ? outcome : 'cloned'
  }
  const tree = await ctx.client.currentTree(meta.id)
  if (!tree) return 'skipped'
  const fetched = new Map<string, Uint8Array>()
  const remote = await remoteSide(ctx, meta.id, tree, fetched)
  const collisions = caseCollisions(Object.keys(remote.side))
  if (collisions.length > 0) {
    throw new PullProblem(`names differing only in case collide: ${collisions.join(', ')}`)
  }
  const dirName = folderNameFor(ctx, meta.sourceName, meta.id)
  const root = join(ctx.dir, dirName)
  await download(ctx, meta.id, tree, remote.side, Object.keys(remote.side), fetched)
  // If a folder with the same name appeared during the download, stop so its content is not
  // overwritten (create it only if absent)
  try {
    mkdirSync(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PullProblem(`${dirName} appeared during download; stopped without writing anything`)
    }
    throw e
  }
  for (const [path, sha] of Object.entries(remote.side)) {
    writeAtomic(root, path, fetched.get(sha as string) as Uint8Array)
  }
  ctx.state.saveSynced({
    siteId: meta.id,
    dirName,
    syncedVersion: tree.version,
    syncedEntry: tree.entry,
    syncedTree: remote.synced,
  })
  ctx.notify.info(`${dirName}: cloned (v${tree.version})`)
  return 'cloned'
}

const named = (names: string[] | undefined, s: SiteState | null, meta: SiteMeta) =>
  names?.some((n) => n === meta.sourceName || n === s?.dirName) ?? false

export async function pullAll(
  ctx: SyncContext,
  opts: PullOptions = {},
): Promise<Map<string, PullOutcome>> {
  const results = new Map<string, PullOutcome>()
  // On a new machine's first pull, the sync directory may not exist yet (Site folders are created
  // only if absent, so create the parent here)
  mkdirSync(ctx.dir, { recursive: true })
  const remoteSites = await ctx.client.allSites()
  const remoteIds = new Set(remoteSites.map((m) => m.id))
  const known = new Map(ctx.state.all().map((s) => [s.siteId, s]))

  for (const meta of remoteSites) {
    const s = known.get(meta.id) ?? null
    if (opts.only && !named(opts.only, s, meta)) continue
    const label = s?.dirName ?? meta.sourceName
    try {
      if (s?.status === 'detached') {
        if (!named(opts.include, s, meta)) {
          results.set(label, 'skipped')
          continue
        }
        // Use the folder left from when it was detached, or create a new one
        if (lstatSync(join(ctx.dir, s.dirName), { throwIfNoEntry: false })?.isDirectory()) {
          ctx.state.setStatus(s.siteId, 'ok')
          results.set(label, await pullExisting(ctx, { ...s, status: 'ok' }, meta, opts))
        } else {
          results.set(label, await clone(ctx, meta, opts))
        }
        continue
      }
      results.set(label, s ? await pullExisting(ctx, s, meta, opts) : await clone(ctx, meta, opts))
    } catch (e) {
      ctx.notify.warn(
        s?.siteId ?? `remote:${meta.id}`,
        `${label}: ${e instanceof Error ? e.message : e}`,
      )
      results.set(label, 'problem')
    }
  }

  // Sites gone from drop: keep the local folder and detach them
  for (const s of known.values()) {
    if (s.status === 'detached' || remoteIds.has(s.siteId)) continue
    if (opts.only && !opts.only.includes(s.dirName)) continue
    ctx.state.setStatus(s.siteId, 'detached')
    ctx.notify.warn(s.siteId, `${s.dirName}: Site was deleted on drop; detached (folder kept)`)
    results.set(s.dirName, 'detached')
  }
  return results
}
