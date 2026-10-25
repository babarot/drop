// drop CLI entry point: bun cli/main.ts <command>
//
//   drop push [<folder>...]   push folders in the sync directory (all if omitted)
//     --force                 on conflict, keep local (drop's content stays in the prior Version)
//   drop pull [<name>...]     fetch Sites from drop (all if omitted; a folder or Source name)
//     --theirs                on conflict, take remote (local files are copied to a backup)
//     --include <name>        bring a Detached Site back into sync
//   drop watch                watch the sync directory and push changed folders automatically
//   drop status               show sync status and notices
//   drop login                set the remote's credentials (Access service token)
//   drop serve [--port N]     run drop without Cloudflare (127.0.0.1 only; default port 8789)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DropClient } from './client'
import { ConfigError, dataDir, isLoopback, loadConfig, stateDir } from './config'
import { authHeaders, loadCredential, saveCredential } from './credentials'
import { askCredential, detectAuth } from './login'
import { notifier } from './notify'
import { pullAll } from './pull'
import { pushAll, pushSite, resolveDir, type SyncContext } from './push'
import { scanSite } from './scan'
import { cliTokenPath, startServer } from './serve'
import { State } from './state'
import { startWatch } from './watch'

// For drop serve, send the secret from its data directory as a Bearer token. Otherwise an Access
// service token
function remoteHeaders(remote: string): Record<string, string> {
  if (isLoopback(remote)) {
    const path = cliTokenPath(dataDir())
    return existsSync(path) ? { Authorization: `Bearer ${readFileSync(path, 'utf8').trim()}` } : {}
  }
  return authHeaders(loadCredential(remote))
}

function context(desktop: boolean): SyncContext {
  const config = loadConfig()
  const state = new State(join(stateDir(), 'state.db'))
  const client = new DropClient(config.remote, remoteHeaders(config.remote))
  return {
    client,
    state,
    dir: config.dir,
    notify: notifier(state, { desktop }),
    backupDir: join(stateDir(), 'backup'),
  }
}

async function status(ctx: SyncContext): Promise<void> {
  for (const s of ctx.state.all()) {
    let local = ''
    if (s.status === 'ok') {
      const scanned = await scanSite(join(ctx.dir, s.dirName), new Set(Object.keys(s.syncedTree)))
        .then((r) => r.files)
        .catch(() => null)
      const changed =
        scanned === null ||
        scanned.length !== Object.keys(s.syncedTree).length ||
        scanned.some((f) => s.syncedTree[f.path]?.sha256 !== f.sha256)
      local = changed ? ' (local changes not pushed)' : ''
    }
    console.log(`${s.dirName}\tv${s.syncedVersion}\t${s.status}${local}`)
  }
  for (const n of ctx.state.notices()) console.log(`! ${n.message}`)
}

async function login(): Promise<void> {
  const config = loadConfig()
  if (isLoopback(config.remote)) {
    console.log('drop serve needs no login (the token in its data directory is used automatically)')
    return
  }
  const kind = await detectAuth(config.remote)
  if (kind === 'none') {
    console.log(`${config.remote} needs no credentials`)
    return
  }
  console.log(
    kind === 'access'
      ? `Enter the Cloudflare Access service token for ${config.remote} (input is hidden)`
      : `Enter the admin token for ${config.remote} (input is hidden)`,
  )
  saveCredential(config.remote, await askCredential(kind))
  console.log('saved')
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  switch (command) {
    case 'push': {
      const ctx = context(false)
      const force = args.includes('--force')
      const names = args.filter((a) => !a.startsWith('--'))
      if (force && names.length === 0) throw new ConfigError('--force requires a folder')
      const results = names.length > 0 ? null : await pushAll(ctx)
      if (results === null) {
        for (const name of names) {
          const dirName = resolveDir(ctx, name)
          console.log(`${dirName}\t${await pushSite(ctx, dirName, { force })}`)
        }
      } else {
        for (const [dirName, outcome] of results) console.log(`${dirName}\t${outcome}`)
      }
      return 0
    }
    case 'watch': {
      const ctx = context(true)
      ctx.notify.info(`watching ${ctx.dir} (${ctx.client.remote})`)
      await pushAll(ctx)
      const w = startWatch(ctx)
      process.on('SIGINT', () => {
        w.stop()
        process.exit(0)
      })
      await new Promise(() => {})
      return 0
    }
    case 'pull': {
      const ctx = context(false)
      const include: string[] = []
      const only: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string
        if (a === '--include') include.push(args[++i] ?? '')
        else if (!a.startsWith('--')) only.push(a)
      }
      const results = await pullAll(ctx, {
        theirs: args.includes('--theirs'),
        include,
        only: only.length > 0 || include.length > 0 ? [...only, ...include] : undefined,
      })
      for (const [name, outcome] of results) console.log(`${name}\t${outcome}`)
      return 0
    }
    case 'serve': {
      const i = args.indexOf('--port')
      const port = i >= 0 ? Number(args[i + 1]) : 8789
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new ConfigError('invalid --port')
      const server = startServer({ dataDir: dataDir(), port })
      console.log(`drop: ${server.url}`)
      console.log(`admin login: ${server.url}/login?code=${server.auth.issueLoginCode()}`)
      console.log(`data: ${dataDir()}`)
      process.on('SIGINT', () => {
        server.stop()
        process.exit(0)
      })
      await new Promise(() => {})
      return 0
    }
    case 'status':
      await status(context(false))
      return 0
    case 'login':
      await login()
      return 0
    default:
      console.log(
        'usage: drop <push [--force] [folder...] | pull [--theirs] [--include name] [name...] | watch | status | login | serve [--port N]>',
      )
      return command === undefined || command === 'help' ? 0 : 1
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
