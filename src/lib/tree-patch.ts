// Changes to the current tree (PATCH /api/sites/:id/tree. ADR-004).
// Instead of sending the whole tree again, the client sends only the Paths to add, replace or
// delete, and the Entry.
// Objects under old keys (versions/, assets/) have no content address, so the client cannot point
// at them again. The server carries over the object_key of the base version's rows as is

import {
  contentTypeOf,
  isPageType,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_SIZE,
  normalizePath,
} from '../../shared/files'
import { type AliasPairs, aliasGroup } from './files'
import { objectKeyOf, SHA256_RE } from './tree'
import { type NewFile, totalSize } from './versions'

export interface TreePatch {
  base: number
  put: { path: string; sha256: string; size: number }[]
  delete: string[]
  entry?: string
}

const pathOf = (raw: unknown): { path: string } | { error: string } => {
  if (typeof raw !== 'string') return { error: 'path must be a string' }
  const r = normalizePath(raw)
  return 'error' in r ? { error: `${raw}: ${r.error}` } : r
}

// Shape validation only. Checking against the tree (whether the Paths to delete exist, limits) is
// done by applyPatch
export function parsePatch(raw: unknown): TreePatch | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'invalid body' }
  const body = raw as Record<string, unknown>
  if (typeof body.base !== 'number' || !Number.isSafeInteger(body.base) || body.base < 1) {
    return { error: 'base must be a version number' }
  }
  const putRaw = body.put ?? []
  const deleteRaw = body.delete ?? []
  if (!Array.isArray(putRaw) || !Array.isArray(deleteRaw)) {
    return { error: 'put and delete must be arrays' }
  }
  if (putRaw.length > MAX_FILES || deleteRaw.length > MAX_FILES) {
    return { error: `too many files (max ${MAX_FILES})` }
  }

  const seen = new Set<string>()
  const put: TreePatch['put'] = []
  for (const item of putRaw) {
    if (typeof item !== 'object' || item === null) return { error: 'invalid put entry' }
    const { path: rawPath, sha256, size } = item as Record<string, unknown>
    const p = pathOf(rawPath)
    if ('error' in p) return p
    if (seen.has(p.path)) return { error: `duplicate path: ${p.path}` }
    seen.add(p.path)
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      return { error: `${p.path}: invalid sha256` }
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return { error: `${p.path}: invalid size` }
    }
    const limit = isPageType(contentTypeOf(p.path)) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
    if (size > limit) return { error: `${p.path}: too large (max ${limit / 1024 / 1024}MB)` }
    put.push({ path: p.path, sha256, size })
  }
  const del: string[] = []
  for (const item of deleteRaw) {
    const p = pathOf(item)
    if ('error' in p) return p
    // When the same Path is in both put and delete, refuse rather than pick one to take precedence
    if (seen.has(p.path)) return { error: `path is both put and deleted: ${p.path}` }
    seen.add(p.path)
    del.push(p.path)
  }

  let entry: string | undefined
  if (body.entry !== undefined) {
    const p = pathOf(body.entry)
    if ('error' in p) return { error: `entry: ${p.error}` }
    entry = p.path
  }
  return { base: body.base, put, delete: del, entry }
}

// The new version's tree: the base version's tree with the changes applied.
// For an old asset pair (aliasGroup), a put / delete on one applies to both: replacing only one
// would leave HTML that references the canonical name (which the old dialog presented as "the path
// that always works") showing the old content, and deleting only one would break the pair
export function applyPatch(
  siteId: string,
  baseFiles: NewFile[],
  pairs: AliasPairs,
  baseEntry: string,
  patch: TreePatch,
): { entry: string; files: NewFile[] } | { error: string } {
  const byPath = new Map(baseFiles.map((f) => [f.path, f]))
  const touched = new Set<string>()
  const groupOf = (path: string): string[] => {
    const f = byPath.get(path)
    return f ? aliasGroup(baseFiles, f, pairs).map((g) => g.path) : [path]
  }

  const next = new Map(byPath)
  for (const path of patch.delete) {
    if (!byPath.has(path)) return { error: `not in the tree: ${path}` }
    for (const p of groupOf(path)) {
      if (touched.has(p)) return { error: `path is changed twice: ${p}` }
      touched.add(p)
      next.delete(p)
    }
  }
  for (const f of patch.put) {
    for (const p of groupOf(f.path)) {
      if (touched.has(p)) return { error: `path is changed twice: ${p}` }
      touched.add(p)
      next.set(p, {
        path: p,
        objectKey: objectKeyOf(siteId, f.sha256),
        contentType: contentTypeOf(p),
        size: f.size,
        sha256: f.sha256,
      })
    }
  }

  const entry = patch.entry ?? baseEntry
  const entryFile = next.get(entry)
  if (!entryFile) {
    return {
      error: patch.entry === undefined ? 'cannot delete the entry' : 'entry is not in files',
    }
  }
  if (!isPageType(entryFile.contentType)) return { error: 'entry must be an HTML file' }

  // Limits are checked on the resulting tree (the part that was sent alone does not tell the total)
  const files = [...next.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  if (files.length > MAX_FILES) return { error: `too many files (max ${MAX_FILES})` }
  if (totalSize(files) > MAX_TOTAL_SIZE) {
    return { error: `tree too large (max ${MAX_TOTAL_SIZE / 1024 / 1024}MB)` }
  }
  return { entry, files }
}
