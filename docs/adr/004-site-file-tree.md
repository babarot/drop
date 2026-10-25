# ADR-004: Holding a Site as a file tree (multiple HTML files)

## Status

Accepted

## Context

A drop Site was "one HTML file + assets alongside it", and that was the only shape that could be dropped. We want to
be able to drop a whole archived web page or site (a set of files including several HTML files and subdirectories)
as files, a directory or a zip.

The current design has several premises that get in the way.

- `sites.object_key` points to one HTML file, and `/p/:id/raw` serves only that
- Asset names are ASCII only, without `/` (`shared/assets.ts`). The delivery route is also the single level
  `/p/:id/:filename`
- Assets do not allow `text/html`. The CSP for asset delivery is a `sandbox` that does not allow scripts, so just
  adding HTML there would not work
- HTML is versioned, but assets are not. For a site, "the set of all files" should be one version
- A private Site's token is propagated by rewriting the HTML on delivery to add `?token=` to relative references. It
  is not added to CSS `url()`, URLs built by JS, or links between HTML files, so a private site almost certainly
  breaks

## Decision

### A Site is a file tree; a Version is a snapshot of the tree

A Site holds a mapping from Path to File (a file tree), and a Version points to the whole tree at that point. A Site
with a single HTML file is handled by the same model as "a one-file tree", with no special case.

- Assets are included in versions too. Any operation that adds, deletes or replaces even one file creates a new
  Version (the current "assets are outside versions" ends)
- The Page shown first is the Entry, and each Site has an `entry_path`. It is chosen as: `index.html` (directly under
  the root) > the one HTML file, if there is exactly one > chosen by the user
- In D1, `version_files(site_id, version, path, object_key, content_type, size, sha256)` is authoritative. `versions`
  keeps the version metadata (title, total size, creation time)
- The server decides the Content-Type from the Path's extension. What the client declares is not trusted (the same
  policy as for current assets)

### R2 is content-addressed per Site

Newly written objects use the key `sites/{siteId}/objects/{sha256}`.

- The same content gets the same key, so nothing is duplicated across versions. A re-upload that fixed only one file
  sends and writes only that file
- The Site is the namespace, and there is no deduplication across Sites, so that deletion is complete with "delete the
  prefix"
- The Path is not part of the key. Only D1 holds the mapping between Paths and versions
- Existing objects (`versions/{id}/…`, `assets/{id}/…`) are not moved. `version_files.object_key` keeps pointing at
  them. Keys are opaque pointers, so moving them can be done separately with a script when it becomes necessary

### Upload is "place the objects, then settle the list"

Dropped files, directories and zips are turned into a sequence of `{path, file}` on the **client** (Ingest). Zips
are also extracted in the browser, so that the Workers request body and memory limits do not bound the size of an
archive.

The rest of the flow is common regardless of the input's shape.

1. The client computes each file's SHA-256 and sends only those the server does not have
2. The server verifies the hash of the received body and writes it to the content-addressed key
3. The client sends the list of Paths, hashes and sizes, and the Version is settled in one D1 batch (Commit)

Because it is content-addressed, there is no staging area and no upload session state. Objects that are never
committed become orphans that no Version refers to, and are subject to cleanup. The server also normalizes and
validates Paths (rejecting `..`, a leading `/`, `\`, control characters and so on).

### Delivery routes, with the token in the path

The file tree is served under a dedicated prefix below `/p/:id`.

- Published: `/p/:id/f/*path`
- Private: `/p/:id/t/:token/*path`

**The token goes in the path, not the query.** Relative URL resolution carries the token along naturally, so CSS
`url()`, URLs built by JS and links between HTML files all work without rewriting the HTML. The token's format,
signature and verification order (signature verified first, expired is 410) stay as in ADR-002; only where it is
passed changes. The form of the share link itself (`/p/:id?token=`) does not change.

Putting the file tree under a dedicated prefix also structurally removes collisions with reserved names such as
`raw` / `source`. The old routes (`/p/:id/raw`, `/p/:id/:filename`) remain as redirects to the new routes.

### Security headers are decided in one place from the Content-Type

Many HTML files are served from the same origin, so a single place that forgets a header breaks the boundary. The
decisions currently split among `/raw`, `/source` and asset delivery are gathered into one function.

- HTML (`.html` / `.htm`): `RAW_SANDBOX_CSP` from `shared/security.ts` (scripts allowed, no `allow-same-origin`),
  and the design injection on delivery (`applyDropDefaults`)
- PDF: the existing exception with no CSP (not to be extended to other types without adding an ADR)
- Everything else: `sandbox`. Extensions not on the allow list are returned as `application/octet-stream` +
  `Content-Disposition: attachment`

### Separate origins (a subdomain per Site) are not adopted

Assigning a subdomain to each Site would make it a truly separate origin, and root-relative references
(`/css/a.css`) and JS that needs `allow-same-origin` would work. But it needs wildcard DNS and certificates, separating
Access and cookies, and the cost of another domain. The first version uses paths, and this will be reconsidered when
root-relative references become a practical problem.

## Consequences

- An archived site can be dropped as files, a directory or a zip. A single-HTML Site works as before
- Every kind of relative reference in a private Site works without rewriting. The current known limitation "CSS
  `url()` can be 404 in a private preview" is resolved as well
- Adding and deleting assets also appear in the version history. The retention limit (`MAX_VERSIONS`) is reached
  sooner, but content addressing avoids duplicates, so the cost per version is small
- Pruning versions and deleting objects no longer map one to one. One object is pointed to by several versions, so
  only "what no remaining version refers to" may be deleted
- Known limitation: root-relative references point to drop's own root and break (#1). Because of the sandbox, JS that
  uses localStorage / cookies does not work
- Known limitation: the character encoding is assumed to be UTF-8. A Page is decoded as UTF-8 and returned with
  `charset=utf-8`, so pages in Shift_JIS and the like are garbled. Zip file names follow the UTF-8 flag, so a
  Shift_JIS zip without the flag has garbled names (#5)
- Moving to another Page inside the iframe leaves the shell's title and URL at the Entry (#2). `?theme=` is a query,
  so it is not carried across Pages (#3). The Source view is the Entry only (#4)
- Migration: existing Sites are backfilled into `version_files` as one-file trees with `entry_path = index.html`. R2
  is not touched. The old routes stay compatible through redirects

## History

- 2026-10-19: Finished the implementation (phases 1 to 5). Decisions made during the implementation that are worth
  reading later:
  - Legacy assets were backfilled into `version_files` as rows pointing to the same Object from two Paths, the
    canonical name (ASCII) and the display name. The two rows are treated as a pair only when the canonical name
    matches the name derived from the display name (the first 40 characters of the stem reduced to ASCII, the first 8
    hex digits of the SHA-256 of the NFC display name, and the lowercased extension) and both point to the same
    Object. Pairing just because they point to the same Object would confuse separate files with identical content.
    All pairs in production (1 Site, 132 rows) matched this derivation
  - Adding and deleting files in the admin app creates a new Version as a diff against the tree
    (`PATCH /api/sites/:id/tree`). The diff carries the number of the Version it was based on (`base`), and returns
    409 if another Version was committed in between. Inside the D1 batch too, the value inserted into versions is
    "the next number only when the latest is `base`, NULL otherwise", so a NOT NULL violation cancels it
  - Downloading a multi-file Site builds a zip in the browser (with the tree under `{Source name}/`). For legacy asset
    pairs, both names are included. The HTML refers to the canonical name, and keeping only the display name would
    break the references. A single-HTML Site downloads that HTML as before
  - The tree of a past Version is shown only to the admin at `/p/:id/h/:token/:version/*path`. The token has a
    separate scope from share links (History in ADR-002)
  - The old table `site_assets` and the old columns `sites.object_key` / `versions.object_key` were removed in two
    steps. 0011 dropped NOT NULL and was deployed with code that no longer touched them, and 0012 removed them.
    Drizzle's `select()` lists every column by name, so removing them in one step would make the old Worker still
    running between applying and deploying fail on reads
