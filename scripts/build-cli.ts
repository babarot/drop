// Build drop's CLI into a single binary (pnpm build:cli). To embed the admin SPA build (app/dist)
// and the migrations, generate an entry point in dist/ that imports them, then pass it to bun build
// --compile. Build the admin SPA first (pnpm build)
//
//   bun scripts/build-cli.ts [<target>]            generate the entry point and compile dist/drop
//   bun scripts/build-cli.ts --entry [<version>]   only generate the entry point, embedding the
//                                                  version drop --version prints (GoReleaser
//                                                  compiles it for each target, .goreleaser.yaml)

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const out = join(repo, 'dist')
const arg = process.argv[2]
const version = (arg === '--entry' && process.argv[3]) || 'dev'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

const assets = walk(join(repo, 'app', 'dist'))
const migrations = readdirSync(join(repo, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
if (!assets.some((f) => f.endsWith(join('sites', 'index.html')))) {
  throw new Error('no build in app/dist; run pnpm build first')
}

const lines: string[] = []
const assetEntries: string[] = []
assets.forEach((file, i) => {
  lines.push(`import a${i} from ${JSON.stringify(file)} with { type: 'file' }`)
  assetEntries.push(`[${JSON.stringify(`/${relative(join(repo, 'app', 'dist'), file)}`)}, a${i}]`)
})
const migrationEntries: string[] = []
migrations.forEach((name, i) => {
  lines.push(
    `import m${i} from ${JSON.stringify(join(repo, 'migrations', name))} with { type: 'text' }`,
  )
  migrationEntries.push(`{ name: ${JSON.stringify(name)}, sql: m${i} }`)
})
lines.push(
  `globalThis.__dropEmbedded = { version: ${JSON.stringify(version)}, assets: new Map([${assetEntries.join(', ')}]), migrations: [${migrationEntries.join(', ')}] }`,
  `await import(${JSON.stringify(join(repo, 'cli', 'main.ts'))})`,
)

mkdirSync(out, { recursive: true })
const entry = join(out, 'drop-entry.ts')
writeFileSync(entry, `${lines.join('\n')}\n`)
if (arg === '--entry') process.exit(0)

const args = ['build', '--compile', entry, '--outfile', join(out, 'drop')]
if (arg) args.push(`--target=${arg}`)
const r = Bun.spawnSync(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' })
process.exit(r.exitCode ?? 1)
