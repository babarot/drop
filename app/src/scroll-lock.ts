import { useEffect } from 'react'

// Even with several overlays open at once, keep the lock until the last one closes
let locks = 0

// Hook that stops the background (body) from scrolling while an overlay is shown.
// iOS Safari sometimes ignores overflow: hidden on body alone, so it is applied to html too.
// The width of the vanished scrollbar is made up with padding to avoid a layout jump on desktop.
// overlay-open is a marker for turning off the backdrop-filter of visible glass (see styles.css)
export function useScrollLock() {
  useEffect(() => {
    locks += 1
    if (locks === 1) {
      const gutter = window.innerWidth - document.documentElement.clientWidth
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
      if (gutter > 0) document.body.style.paddingRight = `${gutter}px`
      document.body.classList.add('overlay-open')
    }
    return () => {
      locks -= 1
      if (locks === 0) {
        document.documentElement.style.overflow = ''
        document.body.style.overflow = ''
        document.body.style.paddingRight = ''
        document.body.classList.remove('overlay-open')
      }
    }
  }, [])
}
