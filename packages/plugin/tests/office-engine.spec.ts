import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { extractOfficeText } from '../../office/src/office.ts'
import { renderDocument } from '../../office/src/documents.ts'
import { OfficePackage } from '../../office/src/package.ts'
import { columnName, columnNumber, readRange, translateFormula, position } from '../../office/src/workbook.ts'
import { workbook } from './office-fixtures.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const numberRows = (count: number) => Array.from({ length: count }, (_, row) => `<row r="${row + 1}"><c r="A${row + 1}"><v>${row + 1}</v></c><c r="B${row + 1}" t="inlineStr"><is><t>row ${row + 1}</t></is></c></row>`).join('')
const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'paragraph' as const, text: `第 ${index + 1} 段 ` + '内容'.repeat(60) }))

describe('cell references', () => {
  it('converts columns both ways', () => {
    expect(columnName(1)).toBe('A')
    expect(columnName(28)).toBe('AB')
    expect(columnNumber('AB')).toBe(28)
    expect(position('$C$7')).toEqual({ row: 7, column: 3 })
    expect(() => position('A0')).toThrow()
    expect(() => position('XFE1')).toThrow()
  })
  it('moves relative references and leaves the rest alone', () => {
    const from = { row: 2, column: 4 }
    const to = { row: 5, column: 4 }
    expect(translateFormula('C2-B2', from, to)).toBe('C5-B5')
    expect(translateFormula('$C$2+C$2+$C2', from, to)).toBe('$C$2+C$2+$C5')
    expect(translateFormula('LOG10(A2)+SUM(A1:A2)', from, to)).toBe('LOG10(A5)+SUM(A4:A5)')
    expect(translateFormula('"A2"&\'A2 sheet\'!A2', from, to)).toBe('"A2"&\'A2 sheet\'!A5')
    expect(translateFormula('1E5+A2', from, to)).toBe('1E5+A5')
    expect(translateFormula('A1', { row: 5, column: 1 }, { row: 1, column: 1 })).toBeUndefined()
    expect(translateFormula('SUM(A:A)', from, to)).toBeUndefined()
  })
})

describe('reading a workbook', () => {
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>'
  const sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c><c r="B1" t="inlineStr"><is><t>00123</t></is></c></row><row r="2"><c r="A2" s="1"><v>45992</v></c><c r="B2" s="2"><v>45992.5</v></c><c r="C2" t="b"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f>A3*2</f><v>4</v></c><c r="C3" t="e"><v>#REF!</v></c></row><row r="4"><c r="A4"><f t="shared" si="0" ref="A4:A5">A3+1</f><v>3</v></c></row><row r="5"><c r="A5"><f t="shared" si="0"/><v>4</v></c></row>'
  const book = () => OfficePackage.open(workbook({ 数据: sheet }, { 'xl/styles.xml': styles }), LIMIT, signal)
  it('keeps text as text, turns date cells into dates, and lists formulas apart', () => {
    const range = readRange(book(), {}, 24000)
    expect(range.sheet).toBe('数据')
    expect(range.range).toBe('A1:C5')
    expect(range.rows[0]).toEqual(['标题', '00123', null])
    expect(range.rows[1]).toEqual(['2025-12-01', '2025-12-01 12:00:00', true])
    expect(range.rows[2]).toEqual([2, 4, '#REF!'])
    expect(range.formulas).toEqual({ B3: 'A3*2', A4: 'A3+1', A5: 'A4+1' })
  })
  it('reads one rectangle and says where to continue when it runs out of room', () => {
    const office = OfficePackage.open(workbook({ Big: numberRows(3000) }), LIMIT, signal)
    const part = readRange(office, { range: 'A10:B12' }, 24000)
    expect(part.rows).toEqual([[10, 'row 10'], [11, 'row 11'], [12, 'row 12']])
    const first = readRange(office, {}, 2000)
    expect(first.nextRange).toMatch(/^A\d+:B3000$/u)
    expect(JSON.stringify(first.rows).length).toBeLessThan(2200)
    const next = readRange(office, { range: first.nextRange! }, 2000)
    expect(next.rows[0]![1]).toBe('row ' + (first.rows.length + 1))
  })
  it('names the sheets it has when asked for one it does not', () => {
    expect(() => readRange(book(), { sheet: '其他' }, 24000)).toThrow('数据')
  })
  it('gives an overview and the first rows instead of every cell', () => {
    const text = extractOfficeText(workbook({ Big: numberRows(3000) }), 'big.xlsx', LIMIT, signal).text
    expect(text).toContain('"range":"A1:B3000"')
    expect(text).toContain('row 20')
    expect(text).not.toContain('row 21"')
    expect(text).toContain('"nextRange":"A21:B3000"')
    expect(text.length).toBeLessThan(3000)
  })
})

describe('official engine', () => {
  const renderer = new OfficeRenderer()
  // Other spec files run the engine at the same time, so this one watches a directory of its own.
  let directory = ''
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'office-engine-')); process.env.TMPDIR = directory })
  afterAll(async () => { await renderer.dispose(); await rm(directory, { recursive: true, force: true }) })
  const leftovers = async () => (await readdir(directory)).filter(name => name.startsWith('beluga-office-'))

  it('shows every page of a short document, as images with a size', async () => {
    const { bytes } = await renderDocument({ title: '短文', blocks: paragraphs(3) }, signal)
    const preview = await renderer.preview(bytes, 'short.docx', undefined, LIMIT, signal)
    expect(preview.pageCount).toBe(1)
    expect(preview.pages).toHaveLength(1)
    expect(preview.pages[0]!.width).toBeGreaterThan(500)
    expect(Buffer.from(preview.pages[0]!.base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(await leftovers()).toEqual([])
  })
  it('keeps to the first pages of a long document and reports the total', async () => {
    const { bytes } = await renderDocument({ title: '长文', blocks: paragraphs(400) }, signal)
    const preview = await renderer.preview(bytes, 'long.docx', undefined, LIMIT, signal)
    expect(preview.pages).toHaveLength(20)
    expect(preview.pageCount).toBeGreaterThan(20)
  })
  it('shows the start of a worksheet and offers the other sheets', async () => {
    const bytes = workbook({ Big: numberRows(3000), Second: '<row r="1"><c r="A1"><v>1</v></c></row>' })
    const preview = await renderer.preview(bytes, 'big.xlsx', undefined, LIMIT, signal)
    expect(preview.sheets).toEqual(['Big', 'Second'])
    expect(preview.sheet).toBe('Big')
    expect(preview.range).toBe('A1:B60')
    expect(preview.clipped).toBe(true)
    const second = await renderer.preview(bytes, 'big.xlsx', 'Second', LIMIT, signal)
    expect(second.sheet).toBe('Second')
    expect(second.clipped).toBeUndefined()
  })
  it('exports a PDF', async () => {
    const { bytes } = await renderDocument({ title: 'PDF', blocks: paragraphs(2) }, signal)
    const pdf = await renderer.pdf(bytes, 'out.docx', signal)
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await leftovers()).toEqual([])
  })
  it('reports a damaged file without leaving it on disk', async () => {
    const bytes = workbook({ Sheet1: '' })
    const files = unzipSync(bytes)
    delete files['xl/workbook.xml']
    await expect(renderer.pdf(zipSync(files), 'broken.xlsx', signal)).rejects.toThrow('could not process')
    expect(await leftovers()).toEqual([])
  })
})
