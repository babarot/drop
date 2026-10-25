import { describe, expect, it } from 'vitest'
import { targetPdfLinks } from '../src/lib/rewrite'

// Relative references from a Page in a subdirectory are resolved against that Page's Directory
// before matching
describe('targetPdfLinks on nested pages', () => {
  const pdfs = new Set(['docs/a/y.pdf', 'root.pdf', 'docs/a/図.pdf'])
  const page = 'docs/a/index.html'

  const html = (refs: string[]) =>
    `<html><body>${refs.map((r) => `<a href="${r}">x</a>`).join('')}</body></html>`
  const hrefs = (out: string) =>
    [...out.matchAll(/<a href="([^"]*)"( target="_blank")?>/g)].map((m) => [
      m[1],
      m[2] !== undefined,
    ])

  it('resolves relative refs against the page and marks PDFs without changing the value', async () => {
    const refs = [
      './y.pdf',
      'y.pdf',
      '../../root.pdf',
      'y.pdf?v=2#p',
      '図.pdf',
      '%E5%9B%B3.pdf',
      '../img/x.png',
    ]
    const out = await targetPdfLinks(html(refs), { pdfPaths: pdfs, pagePath: page })
    expect(hrefs(out)).toEqual([
      ['./y.pdf', true],
      ['y.pdf', true],
      ['../../root.pdf', true],
      ['y.pdf?v=2#p', true],
      ['図.pdf', true],
      ['%E5%9B%B3.pdf', true],
      ['../img/x.png', false],
    ])
  })

  it('leaves refs that are not PDFs of this tree untouched', async () => {
    const refs = [
      '/root.pdf',
      '//cdn.example/root.pdf',
      'https://ext.example/y.pdf',
      '#top',
      '?q=1',
      'mailto:a@b',
      '../nothere.pdf',
      'root.pdf',
      '',
    ]
    const out = await targetPdfLinks(html(refs), { pdfPaths: pdfs, pagePath: page })
    expect(hrefs(out)).toEqual(refs.map((r) => [r, false]))
  })

  it('resolves against the site root when no page path is given (entry at index.html)', async () => {
    const out = await targetPdfLinks(html(['root.pdf', './root.pdf']), { pdfPaths: pdfs })
    expect(hrefs(out)).toEqual([
      ['root.pdf', true],
      ['./root.pdf', true],
    ])
  })
})
