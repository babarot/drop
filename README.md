# drop

A local-first home for the HTML pages you and your AI tools make. Each folder in
a sync directory (`~/drop`) is a site: write files into it, and drop keeps
versions of it and shows it in your browser, sandboxed, with history and diffs.
No account to create, and no API for your AI tools to learn: they just write
files.

Deploy the same app to Cloudflare, and your sites sync across your machines and
can be opened, published or shared on the web.

- On your machine, `drop serve` runs drop with SQLite and a folder for files.
  No account is needed.
- On Cloudflare, Workers, D1 and R2 run the same code. `drop push`, `drop pull`
  and `drop watch` keep each machine's sync directory and the hosted drop in
  step, and the admin app also takes files dropped into the browser.

Sites are private until you publish them.

## Quick start

```sh
drop serve &                                   # prints a one-time login URL for the admin app
mkdir -p ~/drop/my-page && echo '<h1>hello</h1>' > ~/drop/my-page/index.html
drop watch                                     # pushes ~/drop/my-page and every later change
```

Open the printed URL to log in and see the site. Without a config file, the CLI
syncs `~/drop` with the `drop serve` on this machine and uses its token, so
there is nothing to set up. Tell your AI tools to write pages into
`~/drop/<name>/`.

## Syncing machines through Cloudflare

Once drop runs on Cloudflare (see "Running your own instance on Cloudflare"),
point each machine at it:

```sh
mkdir -p ~/.config/drop
printf 'remote = "https://drop.example.dev"\n' > ~/.config/drop/config.toml
drop login        # the instance's admin token, or a Cloudflare Access service token
mkdir -p ~/drop/my-page && echo '<h1>hello</h1>' > ~/drop/my-page/index.html
drop push
```

On a second machine, use the same `config.toml`, run `drop login`, and
`drop pull` to bring the existing sites down.

A hosted instance authenticates the admin either with Cloudflare Access or with
drop's own admin token, chosen when it is deployed (`DROP_AUTH`, see "Running
your own instance on Cloudflare"). `drop login` detects which one the instance
uses. With the admin token, the CLI sends it and the browser logs in at
`/login`.

With Cloudflare Access, the CLI needs an Access service token: create one in Zero Trust, then add a policy with the
action "Service Auth" that includes the token, and assign that policy to the
drop application. A policy that is not assigned to the application has no
effect.

## Running your own instance on Cloudflare

`wrangler.toml` in the repository is neutral: it has no domain and a placeholder
D1 id, and it is what local development and the tests use. A deployment builds
its own config, `wrangler.deploy.json`, from variables (`scripts/deploy-config.ts`,
ADR-005), and the GitHub Actions workflow does that for you.

1. Fork the repository.
2. Create the database and the bucket:

   ```sh
   npx wrangler d1 create drop-db     # note the database id
   npx wrangler r2 bucket create drop-files
   ```

3. Choose how the admin signs in.
   - Admin token (no Cloudflare Access needed): set two Worker secrets, each at
     least 32 random characters.

     ```sh
     npx wrangler secret put DROP_ADMIN_TOKEN
     npx wrangler secret put DROP_SESSION_SECRET
     ```

   - Cloudflare Access: create an Access application for your domain that
     protects `/sites` and `/api`, and note its team domain and audience (AUD).
   - Either way, set the secret that signs view tokens:
     `npx wrangler secret put PREVIEW_SECRET`.
4. In the fork's settings, add the repository variables and secrets:

   | Variable | Value |
   |---|---|
   | `DROP_DOMAIN` | the host name to serve on (a custom domain on Cloudflare) |
   | `D1_DATABASE_ID` | the id from `wrangler d1 create` |
   | `DROP_AUTH` | `token` or `access` |
   | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | only with `DROP_AUTH=access` |
   | `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET` | optional, if you chose other names |

   Secrets: `CLOUDFLARE_API_TOKEN` (with permission to edit Workers, D1 and R2)
   and `CLOUDFLARE_ACCOUNT_ID`.
5. Push to `main`. The workflow runs the tests, applies the D1 migrations and
   deploys. Without `D1_DATABASE_ID` it only runs the tests.

To deploy from your machine instead, export the same variables and run
`pnpm deploy:worker` (apply new migrations first with
`npx wrangler d1 migrations apply DB --remote --config wrangler.deploy.json`
after `pnpm deploy:config`).

## The CLI

Run it from the repository with `pnpm cli <command>`, or build a single
binary with `pnpm build:cli` (written to `dist/drop`) and put it on your
`PATH`.

| Command | What it does |
|---|---|
| `drop push [<folder>...]` | Push folders of the sync directory (all of them when omitted). A push never overwrites newer remote content: if the remote moved on, it stops and asks you to pull. |
| `drop push --force <folder>` | On a conflict, keep the local tree. The remote content stays in the site's history as the previous version. |
| `drop watch` | Watch the sync directory and push a folder once its files have been quiet for a few seconds. |
| `drop pull [<name>...]` | Bring remote sites into the sync directory. Changes on both sides are merged file by file; a file changed on both sides stops that site. |
| `drop pull --theirs` | On a conflict, take the remote. The local files are copied to a backup first. |
| `drop pull --include <name>` | Bring back a site you detached by deleting its folder. |
| `drop status` | Show each synced site, its synced version and any warnings. |
| `drop login` | Store the credentials for a hosted instance. |
| `drop serve [--port N]` | Run drop locally on `127.0.0.1` (default port 8789). |

Each folder directly under the sync directory is one site, named after the
folder. Files directly under the sync directory are not synced. Deleting a
folder detaches the site; it never deletes the site on the remote. Publishing
and deleting sites happen only in the admin app.

### Ignored files

Files that are not tracked yet are skipped when they match `.git/`,
`node_modules/`, `.env*`, `*~`, `.*.swp`, `*.tmp`, or a pattern in a
`.dropignore` file inside the site folder (gitignore-like globs; a trailing `/`
matches directories, a pattern containing `/` is anchored to the site root).
Ignore rules never remove files that are already tracked. Symlinks are never
followed.

## Where things live

Locations follow the XDG base directories. Each can be moved with an
environment variable.

| What | Location | Override |
|---|---|---|
| Config (`remote`, `dir`). No secrets, so it is safe to share through dotfiles. | `$XDG_CONFIG_HOME/drop/config.toml` (`~/.config/drop/config.toml`) | `DROP_CONFIG_DIR` |
| Credentials for a hosted instance | macOS: the login keychain (service `drop-cli`). Elsewhere: `$XDG_DATA_HOME/drop/credentials.json`, mode 0600 | `DROP_ACCESS_CLIENT_ID` and `DROP_ACCESS_CLIENT_SECRET` take precedence |
| Sync state: the synced version of each site, and backups made by `pull --theirs`. Specific to each machine; do not share it. | `$XDG_STATE_HOME/drop/` (`~/.local/state/drop/`) | `DROP_STATE_DIR` |
| `drop serve` data: the SQLite database, stored files, and the server's secrets (including the CLI token) | `$XDG_DATA_HOME/drop/` (`~/.local/share/drop/`) | `DROP_DATA_DIR` |
| Sync directory | `~/drop`, or `dir` in `config.toml` | `dir` |

Keep the sync directory outside iCloud Drive, Dropbox and similar folders;
their own syncing conflicts with drop's.

## Design principles

- Two namespaces. URLs are split into a public namespace and a protected one.
  `/p/:id` (and `/llms.txt`) is public: anyone who knows the URL can open a
  published site, and a private site answers the same 404 as a missing one
  unless the request carries a valid view token.
  `/sites` (the admin app) and `/api/*` belong to the admin. Cloudflare Access
  protects by path prefix, so the namespace split is the protection split: a
  site lives at `/p/:id`, not under `/sites`, so that it is not caught by the
  admin app's protection. The Worker itself also verifies the admin on
  `/api/*` (the Access JWT, as defense in depth behind the edge, or the admin
  token).
- A visitor's world is flat. To a visitor, `/p/:id` is a self-contained page
  with no parent and no siblings: the public side shows no link to the list, no
  navigation to other sites, nothing that hints at a collection (such as "1 of
  n"), and no folders. Sharing a site by its UUID URL relies on sites being
  unreachable from one another; telling someone about one site must not give
  them a way to the others. Visitors get no bar at all, only the site in an
  iframe.
- Only the admin sees the collection. The list, uploads and folders live in
  `/sites`. Admin UI on a public page (the bar in the shell) is rendered only
  when the server has verified the admin's credential (the Access JWT or the
  admin token's session), never on the mere presence of a cookie.
- Defend the API, not the hosted HTML's network access. Hosted HTML may
  legitimately fetch external APIs (visualization demos and the like), so drop
  does not add `connect-src 'none'`. Instead `/api/*` requires the
  `X-Drop-Request: 1` header, which forces a CORS preflight from any other
  origin that the Worker never approves, and rejects a mismatched `Origin`
  (sandboxed HTML sends `Origin: null`).

## Development

```sh
pnpm install
pnpm dev          # Workers locally (wrangler dev) on port 8788
pnpm typecheck
pnpm lint
pnpm test         # the suite on the Workers backend, then on the Bun backend (needs Bun)
pnpm build:cli    # single binary in dist/drop
```

Design decisions are recorded in `docs/adr/`, and the vocabulary used in code
and docs is in `docs/glossary.md`.

## License

MIT
