// Ingest: turn what was dropped (files, directories, zips) into a list of {path, file} per Site
// (ADR-004). Depends on neither React nor browser-only APIs (reading directories with
// webkitGetAsEntry is dropzone.tsx's job; this receives the finished listing)

import { unzipSync } from 'fflate'
import {
  contentTypeOf,
  isJunk,
  isPageType,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_SIZE,
  normalizePath,
  pickEntry,
} from '../../../shared/files'

export { isJunk }

import type { IncomingFile } from './upload'

export interface DroppedDir {
  name: string
  // path is relative to inside the dropped directory (the directory name is not included)
  files: IncomingFile[]
}

export interface DropPayload {
  // Loose files not inside a directory (zips also come here)
  loose: File[]
  dirs: DroppedDir[]
}

// Draft for one Site. If entry is null, the user picks one from pages (filled in by withEntry)
export interface SiteDraft {
  // Name shown in the queue and dialogs (directory name, zip file name, HTML file name)
  label: string
  // sourceName when creating a new Site (ADR-004)
  sourceName: string
  // Names used to match a re-drop. A directory is looked up by both its name and the Entry file
  // name (because Sites previously made from directories had the HTML file name as sourceName)
  matchNames: string[]
  files: IncomingFile[]
  entry: string | null
  pages: string[]
  // How sourceName and the match names are chosen:
  // - entry: the Entry file name (multiple loose files)
  // - dir: the directory name. The Entry file name is also added for matching
  // - fixed: only the name the caller decided (the zip name)
  // - html: a single loose HTML (+ assets), named after the HTML file. Without assets it is
  //   sent as before as an Entry-only replace (PUT /file) (runDraft in App)
  naming: 'entry' | 'dir' | 'fixed' | 'html'
}

export interface IngestError {
  name: string
  message: string
}

export interface IngestResult {
  drafts: SiteDraft[]
  errors: IngestError[]
}

const isHtmlName = (name: string) => /\.html?$/i.test(name)
const isZipName = (name: string) => /\.zip$/i.test(name)
const stemOf = (name: string) => {
  const base = name.slice(name.lastIndexOf('/') + 1)
  return base.replace(/\.[^.]+$/, '') || 'untitled'
}

class DraftError extends Error {}

// Check Path normalization, duplicates and limits, and make a draft. If any one fails, the whole
// Site is rejected (silently dropping some would commit a broken site)
function toDraft(
  label: string,
  sourceName: string,
  raw: IncomingFile[],
  naming: SiteDraft['naming'],
): SiteDraft {
  const files: IncomingFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const f of raw) {
    if (isJunk(f.path)) continue
    const r = normalizePath(f.path)
    if ('error' in r) throw new DraftError(`${f.path}: ${r.error}`)
    if (seen.has(r.path)) throw new DraftError(`Duplicate file name: ${r.path}`)
    seen.add(r.path)
    const limit = isPageType(contentTypeOf(r.path)) ? MAX_PAGE_SIZE : MAX_FILE_SIZE
    if (f.file.size > limit) throw new DraftError(`${r.path}: exceeds ${limit / 1024 / 1024}MB`)
    total += f.file.size
    files.push({ path: r.path, file: f.file })
  }
  if (files.length > MAX_FILES) throw new DraftError(`Too many files (max ${MAX_FILES})`)
  if (total > MAX_TOTAL_SIZE)
    throw new DraftError(`Total size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB`)
  const pages = files
    .map((f) => f.path)
    .filter((p) => isPageType(contentTypeOf(p)))
    .sort()
  if (pages.length === 0) throw new DraftError('No HTML found')
  const draft: SiteDraft = {
    label,
    sourceName,
    matchNames: [sourceName],
    files,
    entry: null,
    pages,
    naming,
  }
  const entry = pickEntry(pages)
  return entry === null ? draft : withEntry(draft, entry)
}

// Return the draft with its Entry decided (called from App after the user picks one)
export function withEntry(draft: SiteDraft, entry: string): SiteDraft {
  const entryStem = stemOf(entry)
  if (draft.naming === 'entry') {
    return { ...draft, entry, sourceName: entryStem, matchNames: [entryStem] }
  }
  if (draft.naming !== 'dir') return { ...draft, entry }
  // Adding the stem of index.html (index) would always match unrelated Sites named index
  if (entryStem.toLowerCase() === 'index') return { ...draft, entry }
  return { ...draft, entry, matchNames: [...new Set([draft.sourceName, entryStem])] }
}

// Draft of a single HTML (for example when "add as new site" is chosen because the file name
// differs from the replace target). Throws an Error if it exceeds the limit
export function htmlDraft(file: File): SiteDraft {
  return toDraft(file.name, stemOf(file.name), [{ path: 'index.html', file }], 'html')
}

// Zips are extracted in the browser (so archive size is not bound by the Workers request body and
// memory limits). Before extracting, check the central directory's entry count and total extracted
// size, and refuse anything over the limits (zip bomb defense)
async function unzipFiles(zip: File): Promise<IncomingFile[]> {
  // Refuse a zip whose compressed size already exceeds the extracted limit before reading it (so
  // tab memory is not exhausted)
  if (zip.size > MAX_TOTAL_SIZE)
    throw new DraftError(`zip exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB`)
  const data = new Uint8Array(await zip.arrayBuffer())
  let count = 0
  let total = 0
  try {
    unzipSync(data, {
      filter: (f) => {
        if (!f.name.endsWith('/') && !isJunk(f.name)) {
          count++
          total += f.originalSize
        }
        return false
      },
    })
  } catch {
    throw new DraftError('Cannot read the zip')
  }
  if (count > MAX_FILES) throw new DraftError(`Too many files (max ${MAX_FILES})`)
  if (total > MAX_TOTAL_SIZE)
    throw new DraftError(`Extracted total exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB`)

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(data, { filter: (f) => !f.name.endsWith('/') && !isJunk(f.name) })
  } catch {
    throw new DraftError('Cannot extract the zip')
  }
  const names = Object.keys(entries)
  // If the content is a single folder, strip it (the shape of a zip made by right-click "Compress"
  // on a folder)
  const first = names[0]?.split('/')[0]
  const strip =
    first !== undefined && names.every((n) => n.includes('/') && n.split('/')[0] === first)
      ? `${first}/`
      : ''
  return names.map((name) => {
    const path = name.slice(strip.length)
    return {
      path,
      file: new File(
        [entries[name] as Uint8Array<ArrayBuffer>],
        path.slice(path.lastIndexOf('/') + 1),
      ),
    }
  })
}

function attempt(name: string, result: IngestResult, build: () => SiteDraft) {
  try {
    result.drafts.push(build())
  } catch (e) {
    if (!(e instanceof DraftError)) throw e
    result.errors.push({ name, message: e.message })
  }
}

// How loose files are grouped:
// - each zip becomes its own Site
// - if the rest is only HTML, each HTML becomes its own Site (as before)
// - one HTML + assets makes one Site. The HTML's Path is index.html (same shape as earlier Sites.
//   The old /p/:id/raw redirect always targets index.html, so the file name is not used)
// - two or more HTML + assets make one Site, keeping the file names
export async function ingest(payload: DropPayload): Promise<IngestResult> {
  const result: IngestResult = { drafts: [], errors: [] }

  for (const zip of payload.loose.filter((f) => isZipName(f.name))) {
    try {
      const files = await unzipFiles(zip)
      attempt(zip.name, result, () => toDraft(zip.name, stemOf(zip.name), files, 'fixed'))
    } catch (e) {
      if (!(e instanceof DraftError)) throw e
      result.errors.push({ name: zip.name, message: e.message })
    }
  }

  const rest = payload.loose.filter((f) => !isZipName(f.name))
  const htmls = rest.filter((f) => isHtmlName(f.name))
  const assets = rest.filter((f) => !isHtmlName(f.name))
  if (assets.length === 0) {
    for (const html of htmls) {
      attempt(html.name, result, () =>
        toDraft(html.name, stemOf(html.name), [{ path: 'index.html', file: html }], 'html'),
      )
    }
  } else if (htmls.length === 0) {
    for (const f of assets) {
      result.errors.push({
        name: f.name,
        message: 'Drop it together with an HTML, or add it from files… in the site menu',
      })
    }
  } else if (htmls.length === 1) {
    const html = htmls[0] as File
    attempt(html.name, result, () =>
      toDraft(
        html.name,
        stemOf(html.name),
        [{ path: 'index.html', file: html }, ...assets.map((file) => ({ path: file.name, file }))],
        'html',
      ),
    )
  } else {
    const label = `${htmls.length} HTML + ${assets.length} files`
    attempt(label, result, () =>
      toDraft(
        label,
        '',
        rest.map((file) => ({ path: file.name, file })),
        'entry',
      ),
    )
  }

  for (const d of payload.dirs) {
    attempt(d.name, result, () => toDraft(d.name, d.name, d.files, 'dir'))
  }
  return result
}
