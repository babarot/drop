import { useDraggable } from '@dnd-kit/core'
import { Check, ChevronDown, EllipsisVertical, Folder } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type SiteMenuItem, siteMenuItems } from '../../../shared/site-menu'
import type { SiteMeta } from '../types'
import { SiteThumb } from './site-thumb'

// open is a standalone button in .actions and copy url / copy share link are in the split button in
// .actions, so they are left out of the ⋮ menu. shared/site-menu.ts is the source of truth for
// labels and presence, and the split button's items come from there too (ADR-001: only how to group
// them is each surface's call)
const HIDDEN_IN_LIST = ['open', 'copy-url', 'share-link'] as const
// Items shown in the split button's dropdown (in this order)
const COPY_KEYS = ['copy-url', 'share-link'] as const

// How a click adds to the Selection: toggle this card, or select the range from the last card
// toggled (Shift)
export type SelectHow = 'toggle' | 'range'

interface Props {
  site: SiteMeta
  // In the Selection
  selected: boolean
  // Any Site is selected. While selecting, a plain click on the card toggles it and only the title
  // text opens the preview
  selecting: boolean
  // Carried along by a drag that started on another selected card (dimmed like the dragged one)
  dimmed: boolean
  onSelect: (site: SiteMeta, how: SelectHow) => void
  // Label showing the owning Folder in the all-sites view (not shown if undefined)
  folderName?: string
  onPreview: (site: SiteMeta) => void
  onCopied: () => void
  // Issue a short-lived share link. Copying happens on App's toast (a new click)
  onShareLink: (site: SiteMeta) => void
  onTogglePublished: (site: SiteMeta) => void
  onDelete: (site: SiteMeta) => void
  onReplace: (site: SiteMeta, file: File) => void
  onDownload: (site: SiteMeta) => void
  onHistory: (site: SiteMeta) => void
  onFiles: (site: SiteMeta) => void
  onMove: (site: SiteMeta) => void
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

export function SiteCard({
  site,
  selected,
  selecting,
  dimmed,
  onSelect,
  folderName,
  onPreview,
  onCopied,
  onShareLink,
  onTogglePublished,
  onDelete,
  onReplace,
  onDownload,
  onHistory,
  onFiles,
  onMove,
}: Props) {
  const publicUrl = `${location.origin}/p/${site.id}`
  // The split button's items. Both the labels and the rule "no copy share link for published sites"
  // follow shared/site-menu.ts (the same single source of truth as the ⋮ side)
  const copyItems = siteMenuItems(site)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  // A card has two popovers (the ⋮ menu and the copy url split button).
  // Open together they overlap, so one state holds which is open, making them exclusive
  const [openMenu, setOpenMenu] = useState<'main' | 'copy' | null>(null)
  // DnD move to the folder bar. Told apart from clicks (preview etc.) by the sensors'
  // activationConstraint (mouse 8px / touch long-press 200ms)
  const draggable = useDraggable({ id: `site-${site.id}` })

  useEffect(() => {
    if (!openMenu) return
    const container = openMenu === 'main' ? menuRef : splitRef
    const onMouseDown = (e: MouseEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu])

  function renderMenuItem(item: SiteMenuItem) {
    switch (item.key) {
      case 'share-link':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onShareLink(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'toggle-published':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onTogglePublished(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'view-raw':
        return (
          <a
            key={item.key}
            role="menuitem"
            className="menu-item"
            href={`/p/${site.id}/source`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpenMenu(null)}
          >
            {item.label}
          </a>
        )
      case 'download':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onDownload(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'replace':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              replaceInputRef.current?.click()
            }}
          >
            {item.label}
          </button>
        )
      case 'files':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onFiles(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'move':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onMove(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'history':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              onHistory(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'delete':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item danger"
            onClick={() => {
              setOpenMenu(null)
              onDelete(site)
            }}
          >
            {item.label}
          </button>
        )
      case 'open':
      case 'copy-url':
        // Already excluded from ⋮. This is reached only from the split button's dropdown
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpenMenu(null)
              navigator.clipboard.writeText(publicUrl)
              onCopied()
            }}
          >
            {item.label}
          </button>
        )
      default: {
        const _exhaustive: never = item.key
        return _exhaustive
      }
    }
  }

  // Clicks on the card body. The title button handles the preview itself (and its click bubbles
  // here), so this only handles the selecting cases: a modifier click anywhere, or any click
  // outside the title while selecting. The controls in .actions and the check are left alone
  const onCardClick = (e: React.MouseEvent) => {
    const target = e.target as Element
    if (target.closest('.actions, .select-check')) return
    if (e.shiftKey) {
      onSelect(site, 'range')
    } else if (e.metaKey || e.ctrlKey) {
      onSelect(site, 'toggle')
    } else if (selecting && !target.closest('.title')) {
      onSelect(site, 'toggle')
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit's attributes give it role="button"; the click is a mouse shortcut, and .select-check is the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: same as above, keyboard users select with .select-check
    <div
      ref={draggable.setNodeRef}
      {...draggable.attributes}
      {...draggable.listeners}
      data-site-id={site.id}
      className={`card${draggable.isDragging || dimmed ? ' dragging' : ''}${selected ? ' selected' : ''}`}
      onClick={onCardClick}
      // Shift+click would otherwise select the text between the two clicks. dnd-kit's MouseSensor
      // listens on onMouseDown too, so pass the event on to it
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault()
        draggable.listeners?.onMouseDown?.(e)
      }}
    >
      {/* The way into the Selection without a modifier key (and on touch, the only way). Its
          z-index puts it above the title's stretched ::after, so the click reaches it */}
      <button
        type="button"
        className="select-check"
        aria-label={selected ? `deselect "${site.title}"` : `select "${site.title}"`}
        aria-pressed={selected}
        onClick={(e) => onSelect(site, e.shiftKey ? 'range' : 'toggle')}
      >
        <Check size={13} strokeWidth={3} />
      </button>
      {/* Before the title, so the title's stretched ::after paints over it and a click on the
          thumbnail opens the preview sheet like the rest of the card */}
      <SiteThumb site={site} />
      {/* stretched link: ::after spreads the title button over the whole card, so a card click
          opens the preview sheet */}
      <button
        type="button"
        className="title"
        title={site.title}
        onClick={(e) => {
          // A modifier click selects instead (handled by onCardClick)
          if (!(e.shiftKey || e.metaKey || e.ctrlKey)) onPreview(site)
        }}
      >
        {site.title}
      </button>
      <div className="meta">
        {site.published ? <span className="published">● public</span> : <span>○ private</span>}
        <span>{formatSize(site.size)}</span>
        <span>{formatDate(site.updatedAt)}</span>
      </div>
      {folderName && (
        <span className="folder-tag">
          <Folder size={11} />
          {folderName}
        </span>
      )}
      <div className="actions">
        <a className="btn" href={`/p/${site.id}`} target="_blank" rel="noreferrer">
          open
        </a>
        <div className="split" ref={splitRef}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              navigator.clipboard.writeText(publicUrl)
              onCopied()
            }}
          >
            copy
          </button>
          {/* A private site can be handed out two ways (the normal URL for yourself and a
              short-lived link valid for 10 minutes). A published site has only the normal URL,
              so no chevron */}
          {!site.published && (
            <button
              type="button"
              className="btn split-toggle"
              aria-label="choose how to share"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'copy'}
              onClick={() => setOpenMenu((v) => (v === 'copy' ? null : 'copy'))}
            >
              <ChevronDown size={13} />
            </button>
          )}
          {openMenu === 'copy' && (
            <div className="menu-list" role="menu">
              {COPY_KEYS.map((key) => {
                const item = copyItems.find((i) => i.key === key)
                return item ? renderMenuItem(item) : null
              })}
            </div>
          )}
        </div>
        <div className="menu" ref={menuRef}>
          <button
            type="button"
            className="btn icon"
            aria-label="actions menu"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'main'}
            onClick={() => setOpenMenu((v) => (v === 'main' ? null : 'main'))}
          >
            <EllipsisVertical size={15} />
          </button>
          {openMenu === 'main' && (
            <div className="menu-list" role="menu">
              {siteMenuItems(site, HIDDEN_IN_LIST).flatMap((item) => {
                // Put a separator only right before the danger item (delete) (a look specific to
                // panel-style UI)
                const node = renderMenuItem(item)
                return item.key === 'delete'
                  ? [<hr key="divider" className="menu-divider" />, node]
                  : [node]
              })}
            </div>
          )}
        </div>
      </div>
      <input
        ref={replaceInputRef}
        type="file"
        accept="text/html,.html,.htm"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onReplace(site, file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
