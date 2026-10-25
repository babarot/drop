# ADR-003: Reading private sites with the gh token

## Status

Deprecated

This was implemented and shipped to production, then removed. The reasons are in History at the end.

## Context

Private sites could be read only by a browser logged in to Access (the `CF_Authorization` cookie) and by someone
holding a URL with a short-lived token. When we wanted an agent such as Claude Code, running on the local PC, to read
a private site, neither was convenient. The cookie lives inside the browser, and a short-lived token has to be issued
in the admin app and pasted every time.

On the other hand, `gh auth login` is already done on that PC, and `gh auth token` gives our own GitHub token at any
time. If the agent brings it along, it can read as "me" with no extra setup.

The Access-side options (a Service Token, `cloudflared access curl`) were also considered. But both work only on
paths Access protects. `/p/*` is kept outside Access so that published sites can be viewed without logging in (the
two namespaces in the README's "Design principles"), and the edge does not inject a JWT. To let a private site be read
in its `/p/:id` form, the Worker has to verify the credential itself.

## Decision

### Add the gh token as a way to be admin

`isAdminViewer` (`src/middleware/access.ts`) accepts `Authorization: Bearer <token>`. It calls GitHub's `GET /user`
with the token and treats the caller as the admin if the returned `id` matches `GITHUB_ADMIN_ID`. Without the header,
it looks at the `CF_Authorization` cookie as before.

The order from ADR-002 (published → the token in the URL → admin) does not change. What "admin" means just becomes two
things, "the Access cookie" and "the gh token"; neither `authorize` nor the four-surface structure is touched. `/raw`
still does not look at admin. It is enough for the agent to read the body with `/source` and the assets with
`/:id/:filename`.

```bash
curl -H "Authorization: Bearer $(gh auth token)" https://drop.example.dev/p/<id>/source
```

Claude Code's WebFetch cannot add headers, so it reads with curl in Bash.

### Match by the numeric id, not the login

A GitHub login can be changed, and a released name can be taken by someone else. The `id` does not change.
`GET /user` succeeds even with a token that has no scopes, so gh's default token is enough.

### Cache only successes, for a few minutes

To avoid calling `GET /user` on every request, it is remembered for 5 minutes in an in-isolate Map keyed by the
token's SHA-256. The plaintext token is not kept.

Failures are not cached. Only our own token is remembered, so the Map does not grow. Hammering it with forged tokens
increases the queries to GitHub, but that is no different from hammering any other endpoint.

For those 5 minutes, it keeps passing even if the token is revoked on the GitHub side.

### Not extended to `/api/*`

Access stops `/api/*` at the edge, so requests are rejected before they reach the Worker. Allowing writes with the gh
token would need an Access bypass, breaking the premise that the protection boundary is cut by path. What we want now
is only to read, so it stays on `/p/*`.

## Consequences

- The gh token is a strong token with repo permissions and more, and it gets sent to our own Worker. The Worker does
  not store it and keeps only the hash in memory
- Even in the `[observability]` invocation logs, the value of the Authorization header is `REDACTED` and does not
  remain in the logs
- If the GitHub token leaks, drop's private sites can be read too. Revoking the token on the GitHub side stops it
  within at most 5 minutes
- Admin detection depends on the availability of the GitHub API. While GitHub is down, the gh token cannot read (the
  cookie side is unaffected)
- Opening `/p/:id` with the token also renders the admin bar. Harmless for reading with curl, and there is no reason
  to have a separate check just to decide what to show

## History

It was removed because what it hands over is out of proportion to what it protects.

- `gh auth token` is a token for gh's own use and has at least `repo`, `read:org` and `gist`. All drop wants to know
  is "who", yet the full GitHub authority was sent to the Worker every time. If the Worker were compromised, what we
  would lose is not drop but the entire GitHub account
- `GET /user` tells who the owner is, but not whether the token was issued for drop (its audience). It had become a
  token passthrough, reusing a credential meant for GitHub to authenticate to another service
- It would teach the agent a procedure of "attach a strong token to a header and send it", leaving room for prompt
  injection to send it to another host

`gh auth token` cannot hold a weaker token alongside for the same account, so there is no way to narrow the
permissions within gh either.

As an alternative, we are considering a drop-only GitHub App with no permissions, obtaining an 8-hour user access
token with ghtkn. The Worker would confirm "is this a token of this App" with
`POST /applications/{client_id}/token` before matching the id, guaranteeing both the audience and the identity.
Whether to adopt it is undecided; if adopted, it will be written in a new ADR.
