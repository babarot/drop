import { useEffect, useRef, useState } from 'react'
import { IFRAME_SANDBOX } from '../../../shared/security'
import { fetchPreviewUrl } from '../api'
import { currentMode } from '../theme'
import type { SiteMeta } from '../types'

// Layout width the thumbnail renders the Page at before scaling it down to the card, so the card
// shows the desktop layout rather than the Page's mobile styles
const RENDER_WIDTH = 1024

// preview-url issues a token per call. Keep one request per Version of a Site for this session,
// so scrolling a card out and back in does not issue another
const urlCache = new Map<string, Promise<string>>()

function previewUrl(site: SiteMeta): Promise<string> {
  const key = `${site.id}:${site.updatedAt}`
  let p = urlCache.get(key)
  if (!p) {
    p = fetchPreviewUrl(site.id)
    p.catch(() => urlCache.delete(key))
    urlCache.set(key, p)
  }
  return p
}

// Scaled-down live preview at the top of a card. The iframe is the same sandboxed
// /p/:id/f/... as the preview sheet, so it shares the isolation contract. It exists only while the
// card is near the viewport, so a long list does not keep every Page running
export function SiteThumb({ site }: { site: SiteMeta }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const resize = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    resize.observe(el)
    const intersect = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: '200px 0px' },
    )
    intersect.observe(el)
    return () => {
      resize.disconnect()
      intersect.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    let alive = true
    previewUrl(site)
      .then((url) => {
        if (!alive) return
        // Same contract as the preview sheet: only an explicit theme goes in the query
        const mode = currentMode()
        const u = new URL(url, location.origin)
        if (mode !== 'auto') u.searchParams.set('theme', mode)
        setSrc(u.pathname + u.search)
      })
      .catch(() => {
        // Leave the placeholder. The preview sheet shows the error when the card is opened
      })
    return () => {
      alive = false
    }
  }, [visible, site])

  const scale = box ? box.w / RENDER_WIDTH : 0
  return (
    <div ref={wrapRef} className="thumb" aria-hidden="true">
      {visible && src && box && box.w > 0 && (
        <iframe
          src={src}
          sandbox={IFRAME_SANDBOX}
          title={`${site.title} thumbnail`}
          tabIndex={-1}
          loading="lazy"
          style={{
            width: RENDER_WIDTH,
            height: box.h / scale,
            transform: `scale(${scale})`,
          }}
        />
      )}
    </div>
  )
}
