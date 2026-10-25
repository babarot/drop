// Comparison of the file trees of two Versions (the history diff. ADR-004).
// Does not depend on React

import type { VersionFileMeta, VersionFilesResponse } from '../types'

// Direction is current → selected Version (what would happen on restore).
// added = only in the selected Version, removed = only in the current one
export interface FileChange {
  path: string
  status: 'added' | 'removed' | 'changed' | 'same'
  current?: VersionFileMeta
  selected?: VersionFileMeta
}

export interface TreeComparison {
  changes: FileChange[]
  entryChanged: { from: string; to: string } | null
}

// The same key means the same content (content-addressed or legacy key). Legacy-key rows have a
// null sha256, so hashes are compared only when both sides have one. Even if a legacy key and a new
// key hold the same content, the body is not fetched to confirm it (it shows as changed)
const sameContent = (a: VersionFileMeta, b: VersionFileMeta): boolean =>
  a.objectKey === b.objectKey || (a.sha256 !== null && a.sha256 === b.sha256)

// Skip the canonical rows of legacy assets (same Object as the paired Display name row; they change
// together)
const byPath = (tree: VersionFilesResponse) =>
  new Map(tree.files.filter((f) => f.aliasOf === undefined).map((f) => [f.path, f]))

export function compareTrees(
  current: VersionFilesResponse,
  selected: VersionFilesResponse,
): TreeComparison {
  const a = byPath(current)
  const b = byPath(selected)
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort()
  const changes = paths.map((path): FileChange => {
    const cur = a.get(path)
    const sel = b.get(path)
    if (!cur) return { path, status: 'added', selected: sel }
    if (!sel) return { path, status: 'removed', current: cur }
    return {
      path,
      status: sameContent(cur, sel) ? 'same' : 'changed',
      current: cur,
      selected: sel,
    }
  })
  return {
    changes,
    entryChanged:
      current.entry === selected.entry ? null : { from: current.entry, to: selected.entry },
  }
}

// Line diffs are shown only for text types at or below this size (so diffLines does not freeze the
// tab)
export const MAX_DIFF_SIZE = 1024 * 1024

const TEXT_TYPES = new Set(['image/svg+xml', 'application/json'])
export const isTextType = (contentType: string) =>
  contentType.startsWith('text/') || TEXT_TYPES.has(contentType)

export function canLineDiff(change: FileChange): boolean {
  const sides = [change.current, change.selected].filter((f) => f !== undefined)
  return sides.every((f) => isTextType(f.contentType) && f.size <= MAX_DIFF_SIZE)
}
