import type { SiteDraft } from './lib/ingest'

// An upload queue entry (UI only). A successful entry is removed from the queue right away
// and shown through the list and a toast, so there is no done state
export interface UploadItem {
  key: string
  filename: string
  state: 'uploading' | 'error'
  message?: string
  // false for validation errors (non-HTML / too large), which a retry cannot fix
  retryable: boolean
  // Kept for retrying a retryable error
  file?: File
  // Draft sent as one site (the Ingest result. Kept so a retry sends the same thing again)
  draft?: SiteDraft
  // replace is a replace of an existing site, asset adds an asset belonging to a site.
  // The success toast's text and action differ from upload
  kind: 'upload' | 'replace' | 'asset'
  // The replace target for kind === 'replace' / the owning site for kind === 'asset'.
  // Used for retries and the toast (undo)
  target?: SiteMeta
}

export interface SiteMeta {
  id: string
  title: string
  sourceName: string
  size: number
  published: boolean
  createdAt: string
  updatedAt: string
  // Whether there is a past Version to go back to
  hasHistory: boolean
  // Owning Folder (null = unfiled)
  folderId: string | null
}

// Same shape as FolderMeta in the server's src/types.ts
export interface FolderMeta {
  id: string
  name: string
  position: number
  siteCount: number
}

export interface FolderListResponse {
  folders: FolderMeta[]
  unfiledCount: number
}

// Folder bar selection (null = all)
export type FolderSelection = string | 'unfiled' | null

export interface VersionMeta {
  version: number
  title: string
  size: number
  createdAt: string
  current: boolean
  // That Version's Entry. Used for the history preview URL
  entryPath: string
  // Number of File rows in that Version (a legacy asset pair counts as 2)
  fileCount: number
}

export interface VersionListResponse {
  versions: VersionMeta[]
}

// One file of a Version (GET /api/sites/:id/versions/:v/files)
export interface VersionFileMeta {
  path: string
  // The same key means the same content (content-addressed or legacy key). Used for comparison
  objectKey: string
  // null for legacy-key rows
  sha256: string | null
  size: number
  contentType: string
  // The paired Display name Path, set only on the canonical (ASCII) row of a legacy asset.
  // When listing and when zipping, skip this row and use only the Display name row
  aliasOf?: string
}

export interface VersionFilesResponse {
  entry: string
  files: VersionFileMeta[]
}

// The current Version's tree (GET /api/sites/:id/files). version is passed as the base of PATCH
// /tree
export interface SiteFilesResponse extends VersionFilesResponse {
  version: number
}

export interface SiteListResponse {
  sites: SiteMeta[]
  total: number
}
