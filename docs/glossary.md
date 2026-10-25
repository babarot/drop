# Glossary

The names of the things in drop. Code (types, variables, tables, API paths, R2 keys), comments, ADRs, commit
messages and conversations with agents all use these terms. In Japanese, technical terms are written as they are in
katakana (the Japanese column), and coined expressions (such as 版) are not used.

To add or change a term, edit this file first, then bring it into the code.

## Current terms

Concepts that exist in the current code. Names in the code, the API and D1 match these terms (for the history, see
"Renaming status" below).

### What is stored

| Term | Japanese | What it refers to | Name in code |
|---|---|---|---|
| Site | サイト | The unit of upload. Published/private, the folder and the URL (`/p/:id`) belong to this unit. Its content is a file tree of Pages and Assets; a Site with a single HTML file is a special case of it (ADR-004) | `sites` table, `SiteRow`, `SiteMeta`, `/api/sites` |
| Version | バージョン | The content of a Site at one point in time. A snapshot of the whole file tree; each replace / restore adds one, and its number increases monotonically within the Site and is never reused. Old versions beyond the limit `MAX_VERSIONS` are pruned on write | `versions` table (metadata), `VersionRow` |
| File | ファイル | One file in a Version. Identified by its Path, it points to its content in R2 by `object_key`. Several Versions and Paths can point to the same content. The type is named `VersionFileRow` to keep it apart from the DOM's `File` | `version_files` table, `versionFiles`, `VersionFileRow` |
| Path | パス | A path relative to the root of the Site. `/`-separated, no leading `/`, NFC-normalized (e.g. `about/index.html`) | `path` |
| Page | ページ | A File that is HTML (`.html` / `.htm`). Served with a CSP sandbox, with the design injected. **Never used to mean "the unit of upload"** (that is a Site) | `isPageType(contentType)` |
| Directory | ディレクトリ | The hierarchy of Paths within a Site. Not the same thing as a Folder | (part of `path`. No type) |
| Entry | エントリ | The Page shown first when `/p/:id` is opened. Each Version has one | `versions.entry_path` (authoritative), `sites.entry_path` (a copy from the current Version), `entryPath` (default `index.html`) |
| Asset | アセット | A File that is not HTML (images, PDFs, CSS and so on). It belongs to a Version, and adding, replacing or deleting one always creates a new Version. A legacy asset points to the same Object from two Paths, its canonical name (ASCII) and its display name (Display name) | Adding and deleting in the admin app is `PATCH /api/sites/:id/tree` (`src/lib/tree-patch.ts`, the files dialog `files…`). The old API and the `site_assets` table were removed in migration 0012 |
| Object | オブジェクト | The content in R2. Keyed by the content hash and shared across Versions and Paths. Pruning deletes only those no File refers to any more | `sites/{siteId}/objects/{sha256}` (`objectKeyOf`). Files can also point to the old keys `versions/` and `assets/` |
| Display name | 表示名 | The original file name (NFC-normalized) of a legacy asset (one added before ADR-004). The second Path that pairs with the canonical name and points to the same Object; it resolves references by a non-ASCII name. The two are treated as a pair only when the canonical name matches the name derived from the display name (the stem reduced to ASCII, plus the first 8 hex digits of the display name's SHA-256) and both point to the same Object. A newly added File has a single Path and no display name | `findAliasPairs`, `aliasDisplayOf`, `canonicalNameOf` (`src/lib/files.ts`) |
| Source name | ソース名 | The name of what was dropped (without extension). Used to match a re-drop and as the download name; it does not change on replace | `sourceName`, `sites.source_name` |
| Title | タイトル | The human-facing label of a Site. Always derived from the `<title>` of the current HTML, falling back to the Source name | `title` |
| Folder | フォルダ | The organizing shelf for Sites, used only in the admin app. A Site belongs to at most one Folder. Never exposed on the public side | `folders` table, `folderId` |

### People and access

| Term | Japanese | What it refers to | Name in code |
|---|---|---|---|
| Admin | 管理者 | The only person who can upload and manage (me). Logs in with Cloudflare Access (AUTH = "access") or comes in with the admin token (AUTH = "token" and drop serve) | `isAdmin`, `isAdminViewer` |
| Admin token | 管理者のトークン | The admin's credential when Access is not used (at least 32 characters). The CLI sends it as a Bearer token; in a browser, entering it at /login turns it into a signed cookie with an expiry | `tokenAuth` (`src/backend/token-auth.ts`), `DROP_ADMIN_TOKEN` |
| Visitor | 訪問者 | Any viewer other than the Admin | (no type) |
| Published / Private | 公開 / 非公開 | The visibility of a Site. A private Site returns the same 404 as a nonexistent Site | `published` |
| View token | ビュートークン | A short-lived HMAC credential that lets someone read a private Site. It has two scopes: view (Preview and Share link; signs `{siteId}.{exp}`) and history (History preview; signs `history:{siteId}.{exp}`). A token of the other scope is invalid (docs/adr/002-view-token.md) | `createViewToken`, `verifyViewToken`, `TokenScope`, `?token=` |
| Preview | プレビュー | The use of a View token issued automatically for the iframe when the admin opens their own private Site. It expires with the admin's Access session | `adminSessionExpiry`, `apiSessionExpiry`, `createViewTokenUntil` |
| History preview | 履歴プレビュー | The use that shows the file tree of a past Version in an iframe, to the admin only. Requires a history-scope View token even for a published Site. It expires with the Access session | `/p/:id/h/:token/:version/*path`, `/api/sites/:id/history-base` |
| Share link | 共有リンク | A URL with a View token, to give to someone else (TTL 10 minutes) | menu key `share-link`, `SHARE_TTL_SECONDS`, UI label `copy share link` |

### Delivery

| Term | Japanese | What it refers to | Name in code |
|---|---|---|---|
| Shell | シェル | The SSR frame that `/p/:id` returns (a thin bar + an iframe). Visitors are never sent React | `renderShell` (`src/views/shell.tsx`) |
| Raw | ロー | The HTML body loaded into the iframe, with a CSP sandbox | `/p/:id/f/<Entry>` (published), `/p/:id/t/:token/<Entry>` (private). The old `/p/:id/raw` redirects |
| Source | ソース | The view that shows the HTML body as `text/plain` (like a Gist's raw) | `/p/:id/source` |

### Operations

| Term | Japanese | What it refers to |
|---|---|---|
| Drop | ドロップ | The user's act of throwing files into the admin app. Used only in UI text, never in type or variable names (it collides with the app's name) |
| Ingest | インジェスト | Turning what was dropped (files, a directory, a zip) into a list of files with Paths on the client (`ingest()`, `IncomingFile`) |
| Upload | アップロード | The sequence that sends only the Objects the server does not have, then Commits the list of Paths to create a Version. It keeps no session state. Creating a new Site and Replace both follow these steps (`sendTree`, `PUT /api/sites/:id/objects/:sha256`, `PUT /api/sites/:id/tree`) |
| Replace | 差し替え | Adding a new Version to an existing Site. Either send the whole tree (`PUT .../tree`) or send only the changes (`PATCH .../tree`) |
| Restore | 復元 | Adding the content of a past Version as a new Version (the past Version is not rewritten) |
| Commit | コミット | After the Objects are placed in R2, settling the Version and the rows of its Files together in one D1 batch (`commitVersion`, `createSite`, `PUT /api/sites/:id/tree`) |

### Sync

The mechanism by which drop's CLI (`cli/`) exchanges Sites between a directory and drop. It works like a git working
tree and its remote: the sync directory on each machine is that machine's working tree, and drop (the remote) is the
shared source of truth.

| Term | Japanese | What it refers to | Name in code |
|---|---|---|---|
| Sync directory | 同期ディレクトリ | The one directory the CLI exchanges with drop. Each folder directly under it is one Site (the folder name is the Source name). Single files directly under it are not synced | `dir` in the config (`~/.config/drop/config.toml`) |
| Push | プッシュ | Uploading the contents of a folder in the sync directory with the Synced version as `base`. If drop has moved ahead, it stops with 409 and overwrites nothing. The resident process (`drop watch`) watches for changes and pushes automatically | `drop push`, `drop watch`, `pushSite` |
| Pull | プル | Writing the contents of a Site on drop into the sync directory. Done explicitly by the user | `drop pull` |
| Synced version | 同期済みのバージョン | The Version the folder last matched on drop. Its number, Entry and file list (a hash per Path) are kept in the CLI's state. Used as the `base` of a push, to decide whether anything changed, and as the starting point of a pull's three-way comparison | `syncedVersion`, `syncedEntry`, `syncedTree` |
| Detached | 外した | A Site taken out of syncing. Deleting its folder detaches it (the Site on drop is not deleted). The next pull does not recreate the folder either | `detached` |

### Runtime

| Term | Japanese | What it refers to | Name in code |
|---|---|---|---|
| Backend | バックエンド | The bundle of parts whose implementation differs per runtime (the DB, where Objects are stored, admin authentication, serving the admin SPA, secrets and settings, scheduling cleanup). The shared code (routes, Commit, delivery) never touches D1 or R2 directly; it goes through the Backend. There is a Workers backend (D1 + R2 + Cloudflare Access) and a Bun backend (SQLite + files) | `Backend` (`src/backend/`), `c.var.backend` |

## Pairs that are easy to confuse

- **Site and Page**: a Site is the unit of upload; a Page is one HTML file within a Site
- **Folder and Directory**: a Folder is the organizing shelf in the admin app; a Directory is the path hierarchy within a Site
- **Backend and Worker**: the Worker is the program itself, running on Cloudflare Workers. The Backend is the bundle of parts handed to the shared code inside it, and the Workers backend is one of them
- **Source name and Source**: the Source name is the name of what was dropped; the Source is the text view of the body
- **Preview and Share link**: both are View tokens. They differ only in use and expiry (a Preview lasts until the Access session ends, a Share link 10 minutes from issue)

## Words not to use

| Don't use | Use instead | Japanese example | Reason |
|---|---|---|---|
| revision / edition (for a Version) | version | 版 → バージョン | Avoid coined expressions |
| draft | private | 下書き → 非公開 | A leftover from the original plan. Visibility has two values, published / private |
| temp link | share link | 共有リンク | One name for one thing |
| artifact | site | — | Easily confused with Claude's Artifacts and CI artifacts |
| page (meaning the unit of upload) | site | ページ → サイト | A Page is one HTML file within a Site |
| drop (as a type or variable name) | site, upload, etc. | — | Collides with the app's name |

## Renaming status

Done (as renames that do not change behavior):

- Types, functions, variables and file names: `PageRow` → `SiteRow`, `PageMeta` → `SiteMeta`, `renderPage` → `renderShell`,
  `shared/page-menu.ts` → `shared/site-menu.ts`, and others
- A Site's `filename` → `sourceName` (the API's matching query is also `?sourceName=`)
- API: `/api/pages` → `/api/sites` (the only client is the admin SPA, deployed at the same time)
- UI label: `copy temp link` → `copy share link`
- In comments and ADRs, ページ (meaning a Site) → サイト, 版 → バージョン
- UI text: aligned to サイト, バージョン, `No sites yet` and so on
- D1 (migration 0008): tables `pages` → `sites`, `page_assets` → `site_assets`,
  columns `page_id` → `site_id`, `pages.filename` → `sites.source_name`, and the index names followed.
  `site_assets` and `sites.object_key` / `versions.object_key` were removed in migration 0012 as part of the
  ADR-004 cleanup
- Admin app paths: `/pages` → `/sites`. The old paths redirect to `/sites`, keeping the path and query
- The old-format R2 key `pages/{id}.html`: production had 0 matching rows, so the code and tests handling it were removed

Not changed:

- The public URL `/p/:id` (so as not to break links already handed out)
- Existing R2 keys (`versions/`, `assets/`). Only newly written ones use the ADR-004 key (`sites/{siteId}/objects/{sha256}`)
