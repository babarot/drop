import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { ASSET_TYPES } from '../../shared/files'
import type { Backend } from '../backend/types'
import { type VersionFileRow, versionFiles } from '../db/schema'

// The current version = the Site's highest version. versions and version_files are written in
// the same batch, so the rows for the highest version in versions are always complete
export const currentVersionOf = (siteId: string): SQL =>
  sql`(select max(version) from versions where site_id = ${siteId})`

// Without version, it reads from the current version
export async function findFile(
  backend: Backend,
  siteId: string,
  path: string,
  version?: number,
): Promise<VersionFileRow | null> {
  const [row] = await backend.db.orm
    .select()
    .from(versionFiles)
    .where(
      and(
        eq(versionFiles.siteId, siteId),
        eq(versionFiles.version, version ?? currentVersionOf(siteId)),
        eq(versionFiles.path, path),
      ),
    )
  return row ?? null
}

export async function listFiles(
  backend: Backend,
  siteId: string,
  version?: number,
): Promise<VersionFileRow[]> {
  return backend.db.orm
    .select()
    .from(versionFiles)
    .where(
      and(
        eq(versionFiles.siteId, siteId),
        eq(versionFiles.version, version ?? currentVersionOf(siteId)),
      ),
    )
    .orderBy(asc(versionFiles.path))
}

// The same character set as old assets' canonical names (can go into a download name as a
// quoted-string as is)
export const ASCII_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface FileLike {
  path: string
  objectKey: string
  contentType: string
}

// The rule for old assets' canonical names (validateAssetFilename in the former shared/assets.ts):
// 1 to 100 ASCII-only characters, starting with an alphanumeric, with an extension of a type
// delivery can handle. A canonical name was derived when the display name did not fit this
// (non-ASCII, too long and so on)
const CANONICAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
function isCanonicalName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (!CANONICAL_NAME_RE.test(name) || dot <= 0 || dot === name.length - 1) return false
  return ASSET_TYPES[name.slice(dot + 1).toLowerCase()] !== undefined
}

// The mapping of old asset pairs (Path → its partner's Path, looked up from either the canonical
// or the display name). Built by findAliasPairs
export type AliasPairs = Map<string, string>

const isRootAsset = (f: FileLike) => !f.path.includes('/') && f.contentType !== 'text/html'

// When the display name did not fit the canonical name rule (isCanonicalName) (non-ASCII, too long
// and so on), the canonical name was derived deterministically from the display name (NFC): the
// stem with only ASCII kept (up to 40 characters) + the first 8 hex digits of the display name's
// SHA-256 + the lowercased extension (deriveAssetName in the former app/src/lib/asset-name.ts,
// removed in 4c). Only names that match when derived again with the same rule form a pair
export async function canonicalNameOf(display: string): Promise<string | null> {
  const dot = display.lastIndexOf('.')
  if (dot <= 0 || dot === display.length - 1) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(display))
  const hash = [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const stem = display
    .slice(0, dot)
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 40)
  const ext = display.slice(dot + 1).toLowerCase()
  return stem ? `${stem}-${hash}.${ext}` : `${hash}.${ext}`
}

// Find pairs of an old asset's canonical (ASCII) name and display name. A pair is two assets at the
// Site root, and only when the canonical name matches the name derived from the display name and
// both point at the same object.
// With content addressing, different files with the same content also point at the same object
// (a.pdf and b.pdf with the same bytes, two old asset pairs with the same content and so on), so
// neither the object nor the shape of the names alone makes a pair (so deleting one never deletes
// another file too, and download names never get mixed up)
export async function findAliasPairs<T extends FileLike>(files: T[]): Promise<AliasPairs> {
  const byPath = new Map(files.filter(isRootAsset).map((f) => [f.path, f]))
  const pairs: AliasPairs = new Map()
  for (const display of byPath.values()) {
    if (isCanonicalName(display.path)) continue
    const name = await canonicalNameOf(display.path)
    const canonical = name === null ? undefined : byPath.get(name)
    if (!canonical || canonical.objectKey !== display.objectKey) continue
    pairs.set(display.path, canonical.path)
    pairs.set(canonical.path, display.path)
  }
  return pairs
}

// Return file and its partner (just file if it has no pair)
export function aliasGroup<T extends FileLike>(files: T[], file: T, pairs: AliasPairs): T[] {
  const partnerPath = pairs.get(file.path)
  const partner = partnerPath === undefined ? undefined : files.find((f) => f.path === partnerPath)
  return partner ? [file, partner] : [file]
}

// If file is the canonical name of an old asset pair, return the pair's display-name Path
// (otherwise null). The display name can be ASCII too (names over 100 characters), so tell them
// apart by the canonical name rule rather than by whether it is ASCII
export function aliasDisplayOf(file: FileLike, pairs: AliasPairs): string | null {
  const partner = pairs.get(file.path)
  return partner !== undefined && isCanonicalName(file.path) ? partner : null
}

// Rows in the same version that point at the same object (fetches aliasGroup's candidates in one
// query)
export async function filesOfObject(
  backend: Backend,
  file: VersionFileRow,
): Promise<VersionFileRow[]> {
  return backend.db.orm
    .select()
    .from(versionFiles)
    .where(
      and(
        eq(versionFiles.siteId, file.siteId),
        eq(versionFiles.version, file.version),
        eq(versionFiles.objectKey, file.objectKey),
      ),
    )
}

// D1 allows up to 100 bound parameters per query (leave room for siteId)
const REF_CHUNK = 90

// Delete from R2 the keys that no row of the Site references.
// Always call this pruning after the commit's batch (deciding before the batch would miss a new
// version that points at the same object as the pruned one).
export async function deleteUnreferenced(
  backend: Backend,
  siteId: string,
  keys: string[],
): Promise<void> {
  const db = backend.db.orm
  const unique = [...new Set(keys)]
  const orphans: string[] = []
  for (let i = 0; i < unique.length; i += REF_CHUNK) {
    const chunk = unique.slice(i, i + REF_CHUNK)
    const files = await db
      .selectDistinct({ key: versionFiles.objectKey })
      .from(versionFiles)
      .where(and(eq(versionFiles.siteId, siteId), inArray(versionFiles.objectKey, chunk)))
    const referenced = new Set(files.map((r) => r.key))
    orphans.push(...chunk.filter((k) => !referenced.has(k)))
  }
  await backend.blobs.delete(orphans)
}
