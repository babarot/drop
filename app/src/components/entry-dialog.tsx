import { useEffect } from 'react'
import { useScrollLock } from '../scroll-lock'

interface Props {
  // What was dropped (directory name, zip file name, etc.)
  name: string
  // Paths of the Pages to choose from
  pages: string[]
  onChoose: (page: string) => void
  onCancel: () => void
}

// Dialog for choosing the Page shown first (the Entry). Shown for a drop with no index.html at the
// root and two or more HTML files (ADR-004).
// Built the same way as the conflict dialog
export function EntryDialog({ name, pages, onChoose, onCancel }: Props) {
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
        <h2>Page to show first for "{name}"</h2>
        <p className="dialog-note">
          There is no index.html. Choose the page to show first when the site is opened.
        </p>
        {pages.map((page, i) => (
          <button
            key={page}
            type="button"
            className={`choice${i === 0 ? ' primary' : ''}`}
            onClick={() => onChoose(page)}
            // biome-ignore lint/a11y/noAutofocus: intentional, so one Enter completes a drop
            autoFocus={i === 0}
          >
            <span className="choice-title">{page}</span>
          </button>
        ))}
        <button type="button" className="btn dialog-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}
