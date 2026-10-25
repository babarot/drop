import { describe, expect, it } from 'vitest'
import { canLineDiff, compareTrees, MAX_DIFF_SIZE } from '../app/src/lib/tree-diff'
import type { VersionFileMeta, VersionFilesResponse } from '../app/src/types'

const file = (path: string, objectKey: string, extra: Partial<VersionFileMeta> = {}) => ({
  path,
  objectKey,
  sha256: null,
  size: 1,
  contentType: path.endsWith('.html') ? 'text/html' : 'application/octet-stream',
  ...extra,
})
const tree = (entry: string, files: VersionFileMeta[]): VersionFilesResponse => ({ entry, files })

describe('compareTrees', () => {
  // Direction is current -> selected Version (what a restore would do)
  it('classifies files as added, removed, changed and unchanged from current to selected', () => {
    const current = tree('index.html', [
      file('index.html', 'k1'),
      file('gone.css', 'k2'),
      file('same.png', 'k3'),
      file('edited.js', 'k4'),
    ])
    const selected = tree('index.html', [
      file('index.html', 'k1'),
      file('same.png', 'k3'),
      file('edited.js', 'k5'),
      file('new.svg', 'k6'),
    ])
    const { changes, entryChanged } = compareTrees(current, selected)
    expect(entryChanged).toBeNull()
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['edited.js', 'changed'],
      ['gone.css', 'removed'],
      ['index.html', 'same'],
      ['new.svg', 'added'],
      ['same.png', 'same'],
    ])
    const edited = changes.find((c) => c.path === 'edited.js')
    expect(edited?.current?.objectKey).toBe('k4')
    expect(edited?.selected?.objectKey).toBe('k5')
  })

  it('treats equal sha256 under different keys as unchanged, but not two null hashes', () => {
    const h = 'a'.repeat(64)
    const current = tree('index.html', [
      file('index.html', 'versions/x/1.html'),
      file('a.css', 'assets/x/a.css', { sha256: h }),
    ])
    const selected = tree('index.html', [
      file('index.html', 'sites/x/objects/b'),
      file('a.css', `sites/x/objects/${h}`, { sha256: h }),
    ])
    const { changes } = compareTrees(current, selected)
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['a.css', 'same'],
      ['index.html', 'changed'],
    ])
  })

  it('reports an entry change', () => {
    const current = tree('index.html', [file('index.html', 'k1'), file('start.html', 'k2')])
    const selected = tree('start.html', [file('index.html', 'k1'), file('start.html', 'k2')])
    expect(compareTrees(current, selected).entryChanged).toEqual({
      from: 'index.html',
      to: 'start.html',
    })
  })

  it('skips the canonical row of a legacy asset pair, keeping the display name', () => {
    const current = tree('index.html', [
      file('index.html', 'k1'),
      file('zu-1234abcd.png', 'k2', { aliasOf: '図.png' }),
      file('図.png', 'k2'),
    ])
    const selected = tree('index.html', [file('index.html', 'k1')])
    expect(compareTrees(current, selected).changes.map((c) => [c.path, c.status])).toEqual([
      ['index.html', 'same'],
      ['図.png', 'removed'],
    ])
  })
})

describe('canLineDiff', () => {
  const change = (contentType: string, size = 10) => ({
    path: 'x',
    status: 'changed' as const,
    current: file('x', 'a', { contentType, size }),
    selected: file('x', 'b', { contentType, size }),
  })

  it('accepts text-like types up to the size limit', () => {
    for (const t of [
      'text/html',
      'text/css',
      'text/plain',
      'image/svg+xml',
      'application/json',
      'text/javascript',
    ]) {
      expect(canLineDiff(change(t)), t).toBe(true)
    }
    expect(canLineDiff(change('text/css', MAX_DIFF_SIZE))).toBe(true)
    expect(canLineDiff(change('text/css', MAX_DIFF_SIZE + 1))).toBe(false)
  })

  it('rejects binaries', () => {
    for (const t of ['image/png', 'application/pdf', 'application/octet-stream', 'font/woff2']) {
      expect(canLineDiff(change(t)), t).toBe(false)
    }
  })

  it('works for one-sided changes (added or removed files)', () => {
    const added = {
      path: 'x.css',
      status: 'added' as const,
      selected: file('x.css', 'b', { contentType: 'text/css' }),
    }
    expect(canLineDiff(added)).toBe(true)
  })
})
