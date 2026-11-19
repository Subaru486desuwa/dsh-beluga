import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { OfficePackage } from '../../office/src/package.ts'
import { readRange } from '../../office/src/workbook.ts'
import { editWorkbook } from '../../office/src/workbook-edit.ts'
import type { WorkbookChanges } from '../src/host/workbooks.ts'
import { workbook } from './office-fixtures.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const read = (bytes: Uint8Array, range?: string, sheet?: string) => readRange(OfficePackage.open(bytes, LIMIT, signal), { ...(range ? { range } : {}), ...(sheet ? { sheet } : {}) }, 100000)
const text = (bytes: Uint8Array, part: string) => strFromU8(unzipSync(bytes)[part]!)
const edit = (bytes: Uint8Array, changes: Partial<WorkbookChanges>) => editWorkbook(bytes, { changes: [], ...changes }, LIMIT, signal)
const styles = { 'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="等线"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` }
const c = (ref: string, value?: number | string, style?: number) => `<c r="${ref}"${style ? ` s="${style}"` : ''}>${value === undefined ? '' : typeof value === 'number' ? `<v>${value}</v>` : `<f>${value}</f>`}</c>`
const row = (number: number, ...cells: string[]) => `<row r="${number}">${cells.join('')}</row>`
const sheetPart = (data: string, before = '', after = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>${before}<sheetData>${data}</sheetData>${after}</worksheet>`
const relationships = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`
const data = row(1, c('A1', 1), c('B1', 2, 1)) + row(2, c('A2', 3), c('B2', 'A2*2', 1)) + row(3, c('A3', 4), c('B3', 'A3*2', 1))
const plain = () => workbook({ 数据: data }, styles)

describe('giving cells a look', () => {
  it('lays the look over the one each cell has', () => {
    const { bytes, touched } = edit(plain(), { formats: [{ sheet: '数据', range: 'A1:B1', format: { bold: true, fill: '#D9E1F2', color: '#C00000', font: '黑体', size: 14, align: 'center', valign: 'middle', wrap: true, border: 'all' } }] })
    expect(read(bytes).looks).toEqual([
      'A1 黑体 14pt bold #C00000 fill #D9E1F2 border center vertical center wrap',
      'B1 黑体 14pt bold #C00000 fill #D9E1F2 border center vertical center wrap format #,##0.00',
      'B2:B3 format #,##0.00',
    ])
    expect(touched).toEqual([{ sheet: '数据', range: 'A1:B1' }])
    expect(read(bytes).rows).toEqual(read(plain()).rows)
  })
  it('adds one style for cells that started alike, and reuses a style that already says the same', () => {
    const once = edit(plain(), { formats: [{ sheet: '数据', range: 'A1:A3', format: { numberFormat: '#,##0.00' } }] }).bytes
    expect(text(once, 'xl/styles.xml')).toContain('<cellXfs count="2">')
    expect(read(once).looks).toEqual(['A1:B3 format #,##0.00'])
    const twice = edit(plain(), { formats: [{ sheet: '数据', range: 'A1:A3', format: { italic: true } }, { sheet: '数据', range: 'B5:C6', format: { italic: true } }] }).bytes
    expect(text(twice, 'xl/styles.xml')).toContain('<cellXfs count="3">')
    expect(read(twice, 'A1:C6').looks).toEqual(['A1:A3 italic', 'B1:B3 format #,##0.00', 'B5:C6 italic'])
  })
  it('writes a number format Excel does not have built in, and takes a look off again', () => {
    const { bytes } = edit(plain(), { formats: [{ sheet: '数据', range: 'A2', format: { numberFormat: '0.0"万元"', bold: true } }] })
    expect(text(bytes, 'xl/styles.xml')).toContain('<numFmt numFmtId="164" formatCode="0.0&quot;万元&quot;"/>')
    expect(read(bytes).looks).toContain('A2 bold format 0.0"万元"')
    const back = edit(bytes, { formats: [{ sheet: '数据', range: 'A2', format: { bold: false, numberFormat: 'General' } }] }).bytes
    expect(read(back).looks).toEqual(['B1:B3 format #,##0.00'])
  })
  it('refuses a workbook without styles and a range that is a whole column', () => {
    expect(() => edit(workbook({ 数据: data }), { formats: [{ sheet: '数据', range: 'A1', format: { bold: true } }] })).toThrow('no styles part')
    expect(() => edit(plain(), { formats: [{ sheet: '数据', range: 'A1:A1048576', format: { bold: true } }] })).toThrow('at most 50000 cells')
  })
})

describe('sizing columns and rows', () => {
  const sized = () => workbook({ 数据: '' }, { ...styles, 'xl/worksheets/sheet1.xml': sheetPart(data, '<cols><col min="2" max="4" width="20" customWidth="1"/></cols>') })
  it('splits a stored span so the other columns keep their width', () => {
    const { bytes } = edit(sized(), { columnWidths: [{ sheet: '数据', columns: 'C', width: 12 }, { sheet: '数据', columns: 'F:G', width: 30 }] })
    expect(read(bytes, 'A1:H3').columnWidths).toEqual({ B: 20, C: 12, D: 20, 'F:G': 30 })
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toContain('<cols><col min="2" max="2" width="20" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/><col min="4" max="4" width="20" customWidth="1"/><col min="6" max="7" width="30" customWidth="1"/></cols><sheetData>')
  })
  it('adds the list of columns in front of the cells when the sheet has none', () => {
    const { bytes } = edit(plain(), { columnWidths: [{ sheet: '数据', columns: 'A:B', width: 18.5 }] })
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toContain('<cols><col min="1" max="2" width="18.5" customWidth="1"/></cols><sheetData>')
  })
  it('sets row heights, on rows that hold nothing too', () => {
    const { bytes } = edit(plain(), { rowHeights: [{ sheet: '数据', rows: '1', height: 30 }, { sheet: '数据', rows: '5:6', height: 22.5 }] })
    expect(read(bytes, 'A1:B6').rowHeights).toEqual({ 1: 30, 5: 22.5, 6: 22.5 })
  })
})

describe('merging cells', () => {
  it('merges a range and splits it again', () => {
    const { bytes, touched } = edit(plain(), { merges: [{ sheet: '数据', range: 'A5:C5', merge: true }] })
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toContain('</sheetData><mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>')
    expect(read(bytes, 'A1:C5').merged).toEqual(['A5:C5'])
    expect(touched).toEqual([{ sheet: '数据', range: 'A5:C5' }])
    const split = edit(bytes, { merges: [{ sheet: '数据', range: 'A5:C5', merge: false }] }).bytes
    expect(text(split, 'xl/worksheets/sheet1.xml')).not.toContain('mergeCell')
  })
  it('refuses what would hide a value or cross another merged range', () => {
    expect(() => edit(plain(), { merges: [{ sheet: '数据', range: 'A1:B1', merge: true }] })).toThrow('B1 holds a value')
    expect(() => edit(plain(), { merges: [{ sheet: '数据', range: 'D1', merge: true }] })).toThrow('one cell')
    expect(() => edit(plain(), { merges: [{ sheet: '数据', range: 'D1:E1', merge: false }] })).toThrow('not a merged range')
    const merged = edit(plain(), { merges: [{ sheet: '数据', range: 'D1:E2', merge: true }] }).bytes
    expect(() => edit(merged, { merges: [{ sheet: '数据', range: 'E2:F3', merge: true }] })).toThrow('overlaps merged range D1:E2')
  })
})

describe('adding rows below the data', () => {
  it('gives each new cell the style above it, and the formula above it where no value is given', () => {
    const { bytes, touched } = edit(plain(), { append: [{ sheet: '数据', rows: [[5, null], [6, 99]] }] })
    const range = read(bytes)
    expect(range.rows.slice(3)).toEqual([[5, null], [6, 99]])
    expect(range.formulas).toEqual({ B2: 'A2*2', B3: 'A3*2', B4: 'A4*2' })
    expect(range.looks).toEqual(['B1:B5 format #,##0.00'])
    expect(touched).toEqual([{ sheet: '数据', range: 'A4:B5' }])
  })
  it('grows a filter and a table that ended on the last row', () => {
    const table = (extra = '') => `<?xml version="1.0"?><table ${NS} id="1" name="T" displayName="T" ref="A1:B3"${extra}><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="a"/><tableColumn id="2" name="b"/></tableColumns></table>`
    const parts = (extra = '') => ({ ...styles, 'xl/worksheets/sheet1.xml': sheetPart(data, '', '<autoFilter ref="A1:B3"/>'), 'xl/worksheets/_rels/sheet1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>`), 'xl/tables/table1.xml': table(extra) })
    const { bytes } = edit(workbook({ 数据: '' }, parts()), { append: [{ sheet: '数据', rows: [[7]] }] })
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toContain('<autoFilter ref="A1:B4"/>')
    expect(text(bytes, 'xl/tables/table1.xml')).toContain('ref="A1:B4"><autoFilter ref="A1:B4"/>')
    expect(() => edit(workbook({ 数据: '' }, parts(' totalsRowCount="1"')), { append: [{ sheet: '数据', rows: [[7]] }] })).toThrow('totals row')
  })
})

describe('adding sheets', () => {
  it('adds an empty sheet the same call can fill', () => {
    const { bytes, touched } = edit(plain(), { sheets: [{ name: '汇总' }], changes: [{ sheet: '汇总', cell: 'A1', value: { formula: "SUM('数据'!A1:A3)" } }, { sheet: '汇总', cell: 'B2', value: '合计' }] })
    expect(read(bytes, undefined, '汇总').formulas).toEqual({ A1: "SUM('数据'!A1:A3)" })
    expect(read(bytes, undefined, '汇总').rows[1]).toEqual([null, '合计'])
    expect(read(bytes).rows).toEqual(read(plain()).rows)
    expect(text(bytes, '[Content_Types].xml')).toContain('<Override PartName="/xl/worksheets/sheet2.xml"')
    expect(touched).toEqual([{ sheet: '汇总', range: 'A1:B2' }])
  })
  it('refuses a name the workbook already has', () => {
    expect(() => edit(plain(), { sheets: [{ name: '数据' }] })).toThrow('already has a sheet named "数据"')
  })
})
