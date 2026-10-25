import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildFileTree, type TreeDir } from '../app/src/lib/file-tree'
import type { VersionFileMeta } from '../app/src/types'

const file = (path: string, extra: Partial<VersionFileMeta> = {}): VersionFileMeta => ({
  path,
  objectKey: `k:${path}`,
  sha256: null,
  size: 1,
  contentType: 'text/plain',
  ...extra,
})

const shape = (dir: TreeDir): unknown => ({
  [dir.path || '/']: [...dir.dirs.map(shape), ...dir.files.map((f) => f.name)],
  count: dir.count,
})

describe('buildFileTree', () => {
  it('nests files by directory, directories first, with counts', () => {
    const root = buildFileTree([
      file('index.html'),
      file('css/b.css'),
      file('css/a.css'),
      file('about/team/index.html'),
      file('about/index.html'),
      file('a.txt'),
    ])
    expect(shape(root)).toEqual({
      '/': [
        {
          about: [{ 'about/team': ['index.html'], count: 1 }, 'index.html'],
          count: 2,
        },
        { css: ['a.css', 'b.css'], count: 2 },
        'a.txt',
        'index.html',
      ],
      count: 6,
    })
  })

  it('shows a legacy asset pair as one row under its display name', () => {
    const root = buildFileTree([
      file('index.html'),
      file('zu-1234abcd.png', { aliasOf: '図.png' }),
      file('図.png'),
    ])
    expect(root.files.map((f) => [f.name, f.canonical])).toEqual([
      ['index.html', undefined],
      ['図.png', 'zu-1234abcd.png'],
    ])
    expect(root.count).toBe(2)
  })
})

describe('ancestorsOf', () => {
  it('lists parent directories from the top', () => {
    expect(ancestorsOf('a/b/c.html')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('index.html')).toEqual([])
  })
})
