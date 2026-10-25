import { html, raw } from 'hono/html'
import { MAX_PAGE_SIZE } from '../../shared/files'
import { IFRAME_SANDBOX } from '../../shared/security'
import { type SiteMenuItem, siteMenuItems, siteMenuPillCss } from '../../shared/site-menu'
import { themeCss, themeInitScript } from '../../shared/theme'
import type { SiteMeta } from '../types'

// The shell (SSR for public sites). Theme tokens come from shared/theme.ts (light and dark,
// following the OS + an explicit setting in localStorage shared with the admin UI).
// The chrome is just a thin 40px bar, and the iframe fills the rest.
// The admin pills render only once the JWT is verified; visitors do not even see an empty slot.

const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); }
  body {
    display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
  }
  header {
    height: 40px; flex: none; display: flex; align-items: center; gap: 10px;
    padding: 0 14px; background: var(--bg-elevated); color: var(--text);
    border-bottom: 1px solid var(--border);
  }
  header .title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .admin { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  /* The look of .pill itself (including the .icon/.danger variants) is shared with
     siteMenuPillCss in shared/site-menu.ts (injected by injectTheme in app/vite.config.ts) */
  .status {
    font-size: 11px; color: var(--text-muted);
    display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  }
  .status .dot { color: var(--accent); }
  /* On mobile, give the width to the title and show the status as just the circle (the same
     symbol as the card list) */
  @media (max-width: 640px) {
    .status .status-label { display: none; }
  }
  /* The stack that gathers the actions: pills expand vertically below the trigger (the same
     pattern as img) */
  .control-stack { position: relative; z-index: 10; }
  .stack-items {
    position: absolute;
    top: 100%;
    right: 0;
    /* The gap from the trigger is padding (so the gap counts as hover and moving the cursor does
       not break it) */
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-6px);
    transition: opacity 0.18s ease, transform 0.18s ease;
  }
  .control-stack.open .stack-items {
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
  @media (hover: hover) {
    .control-stack:hover .stack-items {
      opacity: 1;
      pointer-events: auto;
      transform: none;
    }
  }
  .control-stack.open #stack-trigger { color: var(--text-muted); background: var(--bg-hover); }
  /* Match the shell theme so there is no white flash before loading or with transparent content */
  iframe { flex: 1; width: 100%; border: 0; background: var(--bg); }
`

// The shell's explicit theme (localStorage → data-theme) cannot reach the sandboxed iframe, so
// it is passed in the query of the Page delivery. Without an explicit setting, nothing happens and
// the iframe follows the OS (through the color-scheme injected on the raw side). Swapping src
// aborts the first request, which is acceptable since it only happens with an explicit setting
const themeSyncScript = `(function () {
  var t = document.documentElement.dataset.theme;
  if (t !== 'dark' && t !== 'light') return;
  var f = document.querySelector('iframe');
  if (!f) return;
  var src = f.getAttribute('src');
  f.src = src + (src.indexOf('?') < 0 ? '?' : '&') + 'theme=' + t;
})();`

// The same artwork as lucide ArrowLeft / EllipsisVertical
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
const BACK_ICON = `${SVG_OPEN}<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`
const MENU_ICON = `${SVG_OPEN}<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`

interface ShellViewProps {
  site: SiteMeta
  isAdmin: boolean
  iframeSrc: string
  nonce: string
  // Locally, the grayscale version is passed in (shared/favicon.ts). SSR can see the hostname on
  // the server, so unlike the admin SPA it ships no script to swap it
  faviconHref: string
}

export function renderShell({ site, isAdmin, iframeSrc, nonce, faviconHref }: ShellViewProps) {
  // Replacing forbidden characters in the file name follows the same rule as the admin UI
  // (sanitizeFilename in App.tsx)
  const downloadName = `${site.sourceName.replace(/[/\\:*?"<>|]/g, '-').trim() || 'untitled'}.html`

  // open is hidden because this site is already open. Which menu items exist, their labels, order
  // and the hasHistory switch share one definition with site-card.tsx / preview-sheet.tsx
  const menuItems = siteMenuItems(site, ['open'])
  const renderMenuPill = (item: SiteMenuItem) => {
    switch (item.key) {
      case 'copy-url':
        return html`<button class="pill" id="copy-url" type="button">${item.label}</button>`
      case 'share-link':
        return html`<button class="pill" id="share-link" type="button">${item.label}</button>`
      case 'toggle-published':
        return html`<button class="pill" id="toggle" type="button">${item.label}</button>`
      case 'view-raw':
        return html`<a class="pill" href="/p/${site.id}/source" target="_blank" rel="noreferrer">${item.label}</a>`
      case 'download':
        return html`<button class="pill" id="download" type="button">${item.label}</button>`
      case 'replace':
        return html`<button class="pill" id="replace" type="button">${item.label}</button>`
      case 'files':
        // File management is sent to the admin UI's dialog (the admin UI picks up ?files= and
        // opens it)
        return html`<a class="pill" href="/sites?files=${site.id}">${item.label}</a>`
      case 'move':
        // move to folder… is likewise sent to the admin UI's dialog (the admin UI picks up ?move=
        // and opens it)
        return html`<a class="pill" href="/sites?move=${site.id}">${item.label}</a>`
      case 'history':
        // restore means looking at "which version to go back to" before choosing, so the SSR bar
        // has no bare restore and sends you to the admin UI's history dialog instead (the admin UI
        // picks up ?history= and opens it automatically)
        return html`<a class="pill" href="/sites?history=${site.id}">${item.label}</a>`
      case 'delete':
        return html`<button class="pill danger" id="delete" type="button">${item.label}</button>`
      case 'open':
        // Already excluded via hidden (unreachable)
        return ''
      default: {
        const _exhaustive: never = item.key
        return _exhaustive
      }
    }
  }

  const adminScript = `
    const id = ${JSON.stringify(site.id)};
    const published = ${site.published};
    const downloadName = ${JSON.stringify(downloadName)};
    const sourceName = ${JSON.stringify(site.sourceName)};
    const headers = { 'Content-Type': 'application/json', 'X-Drop-Request': '1' };
    document.getElementById('toggle')?.addEventListener('click', async () => {
      await fetch('/api/sites/' + id, { method: 'PATCH', headers, body: JSON.stringify({ published: !published }) });
      location.reload();
    });
    // Report the result by swapping the label for a moment (this bar has no toast)
    const flash = (btn, text, restore) => {
      btn.textContent = text;
      setTimeout(() => { btn.textContent = restore; }, 1600);
    };
    document.getElementById('copy-url')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(location.origin + '/p/' + id);
      flash(e.currentTarget, 'copied', 'copy url');
    });
    // The short-lived link is issued by the server, so calling writeText after awaiting fetch
    // loses transient activation and fails with NotAllowedError in Safari and others.
    // Instead, reserve the write right in the click handler by passing a Promise to ClipboardItem
    // (on the React side, app/src/lib/clipboard.ts does the same).
    // If the reservation does not work, the user presses again (the second press gets a fresh
    // 10 minutes)
    document.getElementById('share-link')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const req = fetch('/api/sites/' + id + '/share-link', { headers: { 'X-Drop-Request': '1' } })
        .then((r) => { if (!r.ok) throw new Error('failed'); return r.json(); });
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': req.then((b) => new Blob([b.url], { type: 'text/plain' })) }),
        ]);
        flash(btn, 'copied (10 min)', 'copy share link');
      } catch (err) {
        flash(btn, 'copy failed', 'copy share link');
      }
    });
    document.getElementById('download')?.addEventListener('click', async () => {
      const res = await fetch('/api/sites/' + id + '/download', { headers: { 'X-Drop-Request': '1' } });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
    const replaceInput = document.getElementById('replace-file');
    const replaceBtn = document.getElementById('replace');
    replaceBtn?.addEventListener('click', () => replaceInput?.click());
    replaceInput?.addEventListener('change', async () => {
      const file = replaceInput.files?.[0];
      // Clear it first so that change fires even when the same file is picked again
      replaceInput.value = '';
      if (!file) return;
      if (file.size > ${MAX_PAGE_SIZE}) {
        alert('The file is larger than ${MAX_PAGE_SIZE / 1024 / 1024}MB');
        return;
      }
      // A name mismatch is likely a mistake, so ask for confirmation. Normalization follows the
      // same rule as the admin UI (sourceNameOf in App.tsx)
      const selectedName = file.name.replace(/\\.html?$/i, '') || 'untitled';
      if (selectedName !== sourceName) {
        const ok = confirm('The file name does not match. You are about to put "' + file.name + '" into the site "' + sourceName + '". Continue?');
        if (!ok) return;
      }
      replaceBtn.disabled = true;
      replaceBtn.textContent = 'replacing…';
      const form = new FormData();
      form.append('file', file);
      // No Content-Type, so the browser sets the FormData boundary
      const res = await fetch('/api/sites/' + id + '/file', { method: 'PUT', headers: { 'X-Drop-Request': '1' }, body: form }).catch(() => null);
      if (!res || !res.ok) {
        // Reloading on failure would swallow the error, so restore the button and let the user
        // pick again
        replaceBtn.disabled = false;
        replaceBtn.textContent = 'replace…';
        const body = res ? await res.json().catch(() => null) : null;
        alert('Replace failed' + (body && body.error ? ': ' + body.error : ''));
        return;
      }
      location.reload();
    });
    document.getElementById('delete')?.addEventListener('click', async () => {
      if (!confirm('Delete this site?')) return;
      await fetch('/api/sites/' + id, { method: 'DELETE', headers });
      location.href = '/sites';
    });
    const stack = document.getElementById('control-stack');
    const trigger = document.getElementById('stack-trigger');
    if (stack && trigger) {
      trigger.addEventListener('click', () => {
        stack.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(stack.classList.contains('open')));
      });
      document.addEventListener('click', (e) => {
        if (e.target instanceof Node && !stack.contains(e.target)) {
          stack.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }
  `

  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${site.title}</title>
    <link rel="icon" href="${raw(faviconHref)}" />
    <script nonce="${nonce}">${raw(themeInitScript)}</script>
    <style>${raw(themeCss + siteMenuPillCss + STYLE)}</style>
  </head>
  <body>
    ${
      /* Visitors get no bar, only full-screen content (the title is already in the tab and there
         is nothing for them to do). The bar is chrome for the admin's actions */
      isAdmin
        ? html`<header>
            <a class="pill icon" href="/sites" title="Back to sites" aria-label="Back to sites">${raw(BACK_ICON)}</a>
            <span class="title">${site.title}</span>
            <span class="admin">
              <span class="status" title="${site.published ? 'public' : 'private'}">
                ${
                  site.published
                    ? html`<span class="dot">●</span><span class="status-label">public</span>`
                    : html`<span>○</span><span class="status-label">private</span>`
                }
              </span>
              <div class="control-stack" id="control-stack">
                <button
                  class="pill icon"
                  id="stack-trigger"
                  type="button"
                  aria-label="Actions menu"
                  aria-haspopup="menu"
                  aria-expanded="false"
                >
                  ${raw(MENU_ICON)}
                </button>
                <div class="stack-items">${menuItems.map(renderMenuPill)}</div>
              </div>
              <input id="replace-file" type="file" accept="text/html,.html,.htm" hidden />
            </span>
            <script nonce="${nonce}">${raw(adminScript)}</script>
          </header>`
        : ''
    }
    <iframe src="${iframeSrc}" sandbox="${IFRAME_SANDBOX}" title="${site.title}"></iframe>
    <script nonce="${nonce}">${raw(themeSyncScript)}</script>
  </body>
</html>`
}

// An expired share link. It admits the site exists and answers "you can no longer see it", so
// it gives no hint of the content such as the title (see gone in src/routes/view.ts for when it
// is returned)
export function renderGone(faviconHref: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Link Expired</title>
    <link rel="icon" href="${raw(faviconHref)}" />
    <script>${raw(themeInitScript)}</script>
    <style>${raw(themeCss)}
      html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text-muted); }
      body {
        display: grid; place-items: center; text-align: center; padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
      }
    </style>
  </head>
  <body><p>410 Gone<br />This link has expired.</p></body>
</html>`
}

export function renderNotFound(faviconHref: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not Found</title>
    <link rel="icon" href="${raw(faviconHref)}" />
    <script>${raw(themeInitScript)}</script>
    <style>${raw(themeCss)}
      html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text-muted); }
      body {
        display: grid; place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
      }
    </style>
  </head>
  <body><p>404 Not Found</p></body>
</html>`
}
