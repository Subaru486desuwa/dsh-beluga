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
const edit = (bytes: Uint8Array, changes: Parameters<typeof editDocument>[1], track = false) => editDocument(bytes, changes, track, LIMIT, signal).bytes
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
  it('when the location holds no paragraph and no paragraph reads as expected', () => {
    expect(() => edit(wordDocument(p(r('a'))), [replace(9, 'b', 'x')])).toThrow('Nothing at /document[1]/body[1]/paragraph[9]; read the file again')
    expect(() => edit(wordDocument(p(r('a'))), [{ location: '/document[1]/body[1]', expected: '', action: 'delete' }])).toThrow('Nothing at /document[1]/body[1]; read the file again')
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

describe('a paragraph that an earlier change moved', () => {
  const source = () => wordDocument(p(r('一')) + p(r('二')) + p(r('三')))
  it('is found by its text when its location holds something else', () => {
    const first = edit(source(), [{ location: 'p1', expected: '一', action: 'insert_after', text: '新' }])
    const second = edit(first, [{ location: 'p2', expected: '二', action: 'replace', text: '贰' }, { location: 'p9', expected: '三', action: 'replace', text: '叁' }])
    expect(lines(second).map(line => line.text)).toEqual(['一', '新', '贰', '叁'])
  })
  it('is refused when several paragraphs read so, naming where they are', () => {
    expect(() => edit(wordDocument(p(r('同')) + p(r('同')) + p(r('异'))), [{ location: 'p3', expected: '同', action: 'replace', text: 'x' }])).toThrow('2 paragraphs read so, at p1, p2')
  })
  it('is refused when nothing reads so, and an empty paragraph is never found by its text', () => {
    expect(() => edit(source(), [{ location: 'p2', expected: '无', action: 'replace', text: 'x' }])).toThrow('p2 now reads "二"; read the file again')
    expect(() => edit(wordDocument(p(r('a')) + p() + p()), [{ location: 'p1', expected: '', action: 'replace', text: 'x' }])).toThrow('read the file again')
  })
  it('is named by how it begins when it is long, at its location or after it moved', () => {
    const long = '一、负责对象存储冷热分层项目，上线后存储成本每月下降约三十八万元。😀结尾'
    const source = wordDocument(p(r('短')) + p(r(long)))
    const start = long.slice(0, 20)
    const { bytes, changed } = editDocument(source, [{ location: 'p2', expected: start, action: 'replace', text: long + '补充' }], false, LIMIT, signal)
    expect(changed).toEqual([{ part: 'word/document.xml', location: 'p2', text: long + '补充', characters: [...long].length + 2 }])
    expect(lines(edit(bytes, [{ location: 'p9', expected: start, action: 'delete' }])).map(line => line.text)).toEqual(['短'])
    expect(() => edit(source, [{ location: 'p2', expected: long.slice(0, 19), action: 'delete' }])).toThrow('p2 now reads')
    expect(() => edit(source, [{ location: 'p2', expected: start + '错', action: 'delete' }])).toThrow('p2 now reads')
  })
  it('counts two changes that reach the same paragraph as one paragraph changed twice', () => {
    expect(() => edit(source(), [{ location: 'p2', expected: '二', action: 'replace', text: 'x' }, { location: 'p3', expected: '二', action: 'delete' }])).toThrow('Each paragraph takes one change')
  })
})
describe('reporting what it wrote', () => {
  it('gives each replaced or inserted paragraph where a read of the new file lists it', () => {
    const source = wordDocument(p(r('一')) + p(r('二')) + '<w:tbl><w:tr><w:tc>' + p(r('格')) + '</w:tc></w:tr></w:tbl>' + p(r('三')))
    const { bytes, changed } = editDocument(source, [
      { location: 'p1', expected: '一', action: 'delete' },
      { location: 'p2', expected: '二', action: 'insert_after', text: '新' },
      { location: 't1.r1.c1.p1', expected: '格', action: 'replace', text: '填' },
      { location: 'p3', expected: '三', action: 'replace', text: '叁' },
    ], false, LIMIT, signal)
    expect(changed).toEqual([
      { part: 'word/document.xml', location: 'p2', text: '新', characters: 1 },
      { part: 'word/document.xml', location: 't1.r1.c1.p1', text: '填', characters: 1 },
      { part: 'word/document.xml', location: 'p3', text: '叁', characters: 1 },
    ])
    const read = lines(bytes)
    for (const item of changed) expect(read.find(line => line.location === item.location)?.text).toBe(item.text)
  })
})
describe('giving a paragraph a look', () => {
  const looks = (bytes: Uint8Array) => extractOfficeText(bytes, 'a.docx', LIMIT, signal).text.split('\n').slice(4)
  it('sets it on every run, the paragraph mark and the alignment, so a read shows it', () => {
    const source = wordDocument(p(r('标题', bold), r('副题', italic)) + p(r('正文')))
    const { bytes, changed } = editDocument(source, [{ location: 'p1', expected: '标题副题', action: 'format', format: { font: '黑体', size: 16, bold: true, italic: false, color: '#c00000', align: 'center' } }], false, LIMIT, signal)
    expect(looks(bytes)).toEqual(['p1 {黑体 16pt bold #C00000 center} "标题副题"', 'p2 "正文"'])
    expect(changed).toEqual([{ part: 'word/document.xml', location: 'p1', text: '标题副题', characters: 4 }])
    expect(body(bytes)).toContain('<w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:b/><w:i w:val="0"/><w:color w:val="C00000"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr>')
  })
  it('comes with new text in the same change, and leaves properties it does not name', () => {
    const source = wordDocument(p(r('旧', '<w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hint="eastAsia"/><w:u w:val="single"/><w:sz w:val="21"/></w:rPr>')) + p())
    const bytes = edit(source, [{ ...replace(1, '旧', '新文字'), format: { font: '楷体', highlight: 'yellow' } }, { location: 'p2', expected: '', action: 'replace', text: '填写', format: { size: 12, underline: true } }])
    expect(looks(bytes)).toEqual(['p1 {楷体 10.5pt underline highlight yellow} "新文字"', 'p2 {12pt underline} "填写"'])
    expect(body(bytes)).not.toContain('asciiTheme')
    expect(body(bytes)).toContain('w:hint="eastAsia"')
  })
  it('keeps a font name with XML characters as text', () => {
    const bytes = edit(wordDocument(p(r('a'))), [{ location: 'p1', expected: 'a', action: 'format', format: { font: 'A&B "C"' } }])
    expect(body(bytes)).toContain('w:ascii="A&amp;B &quot;C&quot;"')
  })
  it('is refused as a tracked change', () => {
    expect(() => edit(wordDocument(p(r('a'))), [{ location: 'p1', expected: 'a', action: 'format', format: { bold: true } }], true)).toThrow('cannot be written as tracked changes')
  })
})
describe('adding and removing table rows', () => {
  const tc = (inner: string, properties = '') => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ''}${inner}</w:tc>`
  const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`
  const tbl = (...rows: string[]) => `<w:tbl><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows.join('')}</w:tbl>`
  const shade = '<w:shd w:val="clear" w:fill="D9E2F3"/>'
  const read = (bytes: Uint8Array) => extractOfficeText(bytes, 'a.docx', LIMIT, signal).text.split('\n').slice(4)
  it('adds a row built like the one it follows, with each cell looking like the cell above', () => {
    const source = wordDocument(tbl(tr(tc(p(r('奖项', bold)), shade), tc(p(r('时间', italic)) + p(r('第二段')))), tr(tc(p(r('甲')), shade), tc(p(r('2025'))))) + p(r('后')))
    const { bytes, changed } = editDocument(source, [{ location: 't1.r1.c1.p1', expected: '奖项', action: 'insert_row_after', cells: ['乙', '2026'] }], false, LIMIT, signal)
    expect(read(bytes)).toEqual([
      't1 table: 3 rows, 2 columns; column widths 1.8 3.5 cm; borders none; shaded #D9E2F3: r1.c1 r2.c1 r3.c1',
      't1.r1.c1.p1 {bold} "奖项"', 't1.r1.c2.p1 {italic} "时间"', 't1.r1.c2.p2 "第二段"',
      't1.r2.c1.p1 {bold} "乙"', 't1.r2.c2.p1 {italic} "2026"',
      't1.r3.c1.p1 "甲"', 't1.r3.c2.p1 "2025"', 'p1 "后"',
    ])
    expect(changed).toEqual([{ part: 'word/document.xml', location: 't1.r2.c1.p1', text: '乙', characters: 1 }, { part: 'word/document.xml', location: 't1.r2.c2.p1', text: '2026', characters: 4 }])
  })
  it('leaves cells without a text empty, gives every new cell a format, and refuses more texts than cells', () => {
    const source = wordDocument(tbl(tr(tc(p(r('甲'))), tc(p(r('乙'))))))
    const bytes = edit(source, [{ location: 't1.r1.c2.p1', expected: '乙', action: 'insert_row_after', cells: ['丙'], format: { color: '0000FF' } }])
    expect(read(bytes).slice(3)).toEqual(['t1.r2.c1.p1 {#0000FF} "丙"', 't1.r2.c2.p1 {#0000FF} ""'])
    expect(() => edit(source, [{ location: 't1.r1.c1.p1', expected: '甲', action: 'insert_row_after', cells: ['1', '2', '3'] }])).toThrow('This row has 2 cells, and 3 texts were given')
  })
  it('carries a cell merged down through a new row, and moves its start when its first row goes', () => {
    const merged = tbl(tr(tc(p(r('经历')), '<w:vMerge w:val="restart"/>'), tc(p(r('一')))), tr(tc(p(), '<w:vMerge/>'), tc(p(r('二')))), tr(tc(p(r('备注'))), tc(p(r('三')))))
    const grown = edit(wordDocument(merged), [{ location: 't1.r1.c2.p1', expected: '一', action: 'insert_row_after', cells: ['忽略', '新'] }])
    expect(read(grown)[0]).toContain('merged: r1.c1 down 3 rows (r2.c1, r3.c1 continue it and stay empty)')
    expect(read(grown)).toContain('t1.r2.c2.p1 "新"')
    expect(read(grown)).toContain('t1.r2.c1.p1 ""')
    const shrunk = edit(wordDocument(merged), [{ location: 't1.r1.c2.p1', expected: '一', action: 'delete_row' }])
    expect(read(shrunk)[0]).toBe('t1 table: 2 rows, 2 columns; column widths 1.8 3.5 cm; borders none')
    expect(body(shrunk)).toContain('<w:vMerge w:val="restart"/>')
    expect(read(shrunk).slice(1)).toEqual(['t1.r1.c1.p1 ""', 't1.r1.c2.p1 "二"', 't1.r2.c1.p1 "备注"', 't1.r2.c2.p1 "三"'])
  })
  it('refuses a paragraph outside a table, the only row of a table, a row with an image, and tracking', () => {
    const one = wordDocument(p(r('外')) + tbl(tr(tc(p(r('甲'))), tc(p(r('乙'))))))
    expect(() => edit(one, [{ location: 'p1', expected: '外', action: 'insert_row_after' }])).toThrow('needs the location of a paragraph inside the table row')
    expect(() => edit(one, [{ location: 't1.r1.c1.p1', expected: '甲', action: 'delete_row' }])).toThrow('only row of its table')
    const image = wordDocument(tbl(tr(tc(p('<w:r><w:drawing/></w:r>' + r('图'))), tc(p())), tr(tc(p(r('甲'))), tc(p()))))
    expect(() => edit(image, [{ location: 't1.r1.c1.p1', expected: '图', action: 'delete_row' }])).toThrow('image, field or other object')
    expect(() => edit(one, [{ location: 't1.r1.c1.p1', expected: '甲', action: 'insert_row_after' }], true)).toThrow('cannot be written as tracked changes')
  })
  it('works on the innermost row when tables nest', () => {
    const inner = tbl(tr(tc(p(r('内一'))), tc(p(r('内二')))))
    const bytes = edit(wordDocument(tbl(tr(tc(inner + p()), tc(p(r('外')))))), [{ location: 't1.r1.c1.t1.r1.c1.p1', expected: '内一', action: 'insert_row_after', cells: ['a', 'b'] }])
    expect(read(bytes)).toContain('t1.r1.c1.t1.r2.c2.p1 "b"')
    expect(read(bytes)[0]).toContain('t1 table: 1 rows')
  })
})
describe('writing a table cell whole', () => {
  const cell = (...paragraphs: string[]) => `<w:tc>${paragraphs.join('')}</w:tc>`
  const form = () => wordDocument(p(r('申报表')) + `<w:tbl><w:tr>${cell(p(r('主要事迹', bold)))}${cell('<w:p><w:pPr><w:jc w:val="both"/></w:pPr></w:p>')}</w:tr><w:tr>${cell(p(r('理由')))}${cell(p(r('旧一', italic)), p(r('旧二')), p(r('旧三')))}</w:tr></w:tbl>`)
  const run = (changes: Parameters<typeof editDocument>[1], track = false) => editDocument(form(), changes, track, LIMIT, signal)
  it('gives each line a paragraph that looks like the one before, and reports the cell with its length', () => {
    const { bytes, changed } = run([{ location: 't1.r1.c2', action: 'set_cell', text: '一、项目\n二、成果\n三、贡献' }])
    expect(lines(bytes).filter(line => line.location.startsWith('t1.r1.c2')).map(line => [line.location, line.text])).toEqual([['t1.r1.c2.p1', '一、项目'], ['t1.r1.c2.p2', '二、成果'], ['t1.r1.c2.p3', '三、贡献']])
    expect(body(bytes).match(/<w:jc w:val="both"\/>/gu)).toHaveLength(3)
    expect(changed).toEqual([{ part: 'word/document.xml', location: 't1.r1.c2', text: '一、项目\n二、成果\n三、贡献', characters: 12, paragraphs: 3 }])
  })
  it('takes the cell that holds a named paragraph, keeps the look of the text it replaces, and removes paragraphs left over', () => {
    const { bytes, changed } = run([{ location: 't1.r2.c2.p3', action: 'set_cell', text: '新一' }])
    expect(lines(bytes).filter(line => line.location.startsWith('t1.r2.c2')).map(line => line.text)).toEqual(['新一'])
    expect(body(bytes)).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">新</w:t>')
    expect(changed).toEqual([{ part: 'word/document.xml', location: 't1.r2.c2', text: '新一', characters: 2, paragraphs: 1 }])
  })
  it('checks expected when it is given, against the whole cell', () => {
    expect(lines(run([{ location: 't1.r2.c2', expected: '旧一\n旧二\n旧三', action: 'set_cell', text: '' }]).bytes).find(line => line.location === 't1.r2.c2.p1')?.text).toBe('')
    expect(() => run([{ location: 't1.r2.c2', expected: '别的', action: 'set_cell', text: 'x' }])).toThrow('t1.r2.c2 now reads "旧一\\n旧二\\n旧三"; leave expected out')
  })
  it('refuses a location that is no cell, and a cell changed twice in one call', () => {
    expect(() => run([{ location: 'p1', action: 'set_cell', text: 'x' }])).toThrow('p1 is not a table cell')
    expect(() => run([{ location: 't1.r9.c1', action: 'set_cell', text: 'x' }])).toThrow('is not a table cell')
    expect(() => run([{ location: 't1.r2.c2', action: 'set_cell', text: 'x' }, { location: 't1.r2.c2.p2', expected: '旧二', action: 'replace', text: 'y' }])).toThrow('Each paragraph takes one change')
  })
  it('writes tracked changes, and sets a look on the whole cell', () => {
    const tracked = body(run([{ location: 't1.r2.c2', action: 'set_cell', text: '旧一\n新二' }], true).bytes)
    expect(tracked).toContain('<w:del ')
    expect(tracked).toContain('<w:ins ')
    const looked = run([{ location: 't1.r1.c2', action: 'set_cell', text: '甲\n乙', format: { bold: true } }]).bytes
    expect(lines(looked).filter(line => line.location.startsWith('t1.r1.c2')).map(line => line.text)).toEqual(['甲', '乙'])
    expect(body(looked).match(/<w:b\/>/gu)!.length).toBeGreaterThanOrEqual(3)
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
