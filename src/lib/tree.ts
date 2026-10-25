// Reading and writing content-addressed objects (sites/{siteId}/objects/{sha256}) and validating
// trees to be committed. The server side of ADR-004's "put the objects, then commit the list"

import {
  contentTypeOf,
  isPageType,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_SIZE,
  normalizePath,
} from '../../shared/files'
import type { Backend } from '../backend/types'
import { objectPrefix } from './r2'

export { ChecksumMismatchError } from '../backend/types'

// A Site id has the form of crypto.randomUUID() (lowercase). The object API accepts requests even
// without a Site row, so the format is always validated to keep arbitrary strings out of R2 keys
export const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const SHA256_RE = /^[0-9a-f]{64}$/

export const objectKeyOf = (siteId: string, sha256: string) => `${objectPrefix(siteId)}${sha256}`

export async function sha256Hex(body: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Write an object. The store verifies the hash and, on a mismatch, fails leaving nothing behind
// (ChecksumMismatchError). An existing key is not overwritten; the same content means the same
// key, so the result is the same either way.
// Even on failure, never delete the key that may have been written here: another version or Path
// may always be pointing at the same object (ADR-004)
export function putObject(
  backend: Backend,
  siteId: string,
  sha256: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
): Promise<'created' | 'exists'> {
  return backend.blobs.put(objectKeyOf(siteId, sha256), body, sha256)
}

// Fetch all of the Site's content-addressed objects as sha256 → size
export async function listObjects(backend: Backend, siteId: string): Promise<Map<string, number>> {
  const prefix = objectPrefix(siteId)
  const found = new Map<string, number>()
  for await (const o of backend.blobs.list(prefix)) found.set(o.key.slice(prefix.length), o.size)
  return found
}

export interface TreeEntry {
  path: string
  sha256: string
  size: number
  contentType: string
}

export type ParsedTree = { entry: string; files: TreeEntry[] } | { error: string }

// Validate a tree from the client. Paths are normalized again with the shared rules (the client's
// validation is not trusted), and the Content-Type comes from the extension. Whether the objects
// exist is not checked here (the caller checks against listObjects)
export function parseTree(entryRaw: unknown, filesRaw: unknown): ParsedTree {
  if (!Array.isArray(filesRaw)) return { error: 'files must be an array' }
  if (filesRaw.length === 0) return { error: 'files must not be empty' }
  if (filesRaw.length > MAX_FILES) return { error: `too many files (max ${MAX_FILES})` }

  const files: TreeEntry[] = []
  const seen = new Set<string>()
  const objectSizes = new Map<string, number>()
  for (const raw of filesRaw) {
    if (typeof raw !== 'object' || raw === null) return { error: 'invalid file entry' }
    const { path: rawPath, sha256, size } = raw as Record<string, unknown>
    if (typeof rawPath !== 'string') return { error: 'path must be a string' }
    const normalized = normalizePath(rawPath)
    if ('error' in normalized) return { error: `${rawPath}: ${normalized.error}` }
    const path = normalized.path
    if (seen.has(path)) return { error: `duplicate path: ${path}` }
    seen.add(path)
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      return { error: `${path}: invalid sha256` }
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return { error: `${path}: invalid size` }
    }
    const contentType = contentTypeOf(path)
    const limit = isPageType(contentType) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
    if (size > limit) return { error: `${path}: too large (max ${limit / 1024 / 1024}MB)` }
    objectSizes.set(sha256, size)
    files.push({ path, sha256, size, contentType })
  }
  const total = [...objectSizes.values()].reduce((a, b) => a + b, 0)
  if (total > MAX_TOTAL_SIZE) {
    return { error: `tree too large (max ${MAX_TOTAL_SIZE / 1024 / 1024}MB)` }
  }

  if (typeof entryRaw !== 'string') return { error: 'entry must be a string' }
  const entry = normalizePath(entryRaw)
  if ('error' in entry) return { error: `entry: ${entry.error}` }
  const entryFile = files.find((f) => f.path === entry.path)
  if (!entryFile) return { error: 'entry is not in files' }
  if (!isPageType(entryFile.contentType)) return { error: 'entry must be an HTML file' }
  return { entry: entry.path, files }
}
