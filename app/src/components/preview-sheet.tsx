import { EllipsisVertical } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IFRAME_SANDBOX } from '../../../shared/security'
import { type SiteMenuItem, siteMenuItems } from '../../../shared/site-menu'
import { fetchPreviewUrl } from '../api'
import { useScrollLock } from '../scroll-lock'
import { currentMode } from '../theme'
import type { SiteMeta } from '../types'

interface Props {
  site: SiteMeta
  onCopied: () => void
  onShareLink: (site: SiteMeta) => void
  onClose: () => void
  onTogglePublished: (site: SiteMeta) => void
  onDelete: (site: SiteMeta) => void
  onReplace: (site: SiteMeta, file: File) => void
  onDownload: (site: SiteMeta) => void
  onHistory: (site: SiteMeta) => void
  onFiles: (site: SiteMeta) => void
  onMove: (site: SiteMeta) => void
}

const DRAG_THRESHOLD = 80

// Preview panel that slides in from the right on a card click (a bottom sheet on mobile). Its
// content is just the same <iframe src="/p/:id/f/index.html" sandbox> as the production shell
// (/p/:id), so rendering and the isolation contract (the response's CSP sandbox) are shared with
// production
export function PreviewSheet({
  site,
  onCopied,
  onShareLink,
  onClose,
  onTogglePublished,
  onDelete,
  onReplace,
  onDownload,
  onHistory,
  onFiles,
  onMove,
}: Props) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dragStartY = useRef(0)
  const dragCurrentY = useRef(0)
  const isDragging = useRef(false)
  // onClose changes identity when the parent re-renders, so the history effect reads it through a
  // ref
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useScrollLock()

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    // The iframe takes up most of the preview, and a mousedown inside it does not bubble
    // up to the parent document. Close as soon as focus moves into the iframe
    const onBlur = () => {
      setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') setMenuOpen(false)
      }, 0)
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [menuOpen])

  function renderMenuItem(item: SiteMenuItem) {
    switch (item.key) {
      case 'open':
        return (
          <a
            key={item.key}
            role="menuitem"
            className="pill"
            href={`/p/${site.id}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenuOpen(false)}
          >
            {item.label}
          </a>
        )
      case 'copy-url':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="pill"
            onClick={() => {
              setMenuOpen(false)
              navigator.clipboard.writeText(`${location.origin}/p/${site.id}`)
              onCopied()
            }}
          >
            {item.label}
          </button>
        )
      case 'share-link':
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            href={`/p/${site.id}/source`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenuOpen(false)}
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill"
            onClick={() => {
              setMenuOpen(false)
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
            className="pill danger"
            onClick={() => {
              setMenuOpen(false)
              onDelete(site)
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

  useEffect(() => {
    // Detect backdrop clicks. With pointerdown, touch also closes immediately without the delay
    // of emulated mouse events
    const onPointerDown = (e: PointerEvent) => {
      if (!sheetRef.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    // So the mobile back gesture (Android back / edge swipe) does not leave the list entirely,
    // push the sheet as a history entry so back only closes it
    history.pushState({ sheet: true }, '')
    const onPopState = (e: PopStateEvent) => {
      // Do not close on a pop to a sheet state (when entries are duplicated, e.g. by a StrictMode
      // remount)
      if (!e.state?.sheet) onCloseRef.current()
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      // When closed by anything other than back (Esc / backdrop / drag), remove the pushed entry
      if (history.state?.sheet) history.back()
    }
  }, [])

  useEffect(() => {
    let alive = true
    setSrc(null)
    setError(null)
    fetchPreviewUrl(site.id)
      .then((url) => {
        if (!alive) return
        // Same contract as the shell: only an explicit theme is passed in the Page query (none
        // follows the OS)
        const mode = currentMode()
        const u = new URL(url, location.origin)
        if (mode !== 'auto') u.searchParams.set('theme', mode)
        setSrc(u.pathname + u.search)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load preview')
      })
    return () => {
      alive = false
    }
  }, [site.id])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    dragStartY.current = touch.clientY
    isDragging.current = false
    dragCurrentY.current = 0
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    const deltaY = touch.clientY - dragStartY.current
    if (deltaY <= 0) {
      if (sheetRef.current) sheetRef.current.style.transform = ''
      return
    }
    isDragging.current = true
    dragCurrentY.current = deltaY
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'none'
      sheetRef.current.style.transform = `translateY(${deltaY}px)`
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    const el = sheetRef.current
    if (!el) return
    if (isDragging.current && dragCurrentY.current > DRAG_THRESHOLD) {
      el.style.transition = 'transform 200ms ease-out'
      el.style.transform = 'translateY(100%)'
      el.addEventListener('transitionend', () => onClose(), { once: true })
    } else {
      el.style.transition = 'transform 200ms ease-out'
      el.style.transform = 'translateY(0)'
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = ''
          el.style.transform = ''
        },
        { once: true },
      )
    }
    isDragging.current = false
    dragCurrentY.current = 0
  }, [onClose])

  return (
    <div className="sheet-overlay">
      <div
        className="sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={site.title}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <button type="button" className="btn icon" onClick={onClose} aria-label="close">
            ✕
          </button>
          <h2 title={site.title}>{site.title}</h2>
          {site.published ? (
            <span className="sheet-status published">● public</span>
          ) : (
            <span className="sheet-status">○ private</span>
          )}
          <div className={`control-stack${menuOpen ? ' open' : ''}`} ref={menuRef}>
            <button
              type="button"
              className="pill icon"
              aria-label="actions menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <EllipsisVertical size={15} />
            </button>
            {menuOpen && (
              <div className="stack-items" role="menu">
                {siteMenuItems(site).map(renderMenuItem)}
              </div>
            )}
          </div>
        </div>
        {error && <p className="error sheet-note">{error}</p>}
        {src !== null ? (
          <iframe className="sheet-frame" src={src} sandbox={IFRAME_SANDBOX} title={site.title} />
        ) : (
          !error && <p className="dialog-note sheet-note">loading…</p>
        )}
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
