// Where ADR-004's content-addressed objects live. The same content gets the same key and is shared
// across versions. The Site is the namespace, so deleting a Site only takes deleting its prefix
export const objectPrefix = (id: string) => `sites/${id}/objects/`

// Where old keys live. Nothing is written there anymore, but the pre-migration version bodies
// (versions/) and asset objects (assets/) remain, still pointed at by version_files (R2 is not
// moved. ADR-004). Deleting a Site deletes these prefixes too (deleteSiteObjects)
export const versionPrefix = (id: string) => `versions/${id}/`
export const assetPrefix = (id: string) => `assets/${id}/`
