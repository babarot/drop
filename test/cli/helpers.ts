// Shared setup for the CLI tests. The drop on the other end is the Bun backend's SELF
// (test/bun/cloudflare-test.ts)

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { DropClient } from '../../cli/client'
import type { Notifier } from '../../cli/notify'
import type { SyncContext } from '../../cli/push'
import { State } from '../../cli/state'
import type { SiteFilesResponse } from '../../src/types'
import { env, SELF } from '../bun/cloudflare-test'
import { legacyCanonical } from '../legacy-name'

export const REMOTE = 'https://drop.test'

export interface Recorded extends Notifier {
  warnings: Map<string, string>
}

export function recorder(): Recorded {
  const warnings = new Map<string, string>()
  return {
    warnings,
    warn: (key, message) => void warnings.set(key, message),
    clear: (key) => void warnings.delete(key),
    info: () => {},
  }
}

// One machine (a sync directory and state). Two can be made against the same drop
export function device(
  dir = mkdtempSync(join(tmpdir(), 'drop-sync-')),
): SyncContext & { notify: Recorded } {
  return {
    client: new DropClient(REMOTE, {}, SELF.fetch),
    state: new State(':memory:'),
    dir,
    notify: recorder(),
    backupDir: mkdtempSync(join(tmpdir(), 'drop-backup-')),
  }
}

export function write(ctx: SyncContext, path: string, body: string | Uint8Array) {
  const abs = join(ctx.dir, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

export async function remoteTree(siteId: string): Promise<SiteFilesResponse> {
  const res = await SELF.fetch(`${REMOTE}/api/sites/${siteId}/files`, {
    headers: { 'X-Drop-Request': '1' },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as SiteFilesResponse
}

export const paths = (t: SiteFilesResponse) => t.files.map((f) => f.path).sort()

export const read = (ctx: SyncContext, path: string) => Bun.file(join(ctx.dir, path)).text()

// All tests share the same drop, so each test uses its own Source name
export const uniqueName = () => `site-${crypto.randomUUID().slice(0, 8)}`

const API = { 'X-Drop-Request': '1' }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

// The same change as adding a file from the admin UI (PATCH /tree). Used to put files on drop that
// the CLI does not send
export async function remotePut(siteId: string, path: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body)
  const sha256 = await sha256Hex(bytes)
  await SELF.fetch(`${REMOTE}/api/sites/${siteId}/objects/${sha256}`, {
    method: 'PUT',
    headers: API,
    body: bytes,
  })
  const { version } = await remoteTree(siteId)
  const res = await SELF.fetch(`${REMOTE}/api/sites/${siteId}/tree`, {
    method: 'PATCH',
    headers: { ...API, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: version, put: [{ path, sha256, size: bytes.length }] }),
  })
  expect(res.status).toBe(200)
}

// Put a legacy asset pair from before ADR-004 (two rows, canonical name and display name, pointing
// to the same Object under a legacy key) straight into the current Version (same as addLegacyPair
// in test/helpers.ts)
export async function addLegacyPair(siteId: string, display: string, body: string) {
  const name = display.normalize('NFC')
  const canonical = await legacyCanonical(name)
  const key = `assets/${siteId}/${crypto.randomUUID()}`
  await env.BUCKET.put(key, body)
  for (const path of [canonical, name]) {
    await env.DB.prepare(
      `INSERT INTO version_files (site_id, version, path, object_key, content_type, size)
       SELECT site_id, max(version), ?, ?, 'image/png', ? FROM versions WHERE site_id = ?`,
    )
      .bind(path, key, new TextEncoder().encode(body).length, siteId)
      .run()
  }
}
