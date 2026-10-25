import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { archiveName, archivePaths, buildArchive, sanitizeFilename } from '../app/src/lib/download'
import { ingest } from '../app/src/lib/ingest'
import type { VersionFileMeta } from '../app/src/types'

const file = (path: string, extra: Partial<VersionFileMeta> = {}): VersionFileMeta => ({
  path,
  objectKey: `k:${path}`,
  sha256: null,
  size: 1,
  contentType: 'text/plain',
  ...extra,
})

describe('archivePaths', () => {
  // The original HTML may refer to canonical names, so legacy asset pairs include both names
  it('keeps both names of a legacy asset pair, so refs to either name still resolve', () => {
    expect(
      archivePaths([
        file('index.html'),
        file('css/a.css'),
        file('zu-1234abcd.png', { aliasOf: '図.png' }),
        file('図.png'),
      ]),
    ).toEqual(['index.html', 'css/a.css', 'zu-1234abcd.png', '図.png'])
  })
})

describe('buildArchive', () => {
  it('puts the files under one folder named after the site, keeping directories and names', async () => {
    const zip = buildArchive('my site', [
      { path: 'index.html', bytes: new TextEncoder().encode('<h1>i</h1>') },
      { path: 'docs/図.txt', bytes: new TextEncoder().encode('zu') },
    ])
    const entries = unzipSync(zip)
    expect(Object.keys(entries).sort()).toEqual(['my site/docs/図.txt', 'my site/index.html'])
    expect(strFromU8(entries['my site/index.html'] as Uint8Array)).toBe('<h1>i</h1>')
  })

  // Dropping a downloaded zip again as is brings it in as a tree with the same Paths
  it('round-trips through ingest: the top folder is stripped and the paths come back', async () => {
    const zip = buildArchive('roundtrip', [
      { path: 'index.html', bytes: new TextEncoder().encode('x') },
      { path: 'a/b.css', bytes: new TextEncoder().encode('y') },
    ])
    const { drafts, errors } = await ingest({
      loose: [new File([zip as Uint8Array<ArrayBuffer>], archiveName('roundtrip'))],
      dirs: [],
    })
    expect(errors).toEqual([])
    expect(drafts[0]?.files.map((f) => f.path).sort()).toEqual(['a/b.css', 'index.html'])
    expect(drafts[0]?.sourceName).toBe('roundtrip')
  })
})

describe('names', () => {
  it('names the archive after the source name, replacing characters files cannot hold', () => {
    expect(archiveName('report')).toBe('report.zip')
    expect(sanitizeFilename('a/b:c')).toBe('a-b-c')
    expect(sanitizeFilename('  ')).toBe('untitled')
  })
})
