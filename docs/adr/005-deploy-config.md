# ADR-005: A neutral wrangler.toml and per-instance deploy configuration

## Status

Accepted

## Context

wrangler.toml held the values of one instance: its domain (`routes`), the D1 database id, and the
Cloudflare Access team domain and audience. CI deployed with that file as is, and the tests and
`wrangler dev` read it too.

The repository is going to be published so that others can run their own drop. With the values of
one instance in wrangler.toml, anyone else has to edit the file, conflicts follow every upstream
change to it, and a fork's CI would point at someone else's instance. None of these values is a
secret (the D1 id is useless without an account API token, the Access audience is an application
tag), so the question is where they live, not how to hide them.

## Decision

### wrangler.toml stays neutral

The committed wrangler.toml works for anyone without edits: no `routes`, a placeholder D1 id, and
`AUTH = "token"`. Local development (`wrangler dev`), the tests (vitest-pool-workers) and type
generation keep reading it.

### A deployment builds its config from variables

`scripts/deploy-config.ts` reads wrangler.toml, applies the instance's values from the environment
and writes `wrangler.deploy.json` (not committed). CI runs it with GitHub repository variables and
deploys with `wrangler deploy --config wrangler.deploy.json`; migrations are applied with the same
config.

- Required: `DROP_DOMAIN`, `D1_DATABASE_ID`, `DROP_AUTH` (`access` or `token`)
- With `DROP_AUTH=access`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`
- Optional: `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET`

The script fails instead of writing a config when a required value is missing or malformed, so a
deployment never goes out with the placeholder D1 id or without a domain. Secrets stay where they
were: GitHub Secrets for CI (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and `wrangler secret`
for the Worker (`PREVIEW_SECRET`, and `DROP_ADMIN_TOKEN` / `DROP_SESSION_SECRET` with token auth).

### The deploy job runs only where an instance is configured

The deploy job runs only when `D1_DATABASE_ID` is set. A fork without the variables runs the Verify
job (typecheck, lint, tests) and skips deploying.

### The maintainer's instance keeps its values as code

The maintainer's own instance keeps its values as repository variables declared in the same
configuration-as-code that manages the rest of its repository settings, rather than edited by hand.

## Consequences

- Anyone can fork and deploy with the same workflow by setting the variables and secrets; the README
  describes the steps.
- wrangler.toml no longer shows what production runs. The deploy config is the generated file, and
  its values are in the repository variables.
- Changing a binding or adding a variable means updating both wrangler.toml and
  scripts/deploy-config.ts (and the workflow's environment list when a new variable is added).
- Options not taken: keeping this instance's values in the public wrangler.toml with the deploy job
  limited to the maintainer's repository (smallest change, but self-hosters edit the file and conflict with
  upstream), and a separate private repository for deploying this instance (cleanest separation, but
  two repositories and a more involved deploy).
