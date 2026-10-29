import { encodePath } from '../../shared/files'
import type {
  FolderListResponse,
  FolderMeta,
  FolderSelection,
  SiteFilesResponse,
  SiteListResponse,
  SiteMeta,
  VersionFilesResponse,
  VersionListResponse,
} from './types'

// X-Drop-Request is the custom header required by the /api CSRF defense
const headers = { 'X-Drop-Request': '1' }

async function ensureOk(res: Response): Promise<Response> {
  // Under drop's own token auth, not logged in or the login expired. Go to the login page
  // (with Access, /login redirects to /sites and Access at the edge handles the login)
  if (res.status === 401) {
    // Read it from globalThis so it also type-checks under the test types (which lack the DOM)
    ;(globalThis as unknown as { location: { assign(url: string): void } }).location.assign(
      '/login',
    )
    throw new Error('Login required')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `request failed: ${res.status}`)
  }
  return res
}

export async function listSites(
  q: string,
  folder: FolderSelection = null,
): Promise<SiteListResponse> {
  const params = new URLSearchParams()
  if (q !== '') params.set('q', q)
  if (folder !== null) params.set('folder', folder)
  // The API returns at most PAGE_SIZE per call. Fetch the first page to learn the total, then the
  // rest in parallel
  const page = async (offset: number): Promise<SiteListResponse> => {
    const p = new URLSearchParams(params)
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(offset))
    const res = await ensureOk(await fetch(`/api/sites?${p}`, { headers }))
    return res.json()
  }
  const first = await page(0)
  const offsets = []
  for (let o = PAGE_SIZE; o < first.total; o += PAGE_SIZE) offsets.push(o)
  const rest = await Promise.all(offsets.map(page))
  return { sites: [first, ...rest].flatMap((r) => r.sites), total: first.total }
}

const PAGE_SIZE = 100

// For matching re-drops (exact sourceName match, across Folders). Fetching the whole list just to
// match a name is wasteful, so this uses its own route
export async function findSitesBySourceName(sourceName: string): Promise<SiteMeta[]> {
  const params = new URLSearchParams({ sourceName })
  const res = await ensureOk(await fetch(`/api/sites?${params}`, { headers }))
  const body = (await res.json()) as SiteListResponse
  return body.sites
}

export async function getSite(id: string): Promise<SiteMeta> {
  const res = await ensureOk(await fetch(`/api/sites/${id}`, { headers }))
  return res.json()
}

export async function uploadSite(file: File, folderId?: string): Promise<SiteMeta> {
  const form = new FormData()
  form.append('file', file)
  if (folderId) form.append('folderId', folderId)
  const res = await ensureOk(await fetch('/api/sites', { method: 'POST', headers, body: form }))
  return res.json()
}

export async function updateSite(
  id: string,
  patch: { published?: boolean; folderId?: string | null },
): Promise<SiteMeta> {
  const res = await ensureOk(
    await fetch(`/api/sites/${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
  return res.json()
}

// Sending a tree (used from app/src/lib/upload.ts). Returns the hashes of Objects the Site lacks
export async function fetchMissingObjects(id: string, sha256: string[]): Promise<string[]> {
  const res = await ensureOk(
    await fetch(`/api/sites/${id}/objects/missing`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256 }),
    }),
  )
  return ((await res.json()) as { missing: string[] }).missing
}

// Put an Object at its content address. The server (R2) verifies the hash
export async function putObject(id: string, sha256: string, file: File): Promise<void> {
  await ensureOk(
    await fetch(`/api/sites/${id}/objects/${sha256}`, { method: 'PUT', headers, body: file }),
  )
}

export interface TreeFileRef {
  path: string
  sha256: string
  size: number
}

// Commit the tree as one Version. With create, this makes a new Site
export async function commitTree(
  id: string,
  entry: string,
  files: TreeFileRef[],
  create?: { sourceName: string; folderId?: string },
): Promise<SiteMeta> {
  const res = await ensureOk(
    await fetch(`/api/sites/${id}/tree`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry, files, create }),
    }),
  )
  return res.json()
}

// Error for telling apart a 409 (the Version the changes were based on is not the latest)
export class StaleTreeError extends Error {}

// Apply changes to the current tree to make a new Version. StaleTreeError if base is not the latest
export async function patchTree(
  id: string,
  body: { base: number; put?: TreeFileRef[]; delete?: string[]; entry?: string },
): Promise<SiteMeta> {
  const res = await fetch(`/api/sites/${id}/tree`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409)
    throw new StaleTreeError('It was updated elsewhere, so the list was reloaded')
  return (await ensureOk(res)).json()
}

// The current Version's tree (the file tree dialog)
export async function fetchSiteFiles(id: string): Promise<SiteFilesResponse> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/files`, { headers }))
  return res.json()
}

export async function deleteSite(id: string): Promise<void> {
  await ensureOk(await fetch(`/api/sites/${id}`, { method: 'DELETE', headers }))
}

export async function replaceSiteFile(id: string, file: File): Promise<SiteMeta> {
  const form = new FormData()
  form.append('file', file)
  const res = await ensureOk(
    await fetch(`/api/sites/${id}/file`, { method: 'PUT', headers, body: form }),
  )
  return res.json()
}

// Without version, restore the one before the latest (for the toast's undo)
export async function restoreSite(id: string, version?: number): Promise<SiteMeta> {
  const init: RequestInit =
    version === undefined
      ? { method: 'POST', headers }
      : {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version }),
        }
  const res = await ensureOk(await fetch(`/api/sites/${id}/restore`, init))
  return res.json()
}

export async function listVersions(id: string): Promise<VersionListResponse> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/versions`, { headers }))
  return res.json()
}

// A Version's file list and Entry (for the per-file diff)
export async function fetchVersionFiles(
  id: string,
  version: number,
): Promise<VersionFilesResponse> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/versions/${version}/files`, { headers }))
  return res.json()
}

// Read the original of one file in a Version as text (used only for text types)
export async function fetchVersionFile(id: string, version: number, path: string): Promise<string> {
  const res = await ensureOk(
    await fetch(`/api/sites/${id}/versions/${version}/files/${encodePath(path)}`, { headers }),
  )
  return res.text()
}

// Read the original of one file in a Version as bytes (zip download of a multi-file Site)
export async function fetchVersionFileBytes(
  id: string,
  version: number,
  path: string,
): Promise<Uint8Array> {
  const res = await ensureOk(
    await fetch(`/api/sites/${id}/versions/${version}/files/${encodePath(path)}`, { headers }),
  )
  return new Uint8Array(await res.arrayBuffer())
}

// Root of the history preview file tree (/p/:id/h/{token}/). Append `{version}/{entryPath}` and
// load it in the iframe. The token lasts as long as the admin's Access session and covers every
// Version of the Site
export async function fetchHistoryBase(id: string): Promise<string> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/history-base`, { headers }))
  const body = (await res.json()) as { base: string }
  return body.base
}

// Issue the Entry URL for the preview sheet's iframe (for a private Site a signed token goes in the
// path)
export async function fetchPreviewUrl(id: string): Promise<string> {
  return (await fetchPreview(id)).url
}

// Root of the file tree (trailing /). Used to open a Page in a new tab (a Page cannot be opened
// with the admin cookie)
export async function fetchFilesBase(id: string): Promise<string> {
  return (await fetchPreview(id)).base
}

async function fetchPreview(id: string): Promise<{ url: string; base: string }> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/preview-url`, { headers }))
  return res.json()
}

// Issue a share link that shows a private site for 10 minutes without publishing it.
// The value comes from the server, so callers must not touch the clipboard after this await
// (transient activation expires and Safari and others throw NotAllowedError)
export async function fetchShareLink(id: string): Promise<{ url: string; expiresIn: number }> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/share-link`, { headers }))
  return (await res.json()) as { url: string; expiresIn: number }
}

export async function downloadSite(id: string): Promise<Blob> {
  const res = await ensureOk(await fetch(`/api/sites/${id}/download`, { headers }))
  return res.blob()
}

export async function listFolders(): Promise<FolderListResponse> {
  const res = await ensureOk(await fetch('/api/folders', { headers }))
  return res.json()
}

export async function createFolder(name: string): Promise<FolderMeta> {
  const res = await ensureOk(
    await fetch('/api/folders', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return res.json()
}

export async function updateFolder(
  id: string,
  patch: { name?: string; position?: number },
): Promise<FolderMeta> {
  const res = await ensureOk(
    await fetch(`/api/folders/${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
  return res.json()
}

export async function deleteFolder(id: string): Promise<void> {
  await ensureOk(await fetch(`/api/folders/${id}`, { method: 'DELETE', headers }))
}
