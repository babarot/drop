// Site download (ADR-004). A single-HTML Site downloads that HTML,
// a multi-file Site downloads a zip. The zip is built in the browser (building it in the Worker is
// bound by the request's CPU time and memory. The 200MB limit is accepted as fitting in tab memory)

import { zipSync } from 'fflate'
import { downloadSite, fetchSiteFiles, fetchVersionFileBytes } from '../api'
import type { VersionFileMeta } from '../types'

// How many to fetch at once (same idea as sending in upload.ts)
const CONCURRENCY = 4

export const sanitizeFilename = (name: string) =>
  name.replace(/[/\\:*?"<>|]/g, '-').trim() || 'untitled'

export const archiveName = (sourceName: string) => `${sanitizeFilename(sourceName)}.zip`

// Paths to put in the zip. Both names of a legacy asset pair go in: the original HTML may refer to
// the canonical name (the one the old dialog presented as "the path that always works"), and with
// only one of them the reference breaks once extracted. The same content goes in twice, but
// dropping it again turns it back into a pair pointing at the same Object
export const archivePaths = (files: VersionFileMeta[]): string[] => files.map((f) => f.path)

// Put everything under one folder named after the Site (so it does not scatter when extracted).
// When dropped again, Ingest strips this folder, giving back a tree with the same Paths (unzipFiles
// in app/src/lib/ingest.ts)
export function buildArchive(
  sourceName: string,
  files: { path: string; bytes: Uint8Array }[],
): Uint8Array {
  const folder = sanitizeFilename(sourceName)
  return zipSync(Object.fromEntries(files.map((f) => [`${folder}/${f.path}`, f.bytes])))
}

// Content and name of the file to download. onProgress receives progress as a short message
export async function siteDownload(
  site: { id: string; sourceName: string },
  onProgress?: (message: string) => void,
): Promise<{ blob: Blob; filename: string }> {
  const tree = await fetchSiteFiles(site.id)
  const paths = archivePaths(tree.files)
  // A single-HTML Site downloads the HTML as before (the original Entry. /api/sites/:id/download)
  if (paths.length === 1) {
    return {
      blob: await downloadSite(site.id),
      filename: `${sanitizeFilename(site.sourceName)}.html`,
    }
  }

  const queue = [...paths]
  const files: { path: string; bytes: Uint8Array }[] = []
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        files.push({ path, bytes: await fetchVersionFileBytes(site.id, tree.version, path) })
        onProgress?.(`fetching ${files.length}/${paths.length}`)
      }
    }),
  )
  const zip = buildArchive(site.sourceName, files)
  return {
    blob: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    filename: archiveName(site.sourceName),
  }
}
