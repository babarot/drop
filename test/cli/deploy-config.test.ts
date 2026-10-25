// scripts/deploy-config.ts: the instance's values (repository variables in CI) applied to the
// neutral wrangler.toml. Runs in the Bun project (it reads wrangler.toml with Bun.TOML)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeployConfigError, deployConfig } from '../../scripts/deploy-config'

const base = Bun.TOML.parse(
  readFileSync(join(import.meta.dirname, '../../wrangler.toml'), 'utf8'),
) as Parameters<typeof deployConfig>[0]

const env = {
  DROP_DOMAIN: 'drop.example.dev',
  D1_DATABASE_ID: 'c0a1aa74-255a-4743-a0e6-2ca590b1fb21',
  DROP_AUTH: 'token',
}

describe('deploy config', () => {
  it('keeps the repository wrangler.toml neutral', () => {
    expect(base.routes).toBeUndefined()
    expect(base.vars?.AUTH).toBe('token')
    expect(base.vars?.ACCESS_AUD).toBeUndefined()
  })

  it('applies the domain, the D1 id and the admin authentication', () => {
    const config = deployConfig(base, env)
    expect(config.routes).toEqual([{ pattern: 'drop.example.dev', custom_domain: true }])
    expect(config.d1_databases?.[0]?.database_id).toBe(env.D1_DATABASE_ID)
    expect(config.d1_databases?.[0]?.binding).toBe('DB')
    expect(config.vars?.AUTH).toBe('token')
    expect(config.vars?.ACCESS_AUD).toBeUndefined()
    // everything else comes from wrangler.toml unchanged
    expect(config.assets).toEqual(base.assets)
    expect(config.name).toBe(base.name)
  })

  it('needs the Access values when AUTH is access', () => {
    expect(() => deployConfig(base, { ...env, DROP_AUTH: 'access' })).toThrow('ACCESS_TEAM_DOMAIN')
    const config = deployConfig(base, {
      ...env,
      DROP_AUTH: 'access',
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
    })
    expect(config.vars).toMatchObject({ AUTH: 'access', ACCESS_AUD: 'aud' })
  })

  it('takes optional names for the Worker, D1 and R2', () => {
    const config = deployConfig(base, {
      ...env,
      WORKER_NAME: 'my-drop',
      D1_DATABASE_NAME: 'my-db',
      R2_BUCKET: 'my-files',
    })
    expect(config.name).toBe('my-drop')
    expect(config.d1_databases?.[0]?.database_name).toBe('my-db')
    expect(config.r2_buckets?.[0]?.bucket_name).toBe('my-files')
  })

  it('refuses to build a config that would deploy with placeholders', () => {
    for (const bad of [
      { ...env, DROP_DOMAIN: '' },
      { ...env, DROP_DOMAIN: 'https://drop.example.dev' },
      { ...env, D1_DATABASE_ID: undefined },
      { ...env, D1_DATABASE_ID: 'drop-db' },
      { ...env, DROP_AUTH: undefined },
      { ...env, DROP_AUTH: 'none' },
    ]) {
      expect(() => deployConfig(base, bad), JSON.stringify(bad)).toThrow(DeployConfigError)
    }
  })
})
