// Sending a file tree (the client side of ADR-004's "put the Objects, then commit the list").
// Compute hashes, send only the Objects the server lacks, then Commit the tree. No session state is
// kept, so a failure midway can simply be retried from the start (Objects already put are reused)

import {
  contentTypeOf,
  isPageType,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_SIZE,
  normalizePath,
} from '../../../shared/files'
import { commitTree, fetchMissingObjects, patchTree, putObject, type TreeFileRef } from '../api'
import type { SiteMeta } from '../types'

export interface IncomingFile {
  path: string
  file: File
}

// How many to send at once. Kept below the browser's per-host connection limit (6) so other
// requests are not blocked
const CONCURRENCY = 4

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Pre-validation with the server's rules. The server always validates again; this is for rejecting
// early and clearly
function validate(entry: string, files: IncomingFile[]): IncomingFile[] {
  if (files.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES})`)
  const seen = new Set<string>()
  const normalized: IncomingFile[] = []
  let total = 0
  for (const f of files) {
    const r = normalizePath(f.path)
    if ('error' in r) throw new Error(`${f.path}: ${r.error}`)
    if (seen.has(r.path)) throw new Error(`Duplicate file name: ${r.path}`)
    seen.add(r.path)
    const limit = isPageType(contentTypeOf(r.path)) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
    if (f.file.size > limit) throw new Error(`${r.path}: exceeds ${limit / 1024 / 1024}MB`)
    total += f.file.size
    normalized.push({ path: r.path, file: f.file })
  }
  if (total > MAX_TOTAL_SIZE)
    throw new Error(`Total size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB`)
  if (!seen.has(entry)) throw new Error(`${entry} is missing`)
  return normalized
}

// Put the Objects (the first half of a Commit). Compute hashes and send only what the server lacks.
// Returns the {path, sha256, size} that go into the Commit
async function stageFiles(
  siteId: string,
  files: IncomingFile[],
  onProgress?: (message: string) => void,
): Promise<TreeFileRef[]> {
  // Hash one file at a time so 200MB is never held in memory at once
  const refs: TreeFileRef[] = []
  const fileOf = new Map<string, File>()
  for (const [i, f] of files.entries()) {
    if (files.length > 1) onProgress?.(`checking ${i + 1}/${files.length}`)
    const sha256 = await sha256Hex(f.file)
    refs.push({ path: f.path, sha256, size: f.file.size })
    fileOf.set(sha256, f.file)
  }

  const missing = await fetchMissingObjects(siteId, [...fileOf.keys()])
  const queue = [...missing]
  let sent = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let sha256 = queue.shift(); sha256 !== undefined; sha256 = queue.shift()) {
        await putObject(siteId, sha256, fileOf.get(sha256) as File)
        sent++
        onProgress?.(`sending ${sent}/${missing.length}`)
      }
    }),
  )
  return refs
}

// Send the tree and commit it. With create, this makes a new Site (the id is made here); otherwise
// it replaces the siteId Site with this tree (files not sent are gone from the new Version)
// onProgress receives progress as a short message (shown in the upload queue)
export async function sendTree(
  target: { siteId: string } | { create: { sourceName: string; folderId?: string } },
  entry: string,
  files: IncomingFile[],
  onProgress?: (message: string) => void,
): Promise<SiteMeta> {
  const siteId = 'siteId' in target ? target.siteId : crypto.randomUUID()
  const refs = await stageFiles(siteId, validate(entry, files), onProgress)
  return commitTree(siteId, entry, refs, 'create' in target ? target.create : undefined)
}

// Apply changes to the current tree (the file tree dialog). base is the Version the changes were
// made on. The server checks Paths and limits on the resulting tree (only the per-file limit is
// checked here first)
export async function sendPatch(
  siteId: string,
  base: number,
  change: { put?: IncomingFile[]; delete?: string[]; entry?: string },
  onProgress?: (message: string) => void,
): Promise<SiteMeta> {
  const put: IncomingFile[] = []
  for (const f of change.put ?? []) {
    const r = normalizePath(f.path)
    if ('error' in r) throw new Error(`${f.path}: ${r.error}`)
    const limit = isPageType(contentTypeOf(r.path)) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
    if (f.file.size > limit) throw new Error(`${r.path}: exceeds ${limit / 1024 / 1024}MB`)
    put.push({ path: r.path, file: f.file })
  }
  const refs = put.length > 0 ? await stageFiles(siteId, put, onProgress) : []
  return patchTree(siteId, { base, put: refs, delete: change.delete, entry: change.entry })
}
