import { afterAll, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { extractOfficeText } from '../../office/src/office.ts'
import { renderDocument } from '../../office/src/documents.ts'
import { validateDocument } from '../src/host/documents.ts'

it('generates headings, paragraphs and tables a reader can find again', async () => {
  const source = validateDocument({ title: '预算报告', blocks: [{ kind: 'heading', level: 1, text: '预算' }, { kind: 'paragraph', text: '差额 5000，差额率 2.17%' }, { kind: 'table', rows: [['预算', '实际'], ['230000', '235000']] }] })
  const { bytes } = await renderDocument(source, new AbortController().signal)
  const result = extractOfficeText(bytes, 'report.docx', 16000000, new AbortController().signal)
  expect(result.text).toContain('Heading1')
  expect(result.text).toContain('230000')
  expect(result.text).toContain('差额 5000')
})
it('rejects executable fields and malformed tables', () => {
  const source = validateDocument({ title: 't', blocks: [{ kind: 'paragraph', text: 'a' }] })
  expect(() => validateDocument({ ...source, code: 'process.exit()' })).toThrow()
  expect(() => validateDocument({ title: 't', blocks: [{ kind: 'table', rows: [['a'], ['a', 'b']] }] })).toThrow()
})
it('does not finish a cancelled generation', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(renderDocument({ title: 't', blocks: [{ kind: 'paragraph', text: 'a' }] }, controller.signal)).rejects.toThrow()
})
describe('richer documents', () => {
  const signal = new AbortController().signal
  const renderer = new OfficeRenderer()
  afterAll(() => renderer.dispose())
  const parts = (bytes: Uint8Array) => unzipSync(bytes)
  const main = (bytes: Uint8Array) => strFromU8(parts(bytes)['word/document.xml']!)
  it('turns HTML into Word lists, formatting, links and tables', async () => {
    const { bytes, warnings } = await renderDocument({ title: 't', blocks: [{ kind: 'html', html: '<h2>标题</h2><p><strong>粗体</strong>和<a href="https://example.com/">链接</a></p><ul><li>一</li></ul><table><tr><th>甲</th></tr><tr><td>1</td></tr></table>' }] }, signal)
    expect(warnings).toEqual([])
    const xml = main(bytes)
    expect(xml).toContain('Heading2')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:hyperlink')
    expect(xml).toContain('<w:numPr>')
    expect(xml).toContain('<w:tbl>')
  })
  it('never fetches an image, and says it was left out', async () => {
    const { bytes, warnings } = await renderDocument({ title: 't', blocks: [{ kind: 'html', html: '<p>a</p><img src="https://example.com/track.png">' }] }, signal)
    expect(warnings.join()).toContain('track.png')
    expect(Object.keys(parts(bytes)).filter(name => name.includes('media'))).toEqual([])
  })
  it('sets a font for Chinese as well as Latin text', async () => {
    const { bytes } = await renderDocument({ title: 't', blocks: [{ kind: 'paragraph', text: '中文 Latin' }] }, signal)
    expect(strFromU8(parts(bytes)['word/styles.xml']!)).toContain('w:eastAsia="Microsoft YaHei"')
  })
  it('numbers pages unless told not to, and repeats a header', async () => {
    const numbered = await renderDocument({ title: 't', header: '内部资料', blocks: [{ kind: 'paragraph', text: 'a' }] }, signal)
    const names = Object.keys(parts(numbered.bytes))
    expect(strFromU8(parts(numbered.bytes)[names.find(name => /footer\d\.xml$/u.test(name))!]!)).toContain('NUMPAGES')
    expect(strFromU8(parts(numbered.bytes)[names.find(name => /header\d\.xml$/u.test(name))!]!)).toContain('内部资料')
    const plain = await renderDocument({ title: 't', pageNumbers: false, blocks: [{ kind: 'paragraph', text: 'a' }] }, signal)
    expect(Object.keys(parts(plain.bytes)).filter(name => /footer\d\.xml$/u.test(name))).toEqual([])
  })
  it('writes a table of contents that already lists the headings and their pages', async () => {
    const { bytes } = await renderDocument({ title: 't', blocks: [{ kind: 'toc' }, { kind: 'pageBreak' }, { kind: 'heading', level: 1, text: '第一章' }, { kind: 'pageBreak' }, { kind: 'heading', level: 2, text: '第二节' }] }, signal)
    const xml = main(bytes)
    expect(xml).toContain('TOC ')
    const contents = xml.slice(0, xml.indexOf('</w:sdtContent>'))
    expect(contents).toContain('第一章')
    expect(contents).toMatch(/>2<\/w:t>/u)
    expect(contents).toMatch(/>3<\/w:t>/u)
  })
  it('draws charts as editable chart parts', async () => {
    const { bytes } = await renderDocument({ title: 't', blocks: [
      { kind: 'chart', chart: 'column', title: '收入', categories: ['一月', '二月'], series: [{ name: '甲', values: [1, 2] }, { name: '乙', values: [3, 4] }] },
      { kind: 'chart', chart: 'pie', categories: ['甲', '乙'], series: [{ name: '占比', values: [40, 60] }] },
    ] }, signal)
    const charts = Object.keys(parts(bytes)).filter(name => /charts\/chart\d+\.xml$/u.test(name))
    expect(charts).toHaveLength(2)
    expect(strFromU8(parts(bytes)[charts[0]!]!)).toContain('一月')
    const check = await renderer.check(bytes, 'chart.docx', signal)
    expect(check).toMatchObject({ opened: true, pages: 1 })
  })
  it('refuses a chart series that does not fit its categories', () => {
    expect(() => validateDocument({ title: 't', blocks: [{ kind: 'chart', chart: 'line', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }] })).toThrow('one value per category')
  })
  it('reports a file that will not open instead of throwing', async () => {
    await expect(renderer.check(Uint8Array.from([1, 2, 3, 4]), 'broken.docx', signal)).resolves.toMatchObject({ opened: false })
  })
})
