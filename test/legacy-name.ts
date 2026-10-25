// Derive a legacy asset's canonical name from its display name (same rules as deriveAssetName in
// the old app/src/lib/asset-name.ts). The server re-derives with these rules and pairs only
// matching ones (findAliasPairs in src/lib/files.ts)
export async function legacyCanonical(display: string): Promise<string> {
  const name = display.normalize('NFC')
  const dot = name.lastIndexOf('.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))
  const hash = [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const stem = name
    .slice(0, dot)
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 40)
  const ext = name.slice(dot + 1).toLowerCase()
  return stem ? `${stem}-${hash}.${ext}` : `${hash}.${ext}`
}
