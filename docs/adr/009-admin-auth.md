# ADR-009: Swappable admin authentication (Access or drop's own token)

## Status

Accepted

## Context

The admin was decided by Cloudflare Access. That is heavy for anyone else running drop, and
`drop serve` runs where Access does not exist. A local server also invites a shortcut: treat every
request from 127.0.0.1 as the admin.

That shortcut breaks a security boundary. Uploaded HTML runs in a sandboxed iframe but still sends
requests from 127.0.0.1. Delivery returns non-HTML files of private Sites to the admin and adds
`Access-Control-Allow-Origin: *`, so uploaded HTML treated as the admin could read another private
Site's files.

## Decision

### The instance says which authentication it uses

Admin authentication is an `AuthProvider` in the Backend (ADR-008). On Workers it is chosen by the
`AUTH` variable (`authFor` in `src/backend/workers.ts`):

- `AUTH = "access"`: Cloudflare Access, as before
- `AUTH = "token"`: drop's own admin token (`src/backend/token-auth.ts`)
- anything else, or unset: nobody is the admin (`/api/*` returns 503). A configuration mistake fails
  closed.

`drop serve` always uses the token authentication, with its secrets in its data directory.

### The admin is decided by credentials, never by where a request comes from

- The CLI sends the admin token as `Authorization: Bearer`.
- A browser enters the token at `/login` (or, with `drop serve`, opens a one-time URL it prints) and
  gets an HttpOnly, `SameSite=Strict` cookie whose value is an expiry and its HMAC. The sandboxed
  iframe has an opaque origin, so the cookie is attached neither to its requests nor to top-level
  navigations of popups that escaped it. `Lax` would not do.
- An admin token shorter than 32 characters is a configuration error and nobody gets in.
- There is no Access session to follow, so the admin's View tokens get a fixed 12-hour expiry. The
  ADR-002 order (signature before expiry) stays.

`drop serve` also binds only to 127.0.0.1 and rejects a Host header that is not local, against DNS
rebinding. That narrows who can reach it; it does not make anyone the admin.

## Consequences

- drop can run on Workers without Access, and the maintainer's instance keeps Access.
- Workers and `drop serve` share one token implementation, so the boundary is reasoned about once.
- `drop login` tells which credential a remote needs from its answer to a request without one: a
  redirect to the Access login means a service token, 401 means the admin token.
- Options not taken: trusting the loopback address (breaks the sandbox boundary above), and a login
  where the CLI prints a one-time URL for remote instances too (needs a table of used codes on
  Workers; pasting the token is common and works with password managers).
