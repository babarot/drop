# ADR-008: A Backend boundary with Workers and Bun implementations

## Status

Accepted

## Context

drop ran only on Cloudflare Workers: the routes called D1, R2 and Access directly. We want it to run
without Cloudflare too (`drop serve`), so that it can be used fully locally and is easy to try as an
open-source project, while the remote instance keeps running on Workers.

One way is to bring workerd itself to the local machine. Another is to give the shared code a
boundary and implement it per runtime.

## Decision

### The shared code goes through a Backend

The routes, Commit and delivery read a `Backend` from the Hono context (`c.var.backend`) and never
touch `c.env` directly. A Backend bundles the parts that differ per runtime (`src/backend/types.ts`):
the database, where Objects are stored, admin authentication, serving the admin SPA, the preview
secret, and scheduling cleanup after the response.

- The Workers backend (`src/backend/workers.ts`) is built per request from `env`: D1, R2, Access or
  drop's own token, `ASSETS`, `waitUntil`.
- The Bun backend (`src/backend/bun.ts`) is built once at startup: `bun:sqlite`, a folder on disk,
  and the same `migrations/*.sql`.

The boundary sits above SQL. Both sides are SQLite, so the Drizzle queries are shared as they are,
including the trick in `commitVersion` that turns a stale `base` into a NOT NULL violation. The only
database operation in the boundary is `atomic` (D1's `batch`, or a transaction on Bun that rolls back
and throws the same error).

### Bun, not workerd

The local side uses Bun. Its distribution does not carry workerd, and the CLI, the resident process
and the local server are one program, built into one binary. Bun has `HTMLRewriter` (built on the
same lol-html as Cloudflare) and SQLite built in.

### The same tests on both

The boundary and the Bun backend were built together, and the server tests (`test/*.test.ts`) run on both
(`pnpm test` runs the Workers project, then `pnpm test:bun`). On Bun, `cloudflare:test` is replaced by
`test/bun/cloudflare-test.ts`, which offers `SELF.fetch` and the parts of D1 and R2 the tests touch
directly, on top of the Bun backend.

## Consequences

- The tests that check the invariants in CLAUDE.md (CSP sandbox, same 404, View token order, CSRF
  header) passing on both is the evidence that both backends keep them.
- A boundary drawn while only one implementation existed would have taken the shape of D1 (relying
  on `batch` for rollbacks, for example). Building both at once kept it honest, at the cost of doing
  the Bun backend before it was needed.
- Small differences are allowed where tests cannot see them: the Bun backend's ETag is derived from
  size and time, and its conditional get only looks at If-None-Match.
- A new Cloudflare dependency in shared code now needs a Backend member and a Bun implementation.
