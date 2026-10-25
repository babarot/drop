// CLI state (~/.local/state/drop/state.db). The synced version of each Site, and recorded notices

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SyncedFile {
  sha256: string
  size: number
}

export type SyncedTree = Record<string, SyncedFile>

// ok: in sync (local changes get pushed)
// behind: drop is ahead (push gets 409; a pull is needed)
// gone: the Site was deleted on drop
// detached: removed from sync (the folder was deleted)
export type SiteStatus = 'ok' | 'behind' | 'gone' | 'detached'

export interface SiteState {
  siteId: string
  dirName: string
  syncedVersion: number
  syncedEntry: string
  syncedTree: SyncedTree
  status: SiteStatus
}

interface Row {
  site_id: string
  dir_name: string
  synced_version: number
  synced_entry: string
  synced_tree: string
  status: SiteStatus
}

const fromRow = (r: Row): SiteState => ({
  siteId: r.site_id,
  dirName: r.dir_name,
  syncedVersion: r.synced_version,
  syncedEntry: r.synced_entry,
  syncedTree: JSON.parse(r.synced_tree) as SyncedTree,
  status: r.status,
})

export class State {
  private readonly db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS sites (
      site_id TEXT PRIMARY KEY,
      dir_name TEXT NOT NULL,
      synced_version INTEGER NOT NULL,
      synced_entry TEXT NOT NULL,
      synced_tree TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok'
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS notices (
      key TEXT PRIMARY KEY,
      message TEXT NOT NULL
    )`)
  }

  // The Site mapped to the folder (Detached ones excluded)
  byDir(dirName: string): SiteState | null {
    const r = this.db
      .query<Row, [string]>(`SELECT * FROM sites WHERE dir_name = ? AND status != 'detached'`)
      .get(dirName)
    return r ? fromRow(r) : null
  }

  all(): SiteState[] {
    return this.db.query<Row, []>('SELECT * FROM sites ORDER BY dir_name').all().map(fromRow)
  }

  // Whether the Site is mapped to a folder (false if Detached)
  active(siteId: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM sites WHERE site_id = ? AND status != 'detached'`)
        .get(siteId) !== null
    )
  }

  // Make a committed (or pulled) Version the synced version
  saveSynced(s: Omit<SiteState, 'status'>): void {
    this.db
      .query(
        `INSERT INTO sites (site_id, dir_name, synced_version, synced_entry, synced_tree, status)
         VALUES (?, ?, ?, ?, ?, 'ok')
         ON CONFLICT (site_id) DO UPDATE SET dir_name = excluded.dir_name,
           synced_version = excluded.synced_version, synced_entry = excluded.synced_entry,
           synced_tree = excluded.synced_tree, status = 'ok'`,
      )
      .run(s.siteId, s.dirName, s.syncedVersion, s.syncedEntry, JSON.stringify(s.syncedTree))
  }

  setStatus(siteId: string, status: SiteStatus): void {
    this.db.query('UPDATE sites SET status = ? WHERE site_id = ?').run(status, siteId)
  }

  // false if the notice is the same as before (not repeated)
  recordNotice(key: string, message: string): boolean {
    const prev = this.db
      .query<{ message: string }, [string]>('SELECT message FROM notices WHERE key = ?')
      .get(key)
    if (prev?.message === message) return false
    this.db
      .query(
        'INSERT INTO notices (key, message) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET message = excluded.message',
      )
      .run(key, message)
    return true
  }

  clearNotice(key: string): void {
    this.db.query('DELETE FROM notices WHERE key = ?').run(key)
  }

  notices(): { key: string; message: string }[] {
    return this.db.query<{ key: string; message: string }, []>('SELECT * FROM notices').all()
  }

  close(): void {
    this.db.close()
  }
}
