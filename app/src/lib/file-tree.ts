// The shape shown in the file tree dialog (nested by Directory). Does not depend on React

import type { VersionFileMeta } from '../types'

export interface TreeFile {
  path: string
  name: string
  size: number
  contentType: string
  // Canonical name of a legacy asset pair (set only on the Display name row). The canonical row
  // itself is not listed
  canonical?: string
}

export interface TreeDir {
  path: string // No trailing /. The root is ''
  name: string
  dirs: TreeDir[]
  files: TreeFile[]
  // Total number of files below (shown on the collapsed row)
  count: number
}

export function buildFileTree(files: VersionFileMeta[]): TreeDir {
  const canonicalOf = new Map(
    files.filter((f) => f.aliasOf !== undefined).map((f) => [f.aliasOf as string, f.path]),
  )
  const root: TreeDir = { path: '', name: '', dirs: [], files: [], count: 0 }
  const dirOf = new Map<string, TreeDir>([['', root]])
  const ensureDir = (path: string): TreeDir => {
    const hit = dirOf.get(path)
    if (hit) return hit
    const cut = path.lastIndexOf('/')
    const parent = ensureDir(cut < 0 ? '' : path.slice(0, cut))
    const dir: TreeDir = { path, name: path.slice(cut + 1), dirs: [], files: [], count: 0 }
    parent.dirs.push(dir)
    dirOf.set(path, dir)
    return dir
  }

  for (const f of files) {
    if (f.aliasOf !== undefined) continue
    const cut = f.path.lastIndexOf('/')
    const dir = ensureDir(cut < 0 ? '' : f.path.slice(0, cut))
    const canonical = canonicalOf.get(f.path)
    dir.files.push({
      path: f.path,
      name: f.path.slice(cut + 1),
      size: f.size,
      contentType: f.contentType,
      ...(canonical === undefined ? {} : { canonical }),
    })
  }

  // Directories first, then files, each sorted by name. Counts are summed from the bottom up
  const finish = (dir: TreeDir): number => {
    dir.dirs.sort((a, b) => a.name.localeCompare(b.name))
    dir.files.sort((a, b) => a.name.localeCompare(b.name))
    dir.count = dir.files.length + dir.dirs.reduce((n, d) => n + finish(d), 0)
    return dir.count
  }
  finish(root)
  return root
}

// Return the parent Directories of a Path, shallowest first (a/b/c.html → ['a', 'a/b']).
// Used to expand the tree down to the Entry when the dialog opens
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}
