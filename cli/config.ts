// CLI config and where files live (XDG). Config is ~/.config/drop/config.toml, and it is optional:
// without it, the CLI syncs ~/drop with the drop serve on this machine
//
//   remote = "https://drop.example.dev"   # drop's URL (default http://127.0.0.1:8789)
//   dir = "~/drop"                        # sync directory (default ~/drop)
//
// Locations are split per XDG. Config holds no secrets, so it can be shared via dotfiles:
//   config    $XDG_CONFIG_HOME/drop/config.toml
//   secrets   macOS Keychain, otherwise $XDG_DATA_HOME/drop/credentials.json (cli/credentials.ts)
//   state     $XDG_STATE_HOME/drop/ (synced versions, --theirs backups; per machine)
//   data      $XDG_DATA_HOME/drop/ (drop serve's SQLite, Objects and secrets)
// Override with DROP_CONFIG_DIR / DROP_STATE_DIR / DROP_DATA_DIR (for tests and development)

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface Config {
  remote: string
  dir: string
}

const home = homedir()

export const DEFAULT_DIR = '~/drop'

export const expandHome = (p: string) =>
  p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p

export function configDir(): string {
  return (
    process.env.DROP_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'drop')
  )
}

export function stateDir(): string {
  return (
    process.env.DROP_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'drop')
  )
}

// drop serve's data (SQLite, Object store, secrets)
export function dataDir(): string {
  return (
    process.env.DROP_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'drop')
  )
}

// Whether the remote is this machine (drop serve)
export const isLoopback = (remote: string) =>
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(remote).hostname)

export class ConfigError extends Error {}

// Without a config file drop is local: the sync directory ~/drop and drop serve on this machine
export const DEFAULT_REMOTE = 'http://127.0.0.1:8789'

export function loadConfig(path = join(configDir(), 'config.toml')): Config {
  if (!existsSync(path)) return { remote: DEFAULT_REMOTE, dir: resolve(expandHome(DEFAULT_DIR)) }
  const raw = Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const { remote, dir = DEFAULT_DIR } = raw
  if (typeof remote !== 'string' || remote === '') throw new ConfigError(`${path}: missing remote`)
  if (typeof dir !== 'string' || dir === '') throw new ConfigError(`${path}: missing dir`)
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    throw new ConfigError(`${path}: remote is not a URL: ${remote}`)
  }
  return { remote: url.origin, dir: resolve(expandHome(dir)) }
}
