# ADR-002: Short-lived view tokens (unifying previews and share links)

## Status

Accepted

## Context

The only way to show a private site to someone else was to publish it, so even when we only wanted to show it
for a while, it became permanently public (and stayed public if we forgot to switch it back).

At the same time, a mechanism to authorize private sites already existed. `/p/:id/raw` is read from a sandboxed
iframe (an opaque origin), so cookies are not guaranteed to be sent, and it accepted a short-lived HMAC token
signing the site ID and an expiry via `?preview=`. `/p/:id/source` and asset delivery accepted the same token.

In other words, a "credential that can read for a short time" was already running in production. What was
missing were three things: the shell `/p/:id` did not accept it, the TTL was fixed, and there was no way to issue
and copy one.

## Decision

### One mechanism; only the TTL differs

No token kind dedicated to share links is created. What is signed stays `pageId.exp`, as before, with no
distinction by use. The only difference is the TTL at issue (preview 300 seconds / share 600 seconds).

Mixing a use scope into the signature (so that a share token cannot open `/source`, for example) was considered but
not adopted. What `/source` returns is the same bytes as the site the recipient can already see rendered, so it is
not an escalation of privilege.

The file was renamed from `src/lib/preview.ts` to `src/lib/view-token.ts`. Once there were two uses, the name
"for previews" no longer matched what it was. The query parameter was also renamed in one go from `?preview=` to
`?token=`. To the recipient of a share, this value is not a "preview" but a credential they bring along, and we
judged that the name should point to what it is, not to its use. Tokens are issued per request with a short TTL,
so no old persisted URLs exist, and the switch could be made without leaving an alias.

### Expired is 410, but it can only be returned after the signature is verified

If an expired link sank into a 404, the person it was given to would only see "does not exist". So we decided to
return 410 Gone, but this comes with an ordering constraint.

Before the rename, `verifyPreviewToken` looked at `exp` and returned false before verifying the signature. With
that order, "410 if expired" becomes an existence oracle. For `GET /p/{guessed ID}?token=1.xxxx`, it would return
410 if the site exists and 404 if not, so a forged token that needs no signature could tell whether an ID hits.
The design "a private site and a nonexistent site return the same 404" would collapse.

Therefore `verifyViewToken` always verifies the signature first and returns one of three values: `valid` /
`expired` / `invalid`. Only someone who has once received a correct signature for that site (= the person the admin
gave the link to) can draw a 410.

This constraint cannot be reconstructed just by reading the code. Reordering the checks as "cheap checks first"
silently revives the oracle. The regression test is "answers 404 (not 410) for a forged token" in
`test/app.test.ts`.

### The same authorization order on all four surfaces

The four surfaces `/p/:id` (the shell), `/p/:id/raw`, `/p/:id/source` and `/p/:id/:filename` use the same order
(`authorize` in `src/routes/view.ts`).

1. If there is no row, 404
2. If `published`, serve
3. Verify `token`: if `valid`, serve / if `expired`, 410 / if `invalid`, go on
4. If the admin cookie passes verification, serve (except `/raw`)
5. Otherwise, 404

Expired takes precedence over the admin cookie. Answering the state of the credential carried in the URL is more
consistent, and with `ENVIRONMENT=development`, `isAdminViewer` always returns true, so checking admin first would
mean never hitting a 410 locally.

The `isAdmin` decision (whether to show the admin bar) is kept independent of this. The token only acts on the
authorization gate and plays no part in which chrome is shown.

### The shell passes the token it received to the iframe as is

If the shell issued a fresh token, anyone holding the link could extend the expiry indefinitely just by reloading.
When `access === 'token'`, the received value is put verbatim into `/p/:id/raw?token=...`. Only when the admin opens
it with the cookie (no token in the URL) is one issued on the spot, as before.

### Revocation is by expiry only

There is no way to invalidate an issued link individually. Keeping a jti in D1 for a 10-minute window was judged
out of proportion. In an emergency, it can be stopped by deleting the site (the row lookup runs first, so it
becomes a 404 immediately) or by replacing it (the token stays valid, but the new body is what gets served). If
individual revocation is ever truly needed, mixing `updatedAt` into what is signed (so that a replace revokes all
links) is the smallest form that does not add to D1.

### The choice of how to share is shown differently on each surface

The item is defined once in `shared/site-menu.ts` (`share-link`, label `copy share link`, private sites only), and
only its presentation differs per surface.

- List card: `copy url` becomes a split button with a chevron; the main button's label is `copy`, and the dropdown
  lists `copy url` and `copy share link`
- preview-sheet / the admin bar on `/p/:id`: one item, `copy share link`, is added to the menu

The split button was not extended to every surface because the card is the only place it fits. On the card,
`copy url` is a standalone button in `.actions`, but on the other two surfaces it is already an item inside the
menu, and splitting it would make a menu within a menu.

The same choice thus exists in two forms, but the contract that `siteMenuItems` returns a flat array is unchanged.
How to group them is each surface's presentation decision, which falls in the area ADR-001 left to the callers.
The card's split button also draws its content (the label, and the decision not to show the chevron for a published
site) from `siteMenuItems`, without copying the label into the card.

On the card side there are now two popovers, so `menuOpen` was replaced with a single state,
`openMenu: 'main' | 'copy' | null`, to make them mutually exclusive.

### The copy is reserved directly under the click

A short-lived link is issued by the server, so the value is only available after an `await`, but
`navigator.clipboard.writeText` requires transient activation, and an intervening `await` causes `NotAllowedError`
in Safari and others. A workaround for the same constraint already exists in `handlePublishCopy` in
`app/src/App.tsx` (it runs the copy synchronously first and then publishes). The existing flows that copied a
locally built value could all write synchronously, so they never hit this problem.

The fix is to pass a Promise to a `ClipboardItem` directly under the click, reserving the write before the value
arrives (`copyWhenReady` in `app/src/lib/clipboard.ts`). The link to the user's action is not broken, so
`copy share link` becomes "issue and copy right away" in one click. It is the means Safari officially provides, and
Chrome / Firefox accept it as specified.

When the reservation does not work (no `ClipboardItem`, it does not accept a Promise, or the window lost focus while
waiting), we only report that it failed and ask the user to press again. We also wrote a flow that held on to the
issued link and waited for a second click, but removed it. The user's effort is one click either way (only where
they press differs), and pressing again issues a new link, so the full 10 minutes are available. The held link has
already lost the time since the first click. About 30 lines and one piece of state bought nothing.

This is an admin app behind Access with effectively one user, so short code takes priority over a wide defense
against unknown browsers.

The SSR bar (`adminScript` in `src/views/shell.tsx`) does not use React, so the same steps are written in plain JS.
Only the explanation of the mechanism can be shared; the code is separate.

## Consequences

- `copy url` on a private site still returns "the URL for yourself" (it is a 404 for the recipient). We also wrote a
  message telling someone who pressed it intending to share, but removed it. The split button shows the ways to
  share at the moment of copying, so the job of teaching is already done
- The 10 minutes start at the time of issue. The window includes copying, pasting and the recipient opening it. If
  it expires while viewing, reloading the iframe and lazily loaded assets get 410
- Sharing a link assumes that link-unfurling bots fetch it at least once within the 10 minutes
- With `[observability] head_sampling_rate = 1`, URLs with tokens remain in Workers Logs
- `PREVIEW_SECRET` keeps only its old name (it signs both previews and shares). Rotating it revokes every token at
  once

## History

- 2026-10-19: Changed the expiry of the admin's preview from a fixed 300 seconds to "the expiry of the admin's Access
  session (the `exp` of the CF_Authorization JWT)". 300 seconds assumed a single-HTML Site that finishes loading
  right after opening; with multi-Page Sites (ADR-004), the token is verified on every navigation inside the iframe,
  so after 5 minutes browsing one's own Site stopped with 410. The intended behavior is "you can view as the admin
  while your Access session is valid", and the token is only a workaround that fills the gap of cookies not reaching
  the sandboxed iframe. In exchange, the time something can be seen if the URL leaks grows to the length of the
  session (it is not put in the referrer, and the URL appears only inside the iframe, so this was accepted). Share
  links stay fixed at 600 seconds from issue. In both cases the expiry is set at issue and does not extend with use
- 2026-10-19: Gave tokens two scopes for the history preview (the implementation of ADR-004). The existing uses (the
  admin's preview and share links) are the view scope, and what is signed stays `{siteId}.{exp}`. The file tree of a
  past version, `/p/:id/h/:token/:version/*`, is the history scope, and what is signed is `history:{siteId}.{exp}`.
  This keeps someone who received a share link from following past versions (content removed by a replace); each
  token is invalid (404) on the other's routes. A Site's id is a UUID, so the two strings never overlap. History
  tokens are issued only by the admin API, and they expire with the Access session, like the admin's preview. The
  version is not signed; the token works for every version of the Site
