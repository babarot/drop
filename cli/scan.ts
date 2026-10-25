// Scan a sync directory folder (one Site) into a list of Path, hash and size.
// Paths follow the same rules as Ingest in the admin UI (NFC, normalizePath in shared/files.ts)

import { constants } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  contentTypeOf,
  isJunk,
  isPageType,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_SIZE,
  normalizePath,
} from '../shared/files'

export interface LocalFile {
  path: string
  abs: string
  sha256: string
  size: number
  // File identity at scan time (readSnapshot checks it is the same file when sending)
  dev: number
  ino: number
}

export interface ScanResult {
  files: LocalFile[]
  // If any, the Site is not committed (silently dropping some files would commit a broken site)
  problems: string[]
}

// Default ignores. Keeps AI work byproducts and secret files out while they are untracked
export const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  // Anything whose name starts with .env: .env, .env.local, .envrc, .env-production, etc
  '.env*',
  '.dropignore',
  '*~',
  '.*.swp',
  '*.tmp',
  // Temporary files pull writes in progress
  '*.drop-tmp',
]

export const IGNORE_FILE = '.dropignore'

// A simple subset of gitignore: one glob per line, # starts a comment, a trailing / matches only
// directories, a pattern with / matches a Path from the Site root, one without matches a name at
// any level
interface Rule {
  glob: InstanceType<typeof Bun.Glob>
  anchored: boolean
  dirOnly: boolean
}

function parseRules(lines: string[]): Rule[] {
  const rules: Rule[] = []
  for (const raw of lines) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line === '') continue
    rules.push({ glob: new Bun.Glob(line), anchored, dirOnly })
  }
  return rules
}

export class Ignore {
  private constructor(private readonly rules: Rule[]) {}

  // A missing .dropignore is fine, but throw if it exists and cannot be read (silently dropping the
  // rules would send untracked files that should be ignored)
  static async load(root: string): Promise<Ignore> {
    const own = await readFile(join(root, IGNORE_FILE), 'utf8').catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return ''
        throw new Error(`cannot read ${IGNORE_FILE}: ${e.message}`)
      },
    )
    return new Ignore(parseRules([...DEFAULT_IGNORES, ...own.split('\n')]))
  }

  static of(lines: string[]): Ignore {
    return new Ignore(parseRules(lines))
  }

  // Whether path (isDir for a directory) matches an ignore rule. If a parent directory matches, so
  // does its content
  matches(path: string, isDir = false): boolean {
    const segments = path.split('/')
    return segments.some((name, i) => {
      const dir = i < segments.length - 1 || isDir
      const prefix = segments.slice(0, i + 1).join('/')
      return this.rules.some(
        (r) => (!r.dirOnly || dir) && (r.anchored ? r.glob.match(prefix) : r.glob.match(name)),
      )
    })
  }
}

async function sha256Of(abs: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(abs).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}

// tracked is the Paths in the synced version. Ignore rules only keep untracked files from being
// added (as in git). Tracked files stay in the scan even if a rule matches, and go away only when
// deleted locally
export async function scanSite(root: string, tracked: Set<string>): Promise<ScanResult> {
  const ignore = await Ignore.load(root)
  const files: LocalFile[] = []
  const problems: string[] = []
  const trackedUnder = (dir: string) => [...tracked].some((p) => p.startsWith(`${dir}/`))

  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(root, rel), { withFileTypes: true })
    for (const e of entries) {
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`
      const abs = join(root, relPath)
      // Do not follow symlinks (so files outside the folder not meant to be shown are never
      // uploaded)
      const info = await lstat(abs)
      if (info.isSymbolicLink()) continue
      // macOS may return names in NFD. Paths are NFC
      const path = relPath.normalize('NFC')
      if (info.isDirectory()) {
        if (ignore.matches(path, true) && !trackedUnder(path)) continue
        await walk(relPath)
        continue
      }
      if (!info.isFile() || isJunk(path)) continue
      if (ignore.matches(path) && !tracked.has(path)) continue
      const checked = normalizePath(path)
      if ('error' in checked) {
        problems.push(`${path}: ${checked.error}`)
        continue
      }
      const limit = isPageType(contentTypeOf(path)) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
      if (info.size > limit) {
        problems.push(`${path}: exceeds ${limit / 1024 / 1024}MB`)
        continue
      }
      files.push({
        path,
        abs,
        sha256: await sha256Of(abs),
        size: info.size,
        dev: info.dev,
        ino: info.ino,
      })
    }
  }

  await walk('')
  if (files.length > MAX_FILES) problems.push(`too many files (max ${MAX_FILES})`)
  const total = new Map(files.map((f) => [f.sha256, f.size]))
  if ([...total.values()].reduce((a, b) => a + b, 0) > MAX_TOTAL_SIZE) {
    problems.push(`total exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB`)
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, problems }
}

export class ChangedDuringSyncError extends Error {
  constructor(path: string) {
    super(`${path}: changed while sending (will retry on the next push)`)
  }
}

// Read the content to send. So that a link target is never sent even if the path is swapped for a
// symlink after the scan, open without following links (O_NOFOLLOW), check on the opened handle
// that it is the same file (dev and ino) as at scan time (this also catches a swapped parent
// directory), and return the content if its hash matches the scan. This content is what gets sent;
// the path is not reopened
export async function readSnapshot(f: LocalFile): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await open(f.abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ChangedDuringSyncError(f.path)
  })
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== f.dev || info.ino !== f.ino) {
      throw new ChangedDuringSyncError(f.path)
    }
    const bytes = new Uint8Array(await handle.readFile())
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(bytes)
    if (hasher.digest('hex') !== f.sha256) throw new ChangedDuringSyncError(f.path)
    return bytes
  } finally {
    await handle.close()
  }
}
