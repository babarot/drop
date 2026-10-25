import { EllipsisVertical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  onCopied: () => void
}

// Instructions to paste into an AI tool. The llms.txt URL is the substance, so instead of
// hardcoding it (which would differ per environment) build it from location.origin (locally it
// becomes a localhost URL and can be used as is for testing)
const promptText = () =>
  `Generate a single-file HTML following the conventions in ${location.origin}/llms.txt.`

// General-purpose menu in the brand bar. For now it only has AI generation items (copying the
// prompt and showing the conventions), but it is meant to grow into the place for app-wide items
export function BrandMenu({ onCopied }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="menu" ref={menuRef}>
      <button
        type="button"
        className="brand-icon"
        aria-label="menu"
        title="menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <EllipsisVertical size={15} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={async () => {
              setOpen(false)
              await navigator.clipboard.writeText(promptText())
              onCopied()
            }}
          >
            copy prompt
          </button>
          <a
            role="menuitem"
            className="menu-item"
            href="/llms.txt"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            view llms.txt
          </a>
        </div>
      )}
    </div>
  )
}
