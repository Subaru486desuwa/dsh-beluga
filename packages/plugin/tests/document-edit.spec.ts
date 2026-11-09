import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { editDocument, fillTemplate } from '../../office/src/document-edit.ts'
import { extractOfficeText } from '../../office/src/office.ts'
import { wordDocument, wordParagraphs, wordXml } from './office-fixtures.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const at = (index: number) => `/document[1]/body[1]/paragraph[${index}]`
const body = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml']!)
const replace = (index: number, expected: string, text: string) => ({ location: at(index), expected, action: 'replace' as const, text })
const edit = (bytes: Uint8Array, changes: Parameters<typeof editDocument>[1], track = false) => editDocument(bytes, changes, track, LIMIT, signal)
const lines = (bytes: Uint8Array) => wordParagraphs(extractOfficeText(bytes, 'a.docx', LIMIT, signal).text)
const bold = '<w:rPr><w:b/></w:rPr>'
const italic = '<w:rPr><w:i/></w:rPr>'
const p = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`
const r = (text: string, properties = '') => `<w:r>${properties}<w:t xml:space="preserve">${text}</w:t></w:r>`

describe('replacing text', () => {
  it('keeps the formatting of the runs around the change', () => {
    const edited = body(edit(wordDocument(p(r('总额：', bold), r('1000 元', italic))), [replace(1, '总额：1000 元', '总额：2000 元')]))
    expect(edited).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">总额：</w:t></w:r>')
    expect(edited).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">2</w:t>')
    expect(edited).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">000 元</w:t>')
    expect(edited).not.toContain('1000')
  })
  it('crosses runs, and leaves other paragraphs and parts exactly as they were', () => {
    const source = wordDocument(p(r('abc', bold), r('def', italic)) + p(r('other')), { 'word/footer1.xml': wordXml(p(r('页脚'))), 'word/media/a.bin': 'binary' })
    const edited = edit(source, [replace(1, 'abcdef', 'aXf')])
    expect(lines(edited).map(line => line.text)).toEqual(['aXf', 'other', '页脚'])
    const before = unzipSync(source)
    const after = unzipSync(edited)
    for (const name of Object.keys(before)) if (name !== 'word/document.xml') expect(Buffer.compare(before[name]!, after[name]!), name).toBe(0)
  })
  it('keeps XML characters as text in both directions', () => {
    const edited = edit(wordDocument(p(r('a &amp; b &lt; c'))), [replace(1, 'a & b < c', 'a & b > c & "d"')])
    expect(lines(edited)[0]!.text).toBe('a & b > c & "d"')
    expect(body(edited)).toContain('&amp;')
  })
  it('writes tabs and line breaks as Word elements', () => {
    const edited = body(edit(wordDocument(p(r('a'))), [replace(1, 'a', 'a\tb\nc')]))
    expect(edited).toContain('<w:tab/>')
    expect(edited).toContain('<w:br/>')
  })
  it('fills an empty paragraph with the paragraph mark formatting', () => {
    const source = wordDocument('<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p>')
    expect(body(edit(source, [replace(1, '', '新内容')]))).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">新内容</w:t></w:r>')
  })
  it('reaches into hyperlinks and table cells, and does not split a surrogate pair', () => {
    const link = p('<w:hyperlink r:id="rId1">', r('链接'), '</w:hyperlink>').replace('<w:hyperlink ', '<w:hyperlink xmlns:r="urn:r" ')
    const cell = `<w:tbl><w:tr><w:tc>${p(r('😀a'))}</w:tc></w:tr></w:tbl>`
    const edited = edit(wordDocument(link + cell), [replace(1, '链接', '新链接'), { location: '/document[1]/body[1]/table[1]/row[1]/cell[1]/paragraph[1]', expected: '😀a', action: 'replace', text: '😁a' }])
    expect(lines(edited).map(line => line.text)).toEqual(['新链接', '😁a'])
    expect(body(edited)).toContain('</w:hyperlink>')
  })
  it('takes the short locations reading writes, in the body, a table cell and a footer', () => {
    const source = wordDocument(p(r('标题')) + `<w:tbl><w:tr><w:tc>${p(r('名称'))}</w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>`, { 'word/footer1.xml': wordXml(p(r('第 1 版'))) })
    const read = lines(source)
    expect(read.map(({ part, location, text }) => [part, location, text])).toEqual([['word/document.xml', 'p1', '标题'], ['word/document.xml', 't1.r1.c1.p1', '名称'], ['word/document.xml', 't1.r1.c2.p1', ''], ['word/footer1.xml', 'p1', '第 1 版']])
    const edited = edit(source, read.map(({ part, location, text }) => ({ part, location, expected: text, action: 'replace' as const, text: text ? text + '！' : '甲项目' })))
    expect(lines(edited).map(line => line.text)).toEqual(['标题！', '名称！', '甲项目', '第 1 版！'])
  })
  it('refuses a malformed short location', () => {
    expect(() => edit(wordDocument(p(r('a'))), [{ location: 't1..p1', expected: 'a', action: 'delete' }])).toThrow('Unknown location')
    expect(() => edit(wordDocument(p(r('a'))), [{ location: 'p0', expected: 'a', action: 'delete' }])).toThrow('Unknown location')
  })
  it('edits headers and footers by part', () => {
    const source = wordDocument(p(r('正文')), { 'word/footer1.xml': wordXml(p(r('第 1 版'))) })
    const edited = edit(source, [{ part: 'word/footer1.xml', location: '/ftr[1]/paragraph[1]', expected: '第 1 版', action: 'replace', text: '第 2 版' }])
    expect(strFromU8(unzipSync(edited)['word/footer1.xml']!)).toContain('2')
    expect(body(edited)).toBe(body(source))
  })
  it('leaves an unchanged paragraph byte for byte', () => {
    const source = wordDocument(p(r('same')))
    expect(body(edit(source, [replace(1, 'same', 'same')]))).toBe(body(source))
  })
})

describe('reading what editing sees', () => {
  it('leaves out tab stops, removed text and moved-away text', () => {
    const source = wordDocument('<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' + r('a') + '<w:del w:id="1" w:author="x"><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins w:id="2" w:author="x">' + r('b') + '</w:ins></w:p>')
    expect(lines(source)[0]!.text).toBe('ab')
    expect(lines(edit(source, [replace(1, 'ab', 'aX')]))[0]!.text).toBe('aX')
  })
})

describe('refusing a change', () => {
  const picture = '<w:r><w:drawing><wp/></w:drawing></w:r>'
  it('when the paragraph no longer reads as expected', () => {
    expect(() => edit(wordDocument(p(r('now'))), [replace(1, 'before', 'x')])).toThrow('now reads "now"')
  })
  it('when the location does not exist or is not a paragraph', () => {
    expect(() => edit(wordDocument(p(r('a'))), [replace(9, 'a', 'x')])).toThrow('read the file again')
    expect(() => edit(wordDocument(p(r('a'))), [{ location: '/document[1]/body[1]', expected: '', action: 'delete' }])).toThrow('Not a paragraph')
    expect(() => edit(wordDocument(p(r('a'))), [{ ...replace(1, 'a', 'x'), part: 'word/settings.xml' }])).toThrow('Not an editable part')
  })
  it('when one paragraph takes two changes', () => {
    expect(() => edit(wordDocument(p(r('a'))), [replace(1, 'a', 'b'), replace(1, 'a', 'c')])).toThrow('one change')
  })
  it('when the change would remove an image or field', () => {
    const source = wordDocument(p('<w:r><w:t>a</w:t><w:drawing><wp/></w:drawing><w:t>b</w:t></w:r>'))
    expect(() => edit(source, [replace(1, 'ab', 'x')])).toThrow('image, field')
    expect(() => edit(wordDocument(p(r('a'), '<w:r><w:fldChar w:fldCharType="begin"/></w:r>') + p(r('b'))), [{ location: at(1), expected: 'a', action: 'delete' }])).toThrow('image, field')
  })
  it('but changes the text beside an image', () => {
    const edited = body(edit(wordDocument(p(r('左'), picture, r('右'))), [replace(1, '左右', '左边')]))
    expect(edited).toContain('<w:drawing>')
  })
  it('when a tracked edit would land on another tracked change', () => {
    const source = wordDocument(p(`<w:ins w:id="1" w:author="x">${r('text')}</w:ins>`))
    expect(() => edit(source, [replace(1, 'text', 'next')], true)).toThrow('unresolved')
    expect(lines(edit(source, [replace(1, 'text', 'next')]))[0]!.text).toBe('next')
  })
})

describe('adding and removing paragraphs', () => {
  it('adds a paragraph with its neighbour\'s look, keeping section settings on the original', () => {
    const source = wordDocument(`<w:p><w:pPr><w:pStyle w:val="Body"/><w:sectPr/></w:pPr>${r('a', bold)}</w:p>`)
    const edited = body(edit(source, [{ location: at(1), expected: 'a', action: 'insert_after', text: 'b' }]))
    expect(edited.match(/<w:sectPr\/>/gu)).toHaveLength(2)
    expect(edited).toContain('<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">b</w:t></w:r></w:p>')
  })
  it('resolves every location against the file as read', () => {
    const source = wordDocument(p(r('one')) + p(r('two')) + p(r('three')))
    const edited = edit(source, [{ location: at(1), expected: 'one', action: 'delete' }, { location: at(2), expected: 'two', action: 'insert_after', text: 'two and a half' }, replace(3, 'three', 'four')])
    expect(lines(edited).map(line => line.text)).toEqual(['two', 'two and a half', 'four'])
  })
  it('keeps what a document must have', () => {
    expect(() => edit(wordDocument(p(r('only'))), [{ location: at(1), expected: 'only', action: 'delete' }])).toThrow('last paragraph')
    const cell = `<w:tbl><w:tr><w:tc><w:tcPr/>${p(r('a'))}</w:tc></w:tr></w:tbl>` + p(r('x'))
    expect(() => edit(wordDocument(cell), [{ location: '/document[1]/body[1]/table[1]/row[1]/cell[1]/paragraph[1]', expected: 'a', action: 'delete' }])).toThrow('last paragraph')
    expect(() => edit(wordDocument(`<w:p><w:pPr><w:sectPr/></w:pPr>${r('a')}</w:p>` + p(r('b'))), [{ location: at(1), expected: 'a', action: 'delete' }])).toThrow('section')
  })
  it('refuses to break a bookmark or comment that spans paragraphs, and removes one that does not', () => {
    const open = p('<w:bookmarkStart w:id="1" w:name="x"/>', r('a')) + p('<w:bookmarkEnd w:id="1"/>', r('b')) + p(r('c'))
    expect(() => edit(wordDocument(open), [{ location: at(1), expected: 'a', action: 'delete' }])).toThrow('bookmark')
    const closed = p('<w:bookmarkStart w:id="1" w:name="x"/>', r('a'), '<w:bookmarkEnd w:id="1"/>') + p(r('b'))
    expect(lines(edit(wordDocument(closed), [{ location: at(1), expected: 'a', action: 'delete' }])).map(line => line.text)).toEqual(['b'])
  })
})

describe('tracked changes', () => {
  it('marks only what changed, for Word to accept or reject', () => {
    const edited = body(edit(wordDocument(p(r('总额：', bold), r('1000 元', italic))), [replace(1, '总额：1000 元', '总额：2000 元')], true))
    expect(edited).toMatch(/<w:del w:id="\d+" w:author="Beluga" w:date="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"><w:r><w:rPr><w:i\/><\/w:rPr><w:delText xml:space="preserve">1<\/w:delText><\/w:r><\/w:del>/u)
    expect(edited).toMatch(/<w:ins w:id="\d+" w:author="Beluga"[^>]*><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">2<\/w:t><\/w:r><\/w:ins>/u)
    expect(edited).toContain('<w:t xml:space="preserve">总额：</w:t>')
  })
  it('reads as the new text once tracked', () => {
    const edited = edit(wordDocument(p(r('old text'))), [replace(1, 'old text', 'new text')], true)
    expect(lines(edited)[0]!.text).toBe('new text')
  })
  it('takes ids no annotation in the part uses', () => {
    const edited = body(edit(wordDocument(p('<w:bookmarkStart w:id="40" w:name="x"/>', r('a'), '<w:bookmarkEnd w:id="40"/>')), [replace(1, 'a', 'b')], true))
    expect(Array.from(edited.matchAll(/w:id="(\d+)"/gu), match => Number(match[1])).sort()).toEqual([40, 40, 41, 42])
  })
  it('marks a whole paragraph as inserted', () => {
    const edited = body(edit(wordDocument(p(r('a'))), [{ location: at(1), expected: 'a', action: 'insert_after', text: 'b' }], true))
    expect(edited).toMatch(/<w:p><w:pPr><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">b<\/w:t><\/w:r><\/w:ins><\/w:p>/u)
  })
  it('marks a whole paragraph as removed, keeping it in the file', () => {
    const edited = edit(wordDocument(p(r('a')) + p(r('b'))), [{ location: at(1), expected: 'a', action: 'delete' }], true)
    expect(body(edited)).toMatch(/<w:p><w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText xml:space="preserve">a<\/w:delText><\/w:r><\/w:del><\/w:p>/u)
    expect(lines(edited).map(line => line.text)).toEqual(['', 'b'])
  })
})

describe('filling a template', () => {
  const template = wordDocument(p(r('客户：', bold), r('{{客', bold), r('户}}', bold)) + p(r('金额 {{金额}} 元，备注 {{备注}}')))
  it('fills placeholders split across runs, keeping their formatting, and lists the rest', async () => {
    const { bytes, unfilled } = await fillTemplate(template, { 客户: '甲 & 乙', 金额: '100' }, LIMIT, signal)
    expect(unfilled).toEqual(['备注'])
    expect(lines(bytes).map(line => line.text)).toEqual(['客户：甲 & 乙', '金额 100 元，备注 {{备注}}'])
    expect(body(bytes)).toMatch(/<w:b\/><\/w:rPr><w:t[^>]*>甲 &amp; 乙/u)
  })
  it('refuses a value that looks like a placeholder', async () => {
    await expect(fillTemplate(template, { 客户: '{{金额}}', 金额: '100' }, LIMIT, signal)).rejects.toThrow('cannot contain')
  })
  it('names the placeholders it has when given another', async () => {
    await expect(fillTemplate(template, { 公司: 'x' }, LIMIT, signal)).rejects.toThrow('客户')
    await expect(fillTemplate(wordDocument(p(r('plain'))), { 公司: 'x' }, LIMIT, signal)).rejects.toThrow('no {{name}}')
  })
})
