import { Folder, Inbox } from 'lucide-react'
import { useEffect } from 'react'
import { useScrollLock } from '../scroll-lock'
import type { FolderMeta, SiteMeta } from '../types'

// Destination picker opened from "move to folder…" in the card menu.
// The main way to move without DnD (for keyboard users and users who miss the long-press drag)
interface Props {
  site: SiteMeta
  folders: FolderMeta[]
  unfiledCount: number
  onMove: (folderId: string | null) => void
  onCancel: () => void
}

export function MoveDialog({ site, folders, unfiledCount, onMove, onCancel }: Props) {
  useScrollLock()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const choices: { id: string | null; name: string; count: number; icon: React.ReactNode }[] = [
    { id: null, name: 'unfiled', count: unfiledCount, icon: <Inbox size={14} /> },
    ...folders.map((f) => ({
      id: f.id as string | null,
      name: f.name,
      count: f.siteCount,
      icon: <Folder size={14} />,
    })),
  ]

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true">
        <h2>Move "{site.title}" to</h2>
        {choices.map((c) => {
          const current = site.folderId === c.id
          return (
            <button
              key={c.id ?? 'unfiled'}
              type="button"
              className="choice"
              disabled={current}
              onClick={() => onMove(c.id)}
            >
              <span className="choice-title move-choice">
                {c.icon}
                {c.name}
                {current && <span className="choice-current">current</span>}
              </span>
              <span className="choice-meta">{c.count} sites</span>
            </button>
          )
        })}
        <button type="button" className="btn dialog-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}
