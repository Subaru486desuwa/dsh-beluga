import { describe, expect, it } from 'vitest'
import { extractOfficeText } from '../../office/src/office.ts'
import { wordDocument, wordParagraphs } from './office-fixtures.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
/** The lines of a read after its notice and legend. */
const read = (bytes: Uint8Array) => extractOfficeText(bytes, 'a.docx', LIMIT, signal).text.split('\n').slice(2)
const p = (inner: string, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${inner}</w:p>`
const r = (text: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const styles = (inner: string) => ({ 'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:styles>` })
const song = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>'

describe('the look of text in a read', () => {
  it('states the default once and marks only paragraphs that differ from it', () => {
    const lines = read(wordDocument(p(r('正文')) + p(r('标题', '<w:rFonts w:eastAsia="黑体" w:ascii="Arial"/><w:b/><w:sz w:val="36"/><w:color w:val="c00000"/>'), '<w:jc w:val="center"/>'), styles(song)))
    expect(lines).toEqual(['default look {宋体/Times New Roman 12pt left}', 'part word/document.xml', 'p1 "正文"', 'p2 {黑体/Arial 18pt bold #C00000 center} "标题"'])
  })
  it('follows the paragraph style and what it is based on, then the character style, then the run', () => {
    const sheet = styles(song
      + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:pPr><w:jc w:val="both"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="base"><w:basedOn w:val="a"/><w:rPr><w:i/><w:sz w:val="28"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="h1"><w:basedOn w:val="base"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'
      + '<w:style w:type="character" w:styleId="em"><w:rPr><w:u w:val="single"/><w:i w:val="0"/></w:rPr></w:style>')
    const lines = read(wordDocument(p(r('一'), '<w:pStyle w:val="h1"/>') + p(r('二', '<w:rStyle w:val="em"/><w:sz w:val="20"/>'), '<w:pStyle w:val="h1"/>') + p(r('三'), '<w:jc w:val="left"/>'), sheet))
    expect(lines.slice(0, 1)).toEqual(['default look {宋体/Times New Roman 12pt justify}'])
    expect(lines.slice(2)).toEqual(['p1 [h1] {14pt bold italic center} "一"', 'p2 [h1] {10pt bold underline center} "二"', 'p3 {left} "三"'])
  })
  it('lists the stretches of a paragraph that look different, joining neighbours that look alike', () => {
    const lines = read(wordDocument(p(r('总额：', '<w:b/>') + r('1000', '<w:b/>') + r(' 元') + r('（含税）', '<w:highlight w:val="yellow"/><w:strike/>'))))
    expect(lines.slice(2)).toEqual(['p1 {mixed} "总额：1000 元（含税）"', '  {bold} "总额：1000"', '  {} " 元"', '  {strike highlight yellow} "（含税）"'])
    expect(wordParagraphs(['', '', ...lines].join('\n')).map(line => line.text)).toEqual(['总额：1000 元（含税）'])
  })
  it('gives an empty paragraph the look new text takes there', () => {
    const lines = read(wordDocument(p('', '<w:rPr><w:rFonts w:eastAsia="楷体"/><w:sz w:val="21"/></w:rPr>') + p('<w:r><w:rPr><w:b/></w:rPr></w:r>')))
    expect(lines.slice(2)).toEqual(['p1 {楷体 10.5pt} ""', 'p2 ""'])
  })
  it('reads theme fonts, taking the East Asian one from the simplified Chinese script', () => {
    const theme = { 'word/theme/theme1.xml': '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="x"><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>' }
    const lines = read(wordDocument(p(r('a')) + p(r('b', '<w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia"/>')), { ...styles('<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>'), ...theme }))
    expect(lines).toEqual(['default look {等线/Calibri 10.5pt left}', 'part word/document.xml', 'p1 "a"', 'p2 {等线 Light/Cambria} "b"'])
  })
  it('reads a file with no styles part', () => {
    expect(read(wordDocument(p(r('a', '<w:i/>'))))).toEqual(['default look {left}', 'part word/document.xml', 'p1 {italic} "a"'])
  })
})

describe('the build of a table in a read', () => {
  const cell = (inner: string, properties = '') => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ''}${inner || p('')}</w:tc>`
  const row = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`
  const table = (properties: string, grid: number[], ...rows: string[]) => `<w:tbl><w:tblPr>${properties}</w:tblPr><w:tblGrid>${grid.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  const borders = (...sides: string[]) => `<w:tblBorders>${sides.map(side => `<w:${side} w:val="single" w:sz="4"/>`).join('')}</w:tblBorders>`
  it('comes before the table\'s paragraphs with its grid, borders, merged cells and shaded cells', () => {
    const lines = read(wordDocument(table(borders('top', 'left', 'bottom', 'right', 'insideH', 'insideV'), [1134, 2268, 1134],
      row(cell(p(r('项目')), '<w:shd w:val="clear" w:fill="d9e2f3"/>'), cell('', '<w:gridSpan w:val="2"/>')),
      row(cell(p(r('经历')), '<w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="D9E2F3"/>'), cell(''), cell('')),
      row(cell('', '<w:vMerge/>'), cell(''), cell('')),
      row(cell('', '<w:vMerge/>'), cell(''), cell('', '<w:shd w:val="clear" w:fill="FFFFFF"/>')),
      row(cell(p(r('备注'))), cell(''), cell('')))))
    expect(lines[2]).toBe('t1 table: 5 rows, 3 columns; column widths 2 4 2 cm; borders all; merged: r1.c2 across 2 columns, r2.c1 down 3 rows (r3.c1, r4.c1 continue it and stay empty); shaded #D9E2F3: r1.c1 r2.c1')
    expect(lines[3]).toBe('t1.r1.c1.p1 "项目"')
  })
  it('says which borders are drawn, or that a table style decides', () => {
    const one = (properties: string) => read(wordDocument(table(properties, [1000], row(cell('')))))[2]
    expect(one(borders('top', 'bottom'))).toContain('borders outer only')
    expect(one(borders('insideH'))).toContain('borders inner only')
    expect(one('<w:tblBorders><w:top w:val="nil"/></w:tblBorders>')).toContain('borders none')
    expect(one('<w:tblStyle w:val="TableGrid"/>')).toContain('borders from table style TableGrid')
    expect(one('')).toBe('t1 table: 1 rows, 1 columns; column widths 1.8 cm; borders none')
  })
  it('describes a table inside a cell at its own location, and caps a long list of shaded cells', () => {
    const inner = table('', [500], row(cell(p(r('内')))))
    const shaded = Array.from({ length: 30 }, () => row(cell('', '<w:shd w:val="clear" w:fill="EEEEEE"/>')))
    const lines = read(wordDocument(table('', [1000], row(cell(inner + p(''))), ...shaded)))
    expect(lines[3]).toBe('t1.r1.c1.t1 table: 1 rows, 1 columns; column widths 0.9 cm; borders none')
    expect(lines[2]).toMatch(/shaded #EEEEEE: r2\.c1 .* r25\.c1 and 6 more$/u)
  })
})
