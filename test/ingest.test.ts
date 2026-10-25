import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { type DropPayload, ingest, type SiteDraft, withEntry } from '../app/src/lib/ingest'
import { MAX_FILES } from '../shared/files'

const file = (name: string, body = 'x') => new File([body], name)
const loose = (...files: File[]): DropPayload => ({ loose: files, dirs: [] })
const dir = (name: string, entries: [string, string?][]): DropPayload => ({
  loose: [],
  dirs: [
    {
      name,
      files: entries.map(([path, body]) => ({
        path,
        file: file(path.split('/').pop() as string, body),
      })),
    },
  ],
})
const zip = (name: string, entries: Record<string, string>) =>
  new File(
    [zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])))],
    name,
  )

const pathsOf = (d: SiteDraft | undefined) => d?.files.map((f) => f.path).sort()

describe('ingest: loose files', () => {
  it('turns a single HTML into one site at index.html, named after the file', async () => {
    const { drafts, errors } = await ingest(loose(file('report.html')))
    expect(errors).toEqual([])
    expect(drafts).toHaveLength(1)
    expect(pathsOf(drafts[0])).toEqual(['index.html'])
    expect(drafts[0]?.entry).toBe('index.html')
    expect(drafts[0]?.sourceName).toBe('report')
    expect(drafts[0]?.matchNames).toEqual(['report'])
  })

  it('keeps several HTML files without assets as separate sites (as before)', async () => {
    const { drafts } = await ingest(loose(file('a.html'), file('b.htm')))
    expect(drafts.map((d) => d.sourceName).sort()).toEqual(['a', 'b'])
    expect(drafts.every((d) => d.files.length === 1 && d.entry === 'index.html')).toBe(true)
  })

  it('puts one HTML and its assets into one site, the HTML at index.html', async () => {
    const { drafts } = await ingest(
      loose(file('report.html'), file('pic.png'), file('資料.pdf'.normalize('NFD'))),
    )
    expect(drafts).toHaveLength(1)
    expect(pathsOf(drafts[0])).toEqual(['index.html', 'pic.png', '資料.pdf'.normalize('NFC')])
    expect(drafts[0]?.sourceName).toBe('report')
  })

  it('keeps names for several HTML files with assets, and asks for the entry without index.html', async () => {
    const { drafts } = await ingest(loose(file('a.html'), file('b.html'), file('pic.png')))
    expect(drafts).toHaveLength(1)
    const draft = drafts[0] as SiteDraft
    expect(pathsOf(draft)).toEqual(['a.html', 'b.html', 'pic.png'])
    expect(draft.entry).toBeNull()
    expect(draft.pages).toEqual(['a.html', 'b.html'])

    const chosen = withEntry(draft, 'b.html')
    expect(chosen.entry).toBe('b.html')
    expect(chosen.sourceName).toBe('b')
    expect(chosen.matchNames).toEqual(['b'])
  })

  it('picks a root index.html as the entry when present', async () => {
    const { drafts } = await ingest(loose(file('index.html'), file('about.html'), file('a.css')))
    expect(drafts[0]?.entry).toBe('index.html')
    expect(drafts[0]?.sourceName).toBe('index')
  })

  it('rejects assets without any HTML', async () => {
    const { drafts, errors } = await ingest(loose(file('pic.png')))
    expect(drafts).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe('ingest: directories', () => {
  it('strips the dropped directory name and keeps subdirectories', async () => {
    const { drafts, errors } = await ingest(
      dir('my-site', [
        ['index.html'],
        ['about/index.html'],
        ['css/a.css'],
        ['img/図.png'.normalize('NFD')],
      ]),
    )
    expect(errors).toEqual([])
    expect(pathsOf(drafts[0])).toEqual([
      'about/index.html',
      'css/a.css',
      'img/図.png',
      'index.html',
    ])
    expect(drafts[0]?.entry).toBe('index.html')
    expect(drafts[0]?.sourceName).toBe('my-site')
    // If the Entry is index.html, that file name (index) is not added for matching (it would match
    // unrelated index Sites)
    expect(drafts[0]?.matchNames).toEqual(['my-site'])
  })

  it('drops macOS junk files', async () => {
    const { drafts } = await ingest(
      dir('d', [
        ['page.html'],
        ['.DS_Store'],
        ['img/.DS_Store'],
        ['__MACOSX/page.html'],
        ['img/a.png'],
      ]),
    )
    expect(pathsOf(drafts[0])).toEqual(['img/a.png', 'page.html'])
    // Even without index.html at the root, if there is exactly one HTML file, it is the Entry
    expect(drafts[0]?.entry).toBe('page.html')
    expect(drafts[0]?.matchNames).toEqual(['d', 'page'])
  })

  it('asks for the entry when there are several pages and no root index.html', async () => {
    const { drafts } = await ingest(dir('d', [['a.html'], ['b/index.html']]))
    expect(drafts[0]?.entry).toBeNull()
    expect(drafts[0]?.pages).toEqual(['a.html', 'b/index.html'])
    expect(drafts[0]?.sourceName).toBe('d')
  })

  it('rejects the whole directory when one path is invalid, so no broken site is committed', async () => {
    const { drafts, errors } = await ingest(dir('d', [['index.html'], ['bad\\name.css']]))
    expect(drafts).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.name).toBe('d')
  })

  it('rejects a directory without any HTML', async () => {
    const { drafts, errors } = await ingest(dir('d', [['a.css'], ['b.png']]))
    expect(drafts).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe('ingest: zip', () => {
  it('unpacks in the browser, stripping a single top folder and junk', async () => {
    const archive = zip('archive.zip', {
      'site/index.html': '<h1>zip</h1>',
      'site/css/a.css': 'body{}',
      'site/.DS_Store': 'junk',
      '__MACOSX/site/._index.html': 'junk',
    })
    const { drafts, errors } = await ingest(loose(archive))
    expect(errors).toEqual([])
    expect(pathsOf(drafts[0])).toEqual(['css/a.css', 'index.html'])
    expect(drafts[0]?.sourceName).toBe('archive')
    expect(drafts[0]?.matchNames).toEqual(['archive'])
    expect(await drafts[0]?.files.find((f) => f.path === 'index.html')?.file.text()).toBe(
      '<h1>zip</h1>',
    )
  })

  // A zip holding only index.html is still treated as a tree, distinct from a loose HTML file
  it('keeps a zip with a lone index.html as a zip-named tree, not a plain HTML upload', async () => {
    const { drafts } = await ingest(loose(zip('lonely.zip', { 'index.html': 'only' })))
    expect(drafts[0]?.naming).toBe('fixed')
    expect(drafts[0]?.sourceName).toBe('lonely')
    expect(drafts[0]?.matchNames).toEqual(['lonely'])
    const { drafts: plain } = await ingest(loose(file('page.html')))
    expect(plain[0]?.naming).toBe('html')
  })

  it('keeps the top level when the zip has several entries at its root', async () => {
    const { drafts } = await ingest(
      loose(zip('flat.zip', { 'index.html': 'a', 'docs/x.html': 'b' })),
    )
    expect(pathsOf(drafts[0])).toEqual(['docs/x.html', 'index.html'])
  })

  it('treats each zip as its own site, alongside other loose files', async () => {
    const { drafts } = await ingest(
      loose(
        zip('one.zip', { 'index.html': '1' }),
        zip('two.zip', { 'index.html': '2' }),
        file('solo.html'),
      ),
    )
    expect(drafts.map((d) => d.sourceName).sort()).toEqual(['one', 'solo', 'two'])
  })

  it('refuses a zip with too many entries before unpacking it', async () => {
    const entries: Record<string, string> = { 'index.html': 'x' }
    for (let i = 0; i < MAX_FILES; i++) entries[`f/${i}.txt`] = ''
    const { drafts, errors } = await ingest(loose(zip('many.zip', entries)))
    expect(drafts).toEqual([])
    expect(errors[0]?.name).toBe('many.zip')
  })

  it('refuses a broken zip', async () => {
    const { drafts, errors } = await ingest(loose(file('broken.zip', 'not a zip')))
    expect(drafts).toEqual([])
    expect(errors).toHaveLength(1)
  })
})
