// The single definition of the site action menu (open, copy url, publish, view raw, download,
// replace, files, move to folder, history, delete).
// Which items exist, their labels, order and display conditions (hasHistory) are gathered here,
// so the items in the three places site-card.tsx / preview-sheet.tsx / views/shell.tsx do not
// drift apart (e.g. forgetting to add move to folder… in one of them).
// What a click actually does and how an item looks (button or link) differ across the three, so
// they are not defined here and are left to the callers.

export interface SiteMenuTarget {
  published: boolean
  hasHistory?: boolean
}

export type SiteMenuKey =
  | 'open'
  | 'copy-url'
  | 'share-link'
  | 'toggle-published'
  | 'view-raw'
  | 'download'
  | 'replace'
  | 'files'
  | 'move'
  | 'history'
  | 'delete'

export interface SiteMenuItem {
  key: SiteMenuKey
  label: string
  danger?: boolean
}

export function siteMenuItems(
  site: SiteMenuTarget,
  hidden: readonly SiteMenuKey[] = [],
): SiteMenuItem[] {
  const items: SiteMenuItem[] = [
    { key: 'open', label: 'open' },
    { key: 'copy-url', label: 'copy url' },
  ]
  // A short-lived share link only makes sense for a private site (for a published site, the
  // copy url result can be handed out as is). It is issued and goes straight to the clipboard, so
  // there is no ….
  // The expiry is shown after copying, not in the label
  if (!site.published) items.push({ key: 'share-link', label: 'copy share link' })
  items.push(
    { key: 'toggle-published', label: site.published ? 'unpublish' : 'publish' },
    { key: 'view-raw', label: 'view raw' },
    { key: 'download', label: 'download' },
    { key: 'replace', label: 'replace…' },
    { key: 'files', label: 'files…' },
    { key: 'move', label: 'move to folder…' },
  )
  if (site.hasHistory) items.push({ key: 'history', label: 'history…' })
  items.push({ key: 'delete', label: 'delete', danger: true })
  return items.filter((item) => !hidden.includes(item.key))
}

// The look of a pill (a menu item's button/link). views/shell.tsx (SSR) embeds it in <style> as
// is, and app/vite.config.ts injects it into index.html with the same injectTheme mechanism as
// themeCss in shared/theme.ts (a single source, so the two runtimes do not drift). How the menu
// opens and closes (CSS class + hover in SSR, conditional mounting in React) legitimately differs
// per runtime, so the placement and open/close rules of .control-stack/.stack-items are not
// included here and stay with each caller
export const siteMenuPillCss = `
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 12px;
  border-radius: 13px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text);
  cursor: pointer;
  text-decoration: none;
  font-family: inherit;
  box-shadow: var(--glass-shadow);
  transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.pill:hover { transform: scale(1.04); background: var(--bg-hover); }
.pill:active { transform: scale(0.97); }
/* The trigger is a ghost on the bar's surface: no outline, signaled by a round background
   on hover */
.pill.icon { width: 26px; min-width: 26px; padding: 0; border-color: transparent; background: transparent; box-shadow: none; }
.pill.icon:hover { background: var(--bg-hover); }
.pill.danger { color: var(--danger); }
.pill.danger:hover { background: var(--danger-bg); border-color: var(--danger-border); }
`
