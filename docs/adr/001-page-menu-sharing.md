# ADR-001: What the site action menu shares

## Status

Accepted

## Context

The action menu for a site (open, copy url, publish/unpublish, view raw, download,
replace…, assets…, move to folder…, history…, delete) is implemented separately in
three places.

1. `app/src/components/site-card.tsx` — the dropdown on a list card (`.menu-list`/`.menu-item`)
2. `app/src/components/preview-sheet.tsx` — the pill stack in the preview sheet (`.control-stack`/`.stack-items`/`.pill`)
3. `src/views/shell.tsx` — the SSR admin bar shown when `/p/:id` is opened directly. It does not use React;
   it is written in plain JS (`adminScript`) and Hono JSX (the `html` tagged template)

(1) and (2) are React (the Vite admin UI), and (3) is SSR on Cloudflare Workers.
Because of the deliberate design choice not to send the React runtime to visitors, (3) alone uses an entirely
different runtime and a different means of implementation.

Duplicating these three places by hand actually caused two drifts.

- `move to folder…` had not been added to (3) and was missing there
- When `preview-sheet.tsx` was newly implemented, nobody noticed that (3)'s `.pill` lacked
  `white-space: nowrap`, and it was added by hand on the React side only. As a result, when
  `move to folder…` was later added to (3), it wrapped onto two lines there alone

## Decision

Separate "what really should be identical in all three places" from "what legitimately differs by context",
and gather only the former into `shared/` (the existing place that both React and the Worker can import with a
relative path, treated like `shared/theme.ts`).

### What is shared

- The existence, labels, order and display conditions (`hasHistory`) of the items — gathered into
  `siteMenuItems(site, hidden)` in `shared/site-menu.ts`. A caller only passes the keys of the items it wants
  to hide as `hidden: SiteMenuKey[]`
  - `site-card.tsx`: hides `['open', 'copy-url']` (because `.actions` has separate standalone buttons for them)
  - `views/shell.tsx`: hides only `['open']` (meaningless, since that site is already open)
  - `preview-sheet.tsx`: hides nothing and shows every item
- The look of `.pill` itself (including the `.icon`/`.danger` variants) — gathered into `siteMenuPillCss` in
  `shared/site-menu.ts`. It follows exactly the same injection pattern as `themeCss` in `shared/theme.ts`:
  - The SSR side (`views/shell.tsx`) embeds it directly as `<style>${raw(themeCss + siteMenuPillCss + STYLE)}</style>`
  - On the React side, the `injectTheme()` plugin in `app/vite.config.ts` injects it into `index.html` at build
    time, by the same mechanism as `themeCss`

Each rendering function (`renderMenuItem`/`renderMenuPill` in `site-card.tsx`/`preview-sheet.tsx`/`views/shell.tsx`
respectively) has a `switch (item.key)` with a `never` type check in `default` (an exhaustiveness check). When a new
key is added to `SiteMenuKey`, all three places fail to type-check until the corresponding case is written.

### What is not shared

- The visual shell: only `site-card.tsx` has its own `.menu-list`/`.menu-item` panel-style dropdown. This is a
  deliberate difference (the list is dense and a pill stack would look cluttered), not drift, so it is not unified
- What a click actually does: the React side (`site-card.tsx`/`preview-sheet.tsx`) uses callbacks passed through
  props, and the SSR side (`views/shell.tsx`) uses vanilla fetch inside `adminScript` or a link navigation. With
  different runtimes, different means of implementation are only natural
- How `.control-stack`/`.stack-items` opens and closes: SSR always keeps `.stack-items` in the DOM and toggles
  `opacity`/`pointer-events` with a CSS class (`.open`) and `@media (hover: hover)`. React (`preview-sheet.tsx`)
  mounts/unmounts `.stack-items` conditionally on the `menuOpen` state, and does not support hover.
  After investigating, forcing the two into one mechanism would
  - require rebuilding React into an always-mounted, CSS-class-toggling scheme (the preview sheet is mostly an
    iframe, so all the existing close handling, such as outside click / iframe blur / Escape, would have to be
    re-verified)
  - if hover were made the main entry point, add code to keep two parallel "truths" about open/closed in sync
    (the CSS `:hover` state and React's `menuOpen` state), making things more complex instead

  Against that cost, the value gained (removing the duplication of the remaining 15 to 20 or so lines of position
  and animation CSS) was judged not worth it, and it was deliberately left out of what is shared

## Consequences

- To add a new action item (something like a second move to folder), adding one entry to `siteMenuItems()` in
  `shared/site-menu.ts` reflects it in all three places, and forgetting to write the corresponding case in each
  file's `switch` is a type error. So the bug seen here, "one place silently left out", is less likely to recur
- To change the look of `.pill` (color, size, corner radius, hover/active), fixing the single `siteMenuPillCss`
  reflects it in both runtimes
- On the other hand, the rendering code in each of the three places (building the JSX/HTML per item with
  `switch (item.key)` and wiring the click handlers) remains duplicated. This is the flip side of the judgment
  that "the look and the actual behavior legitimately differ by runtime", and is deliberately accepted
- The open/copy url experience differs by place (standalone buttons on the list; inside the menu in the preview
  sheet and the SSR admin bar). This too is a difference in the specification (whether an item is needed depends
  on the context), not drift
- The SSR admin bar's menu also opens on hover, but the preview sheet opens only on click and does not support
  hover. Functionally (opens on click, closes on outside click or Esc) the two match, and this difference is
  deliberately not aligned (see "What is not shared")
