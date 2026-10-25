export interface SiteMeta {
  id: string
  title: string
  sourceName: string
  size: number
  published: boolean
  createdAt: string
  updatedAt: string
  // Whether there is a past version to go back to (= two or more versions)
  hasHistory: boolean
  // The folder it belongs to (null = unfiled)
  folderId: string | null
  // The number of the current Version. Included only in the list (GET /api/sites) and in responses
  // that commit a tree (PUT and PATCH /tree and so on). The CLI uses it to spot Sites that moved
  // ahead on drop's side, and takes the committed number as the synced version
  version?: number
}

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

export interface VersionMeta {
  version: number
  title: string
  size: number
  createdAt: string
  current: boolean
  // That version's Entry. Used in the history preview URL (/p/:id/h/{token}/{version}/{entryPath})
  entryPath: string
  // The number of File rows in that version (an old asset pair counts as two)
  fileCount: number
}

export interface VersionListResponse {
  versions: VersionMeta[]
}

// One file of a version (GET /api/sites/:id/versions/:v/files)
export interface VersionFileMeta {
  path: string
  // The same key means the same content (for content addresses and old keys alike). Used for
  // comparison
  objectKey: string
  // null for rows with an old key
  sha256: string | null
  size: number
  contentType: string
  // The pair's display-name Path, present only on the row of an old asset's canonical (ASCII) name.
  // When listing or adding to a zip, skip this row and use only the display-name row
  aliasOf?: string
}

export interface VersionFilesResponse {
  entry: string
  files: VersionFileMeta[]
}

// The current version's tree (GET /api/sites/:id/files). version is passed as the base of
// PATCH /tree
export interface SiteFilesResponse extends VersionFilesResponse {
  version: number
}

export interface SiteListResponse {
  sites: SiteMeta[]
  total: number
}

// How many versions to keep. Any excess is pruned oldest first on write (version numbers are never
// reused)
export const MAX_VERSIONS = 20
