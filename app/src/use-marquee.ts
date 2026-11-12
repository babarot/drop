import { useEffect, useRef, useState } from 'react'

export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

// A mousedown on these never starts a marquee: a press on a card is a click or a DnD, and the
// controls and the bars around the list have meanings of their own
const EXCLUDE =
  'button, a, input, textarea, select, label, [role="menu"], .card, .brand, .dropzone, .search, .folder-bar, .upload-queue, .toast, .selection-bar, .drop-dock'

// Movement below this is a click on empty space (which clears the Selection), not a marquee
const THRESHOLD = 4

interface Options {
  enabled: boolean
  selection: Set<string>
  onSelect: (ids: Set<string>) => void
}

// Rubber-band selection, as in Finder: dragging from empty space selects the cards the rectangle
// touches. With ⌘/Ctrl/Shift held, it adds to the current Selection instead of replacing it.
// Mouse only: on touch, a drag on empty space is a scroll. Cards are found by data-site-id, and
// their rects are read on every move, so a scroll during the drag is taken into account
export function useMarquee({ enabled, selection, onSelect }: Options): MarqueeRect | null {
  const [rect, setRect] = useState<MarqueeRect | null>(null)
  const latest = useRef({ selection, onSelect })
  latest.current = { selection, onSelect }

  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (!(e.target instanceof Element) || e.target.closest(EXCLUDE)) return
      const x0 = e.clientX
      const y0 = e.clientY
      const additive = e.metaKey || e.ctrlKey || e.shiftKey
      const base = additive ? new Set(latest.current.selection) : new Set<string>()
      let moved = false

      const onMove = (m: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(m.clientX - x0, m.clientY - y0) < THRESHOLD) return
          moved = true
          document.body.classList.add('marquee-active')
          window.getSelection()?.removeAllRanges()
        }
        const left = Math.min(x0, m.clientX)
        const top = Math.min(y0, m.clientY)
        const right = Math.max(x0, m.clientX)
        const bottom = Math.max(y0, m.clientY)
        setRect({ left, top, width: right - left, height: bottom - top })
        const next = new Set(base)
        for (const el of document.querySelectorAll<HTMLElement>('[data-site-id]')) {
          const r = el.getBoundingClientRect()
          const id = el.dataset.siteId
          if (id && r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
            next.add(id)
          }
        }
        latest.current.onSelect(next)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('marquee-active')
        setRect(null)
        // A plain click on empty space clears the Selection (with a modifier it keeps it)
        if (!moved && !additive) latest.current.onSelect(new Set())
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [enabled])

  return rect
}
