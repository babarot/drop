import { useEffect } from 'react'
import { useScrollLock } from '../scroll-lock'
import type { SiteMeta } from '../types'

interface Props {
  file: File
  site: SiteMeta
  onUpdate: () => void
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

// Guard against mistakes when the file chosen for replace has a name different from the site's
// sourceName. Not shown when they match (no added friction for correct use)
export function ReplaceMismatchDialog({ file, site, onUpdate, onCreateNew, onCancel }: Props) {
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
        <h2>File name does not match</h2>
        <p className="dialog-note">
          You are about to put "{file.name}" into the "{site.sourceName}" site.
        </p>
        <button
          type="button"
          className="choice primary"
          onClick={onUpdate}
          // biome-ignore lint/a11y/noAutofocus: intentional, so one Enter completes a replace
          autoFocus
        >
          <span className="choice-title">↻ update this site</span>
          <span className="choice-meta">
            {site.title} · {site.published ? '● public' : '○ private'} · {formatSize(site.size)} ·{' '}
            {formatDate(site.updatedAt)}
          </span>
        </button>
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
