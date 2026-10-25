import { Folder } from 'lucide-react'
import { useEffect } from 'react'
import { useScrollLock } from '../scroll-lock'
import type { SiteMeta } from '../types'

interface Props {
  // The matched name (sourceName)
  name: string
  // Whether the update replaces the site's whole file set (a single loose HTML replaces only the
  // Entry)
  replacesTree?: boolean
  // Number of dropped files (shown when replacing)
  fileCount?: number
  matches: SiteMeta[]
  // Lookup so it is clear which one to update when same-named sites sit in Folders
  folderNames?: Map<string, string>
  onUpdate: (target: SiteMeta) => void
  onCreateNew: () => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}/${mm}/${dd}`
}

export function ConflictDialog({
  name,
  replacesTree = false,
  fileCount = 0,
  matches,
  folderNames,
  onUpdate,
  onCreateNew,
  onCancel,
}: Props) {
  useScrollLock()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true">
        <h2>"{name}" already exists</h2>
        <p className="dialog-note">
          {matches.length === 1
            ? 'Updating the existing site keeps its URL and publish state and replaces only the content.'
            : 'There are several sites with this name. Choose the one to update.'}
          {replacesTree &&
            ` The dropped files (${fileCount}) will replace the site's files (files not in the drop are gone from the new version and stay in earlier versions).`}
        </p>
        {matches.map((site, i) => (
          <button
            key={site.id}
            type="button"
            className="choice primary"
            onClick={() => onUpdate(site)}
            // biome-ignore lint/a11y/noAutofocus: intentional, so one Enter completes a drop
            autoFocus={i === 0}
          >
            <span className="choice-title">↻ update existing site</span>
            <span className="choice-meta">
              {site.title} · {site.published ? '● public' : '○ private'} · {formatSize(site.size)} ·{' '}
              {formatDate(site.updatedAt)}
              {site.folderId !== null && folderNames?.get(site.folderId) && (
                <span className="folder-tag">
                  <Folder size={11} />
                  {folderNames.get(site.folderId)}
                </span>
              )}
            </span>
          </button>
        ))}
        <button type="button" className="choice" onClick={onCreateNew}>
          <span className="choice-title">+ add as new site</span>
        </button>
        <button type="button" className="btn dialog-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}
