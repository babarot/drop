# drop

A local-first home for HTML pages: each folder in a sync directory is a site, served by `drop serve` on the machine
or by the same app deployed to Cloudflare, which also syncs machines and serves sites on the web.
Hono / React SPA (`app/`) / Cloudflare Workers + R2 + D1 with Drizzle, or Bun with SQLite and a folder (`drop serve`).

## Terminology

**Use the names in `docs/glossary.md`.** Use the same terms everywhere: code, comments, ADRs, commit messages
and conversation. In particular:

- The unit of upload is a **Site**. A **Page** is "one HTML file within a Site"
- The organizing shelf in the admin app is a **Folder**; the path hierarchy within a Site is a **Directory**
- Write "version", not "revision" or "edition"; write "share link", not "temp link"

When talking in Japanese, use the words in the glossary's Japanese column (for example バージョン, not 版).

When adding a new concept, update the glossary before the code.

## Layout

- `src/` — the Worker (Hono). `routes/api.ts` is the admin API, `routes/view.ts` is public delivery. `app.ts` holds
  all the routes, and the entry point (`index.ts` for Workers) sets up the Backend from `backend/` (the swappable
  parts: D1, R2, Access and so on) and hands it over
- `cli/` — the sync CLI (Bun. `pnpm cli push` / `pull` / `watch` / `serve`). `serve` runs drop without Cloudflare
  (127.0.0.1 only. Authentication is `src/backend/token-auth.ts`). `pnpm build:cli` builds a single binary (`dist/drop`)
- `app/src/` — the admin SPA (React, under `/sites/`. Protected by Cloudflare Access)
- `shared/` — definitions imported by both the Worker and the SPA (security settings, menus, theme and so on)
- `migrations/` — D1 migrations
- `docs/adr/` — records of design decisions. How to write them: `.claude/rules/adr.md`

## Commands

- `pnpm typecheck` / `pnpm lint` / `pnpm test` (test builds first, runs vitest on the Workers backend, and then
  runs the same tests on the Bun backend with `pnpm test:bun`. Requires Bun)
- `pnpm dev` starts it locally (port 8788)

## Invariants

Breaking these breaks a security boundary. Read the relevant comments and ADRs before changing them.

- Uploaded HTML is always served with a CSP sandbox, and never with `allow-same-origin`
  (`shared/security.ts` is the single definition)
- A private Site and a nonexistent Site return the same 404
- A View token's signature is verified before its expiry is checked (the reverse order creates an existence
  oracle. ADR-002)
- `/api/*` requires the `X-Drop-Request: 1` header (CSRF defense, `src/middleware/csrf.ts`)
