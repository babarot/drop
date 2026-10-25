// Build the deploy configuration for one drop instance (ADR-005). wrangler.toml in the repository is
// neutral: no domain, a placeholder D1 id, AUTH = "token". The instance's values come from the
// environment (GitHub repository variables in CI) and are written to wrangler.deploy.json, which
// `wrangler deploy --config wrangler.deploy.json` uses. Nothing here is a secret; secrets stay in
// GitHub Secrets (for CI) and `wrangler secret` (for the Worker).
//
// Required: DROP_DOMAIN, D1_DATABASE_ID, DROP_AUTH ("access" or "token")
// With DROP_AUTH=access: ACCESS_TEAM_DOMAIN, ACCESS_AUD
// Optional: WORKER_NAME, D1_DATABASE_NAME, R2_BUCKET (default to the names in wrangler.toml)

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Config = Record<string, unknown> & {
  d1_databases?: Record<string, unknown>[]
  r2_buckets?: Record<string, unknown>[]
  vars?: Record<string, string>
}

export class DeployConfigError extends Error {}

const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

// The base config with the instance's values applied. Throws when a required value is missing or
// malformed, so a deploy never goes out with the placeholder D1 id or without a domain
export function deployConfig(base: Config, env: Record<string, string | undefined>): Config {
  const need = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new DeployConfigError(`${name} is not set`)
    return value
  }
  const domain = need('DROP_DOMAIN').toLowerCase()
  if (!DOMAIN.test(domain)) throw new DeployConfigError(`DROP_DOMAIN is not a host name: ${domain}`)
  const databaseId = need('D1_DATABASE_ID').toLowerCase()
  if (!D1_ID.test(databaseId)) throw new DeployConfigError('D1_DATABASE_ID is not a D1 database id')
  const auth = need('DROP_AUTH')
  if (auth !== 'access' && auth !== 'token') {
    throw new DeployConfigError(`DROP_AUTH must be "access" or "token", got "${auth}"`)
  }

  const [database, ...otherDatabases] = base.d1_databases ?? []
  const [bucket, ...otherBuckets] = base.r2_buckets ?? []
  if (!database || !bucket)
    throw new DeployConfigError('wrangler.toml has no D1 database or R2 bucket')

  const vars: Record<string, string> = { ...base.vars, AUTH: auth }
  if (auth === 'access') {
    vars.ACCESS_TEAM_DOMAIN = need('ACCESS_TEAM_DOMAIN')
    vars.ACCESS_AUD = need('ACCESS_AUD')
  }
  return {
    ...base,
    name: env.WORKER_NAME?.trim() || base.name,
    routes: [{ pattern: domain, custom_domain: true }],
    d1_databases: [
      {
        ...database,
        database_name: env.D1_DATABASE_NAME?.trim() || database.database_name,
        database_id: databaseId,
      },
      ...otherDatabases,
    ],
    r2_buckets: [
      { ...bucket, bucket_name: env.R2_BUCKET?.trim() || bucket.bucket_name },
      ...otherBuckets,
    ],
    vars,
  }
}

if (import.meta.main) {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const base = Bun.TOML.parse(readFileSync(join(repo, 'wrangler.toml'), 'utf8')) as Config
  try {
    const config = deployConfig(base, process.env)
    writeFileSync(join(repo, 'wrangler.deploy.json'), `${JSON.stringify(config, null, 2)}\n`)
    const database = config.d1_databases?.[0]
    console.log(
      `wrangler.deploy.json: ${config.name} on ${process.env.DROP_DOMAIN}, ` +
        `D1 ${database?.database_name}, AUTH=${config.vars?.AUTH}`,
    )
  } catch (e) {
    if (!(e instanceof DeployConfigError)) throw e
    console.error(`deploy config: ${e.message}`)
    process.exit(1)
  }
}
