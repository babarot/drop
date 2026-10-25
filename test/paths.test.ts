import { describe, expect, it } from 'vitest'
import { contentTypeOf, normalizePath } from '../shared/files'

const ok = (raw: string) => {
  const r = normalizePath(raw)
  if ('error' in r) throw new Error(`${raw}: ${r.error}`)
  return r.path
}
const rejected = (raw: string) => 'error' in normalizePath(raw)

describe('normalizePath', () => {
  it('accepts nested paths and normalizes to NFC', () => {
    expect(ok('index.html')).toBe('index.html')
    expect(ok('about/team/index.html')).toBe('about/team/index.html')
    expect(ok('図か.png'.normalize('NFD'))).toBe('図か.png'.normalize('NFC'))
  })

  it('allows ? # % and spaces, which serving decodes per segment', () => {
    for (const p of ['a?b.html', 'a#b.png', 'a%20b.css', 'my file.pdf']) expect(ok(p)).toBe(p)
  })

  it('rejects absolute, trailing-slash, empty and dot segments', () => {
    for (const p of ['', '/a.html', 'a/', 'a//b.html', './a.html', 'a/../b.html', '..', '.']) {
      expect(rejected(p), p).toBe(true)
    }
  })

  it('rejects backslashes, control and bidi characters', () => {
    // Do not put raw bidi control characters in the source (invisible characters deceive the
    // reader)
    const rlo = String.fromCodePoint(0x202e)
    const lri = String.fromCodePoint(0x2066)
    for (const p of [
      'a\\b.html',
      'a\u0000.html',
      'a\u001f.html',
      'a\u0085.html',
      `a${rlo}.html`,
      `a${lri}.html`,
    ]) {
      expect(rejected(p), JSON.stringify(p)).toBe(true)
    }
  })

  it('limits segment and path lengths', () => {
    expect(ok(`${'a'.repeat(250)}.html`)).toHaveLength(255)
    expect(rejected(`${'a'.repeat(251)}.html`)).toBe(true)
    const deep = Array.from({ length: 10 }, () => 'b'.repeat(100)).join('/')
    expect(ok(`${deep}/x.css`)).toBeTruthy()
    expect(rejected(`${deep}/${'c'.repeat(100)}/x.css`)).toBe(true)
  })
})

describe('contentTypeOf', () => {
  it('treats .html and .htm as pages regardless of case', () => {
    for (const p of ['index.html', 'a/b.htm', 'FOO.HTML', 'Bar.Htm']) {
      expect(contentTypeOf(p), p).toBe('text/html')
    }
  })

  it('uses the asset allowlist and falls back to octet-stream', () => {
    expect(contentTypeOf('css/a.CSS')).toBe('text/css')
    expect(contentTypeOf('img/x.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('doc.pdf')).toBe('application/pdf')
    // XML types that can run scripts and extensions common in archives are neither Pages nor on the
    // allow list
    for (const p of [
      'a.xhtml',
      'feed.xml',
      'app.js.map',
      'site.webmanifest',
      'README',
      '.htaccess',
    ]) {
      expect(contentTypeOf(p), p).toBe('application/octet-stream')
    }
  })
})
