import { afterAll, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { OfficePackage } from '../../office/src/package.ts'
import { readRange } from '../../office/src/workbook.ts'
import { restructure, restructureVerified, rewriteFormula, type Shift } from '../../office/src/workbook-structure.ts'
import type { StructureChange } from '../src/host/workbooks.ts'
import { workbook } from './office-fixtures.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const read = (bytes: Uint8Array, range?: string, sheet?: string) => readRange(OfficePackage.open(bytes, LIMIT, signal), { ...(range ? { range } : {}), ...(sheet ? { sheet } : {}) }, 100000)
const text = (bytes: Uint8Array, part: string) => strFromU8(unzipSync(bytes)[part]!)
const c = (ref: string, value?: number | string, style?: number) => `<c r="${ref}"${style ? ` s="${style}"` : ''}>${value === undefined ? '' : typeof value === 'number' ? `<v>${value}</v>` : `<f>${value}</f>`}</c>`
const row = (number: number, ...cells: string[]) => `<row r="${number}">${cells.join('')}</row>`
const sheetPart = (data: string, before = '', after = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>${before}<sheetData>${data}</sheetData>${after}</worksheet>`
const relationships = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`
const styles = { 'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="等线"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` }
const insertRows = (before: number, count = 1, sheet = '数据'): StructureChange => ({ sheet, action: 'insert_rows', before, count })
const deleteRows = (first: number, count = 1, sheet = '数据'): StructureChange => ({ sheet, action: 'delete_rows', first, count })
const insertColumns = (before: string, count = 1, sheet = '数据'): StructureChange => ({ sheet, action: 'insert_columns', before, count })
const deleteColumns = (first: string, count = 1, sheet = '数据'): StructureChange => ({ sheet, action: 'delete_columns', first, count })
const change = (bytes: Uint8Array, structure: StructureChange, fill = true) => restructure(bytes, structure, LIMIT, signal, fill)

describe('references in a formula', () => {
  const shift = (axis: Shift['axis'], at: number, count: number, insert: boolean): Shift => ({ sheet: '数据', axis, at, count, insert })
  const rewrite = (formula: string, to: Shift, home: string | undefined = '数据') => rewriteFormula(formula, home, to).formula
  it('follow cells that an insertion moves, and ranges grow around it', () => {
    const rows = shift('row', 3, 2, true)
    expect(rewrite('A2+A3+$A$5', rows)).toBe('A2+A5+$A$7')
    expect(rewrite('SUM(A1:A9)+SUM(B3:B4)+SUM(C1:C2)', rows)).toBe('SUM(A1:A11)+SUM(B5:B6)+SUM(C1:C2)')
    expect(rewrite('SUM(A:A)+SUM(2:4)', rows)).toBe('SUM(A:A)+SUM(2:6)')
    const columns = shift('column', 2, 1, true)
    expect(rewrite('A1+B1+$C$1+SUM(A1:C1)+SUM(B:B)+SUM(1:1)', columns)).toBe('A1+C1+$D$1+SUM(A1:D1)+SUM(C:C)+SUM(1:1)')
  })
  it('close over a deletion, and say #REF! where every cell is gone', () => {
    const rows = shift('row', 3, 2, false)
    expect(rewriteFormula('A2+A5+SUM(A1:A9)+SUM(A3:A6)+SUM(A2:A3)', '数据', rows)).toEqual({ formula: 'A2+A3+SUM(A1:A7)+SUM(A3:A4)+SUM(A2:A2)', broken: false })
    expect(rewriteFormula('A3*2+SUM(B3:B4)', '数据', rows)).toEqual({ formula: '#REF!*2+SUM(#REF!)', broken: true })
    expect(rewriteFormula('SUM(B:C)+A1', '数据', shift('column', 2, 2, false))).toEqual({ formula: 'SUM(#REF!)+A1', broken: true })
  })
  it('count only when they mean the changed sheet', () => {
    const rows = shift('row', 2, 1, true)
    expect(rewrite("A5+数据!A5+'数据'!A5+其他!A5", rows, '其他')).toBe("A5+数据!A6+'数据'!A6+其他!A5")
    expect(rewrite('A5+其他!A5', rows)).toBe('A6+其他!A5')
    expect(rewriteFormula('数据!A5+A5', undefined, rows).formula).toBe('数据!A6+A5')
  })
  it('leave text, names, functions, numbers and table columns alone', () => {
    const rows = shift('row', 2, 1, true)
    expect(rewrite('"A5"&LOG10(A5)+1E5+A5B+Rate5+T[A5]+T[[#This Row],[A5]]', rows)).toBe('"A5"&LOG10(A6)+1E5+A5B+Rate5+T[A5]+T[[#This Row],[A5]]')
  })
  it('refuse the same cells across several sheets and an insertion with no room', () => {
    for (const formula of ['SUM(数据:其他!A1)', 'SUM(一:三!A1)', "SUM('数据:其 他'!A1:B2)"]) expect(() => rewrite(formula, shift('row', 2, 1, true), '其他'), formula).toThrow('several sheets')
    expect(() => rewrite('A1048576', shift('row', 2, 1, true))).toThrow('no room')
  })
})

describe('inserting rows', () => {
  const data = row(1, c('A1', 1), c('B1', 'A1*2', 1)) + row(2, c('A2', 2), c('B2', 'A2*2', 1)) + row(3, c('A3', 3), c('B3', 'A3*2', 1)) + row(4, c('A4', 'SUM(A1:A3)'), c('B4', 'SUM(B1:B3)'))
  const after = '<autoFilter ref="A1:B3"/><mergeCells count="2"><mergeCell ref="D1:E1"/><mergeCell ref="D3:E4"/></mergeCells><conditionalFormatting sqref="A1:A3 D9"><cfRule type="expression" priority="1"><formula>A1&gt;$A$3</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" sqref="C2:C3"><formula1>$A$1:$A$3</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="A3" location="数据!A1"/></hyperlinks>'
  const book = () => workbook({ 数据: '', 汇总: row(1, c('A1', '数据!A3+数据!B4'), c('B1', 'A1+1')) }, { ...styles, 'xl/worksheets/sheet1.xml': sheetPart(data, '<dimension ref="A1:B4"/>', after) }, '<definedNames><definedName name="Total">数据!$A$4</definedName><definedName name="Local" localSheetId="0">$B$1:$B$3</definedName></definedNames>')
  it('moves the cells below, and every formula on every sheet follows', () => {
    const { bytes } = change(book(), insertRows(3))
    const range = read(bytes)
    expect(range.rows.map(line => line[0])).toEqual([1, 2, null, 3, null])
    expect(range.formulas).toEqual({ B1: 'A1*2', B2: 'A2*2', B3: 'A3*2', B4: 'A4*2', A5: 'SUM(A1:A4)', B5: 'SUM(B1:B4)' })
    expect(read(bytes, undefined, '汇总').formulas).toEqual({ A1: '数据!A4+数据!B5', B1: 'A1+1' })
    expect(text(bytes, 'xl/workbook.xml')).toContain('<definedName name="Total">数据!$A$5</definedName><definedName name="Local" localSheetId="0">$B$1:$B$4</definedName>')
  })
  it('moves what the sheet keeps beside its cells', () => {
    const sheet = text(change(book(), insertRows(3)).bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<dimension ref="A1:B5"/>')
    expect(sheet).toContain('<autoFilter ref="A1:B4"/>')
    expect(sheet).toContain('<mergeCells count="2"><mergeCell ref="D1:E1"/><mergeCell ref="D4:E5"/></mergeCells>')
    expect(sheet).toContain('<conditionalFormatting sqref="A1:A4 D10"><cfRule type="expression" priority="1"><formula>A1&gt;$A$4</formula></cfRule>')
    expect(sheet).toContain('<dataValidation type="list" sqref="C2:C4"><formula1>$A$1:$A$4</formula1>')
    expect(sheet).toContain('<hyperlink ref="A4" location="数据!A1"/>')
  })
  it('makes the new row look like the row above, and carries a formula on where both sides repeat it', () => {
    const { bytes, touched, filled } = change(book(), insertRows(3, 2))
    expect(read(bytes).formulas).toEqual({ B1: 'A1*2', B2: 'A2*2', B3: 'A3*2', B4: 'A4*2', B5: 'A5*2', A6: 'SUM(A1:A5)', B6: 'SUM(B1:B5)' })
    expect(read(bytes).looks).toEqual(['B1:B5 format #,##0.00'])
    expect(touched).toEqual([{ sheet: '数据', range: 'B3:B4' }])
    expect(filled).toBe(true)
    const bare = change(book(), insertRows(3, 2), false)
    expect(read(bare.bytes).formulas).toEqual({ B1: 'A1*2', B2: 'A2*2', B5: 'A5*2', A6: 'SUM(A1:A5)', B6: 'SUM(B1:B5)' })
    expect(bare.filled).toBe(false)
    // Rows 3 and 4 hold different formulas, so nothing is carried on between them.
    expect(read(change(book(), insertRows(4)).bytes).formulas).toEqual({ B1: 'A1*2', B2: 'A2*2', B3: 'A3*2', A5: 'SUM(A1:A3)', B5: 'SUM(B1:B3)' })
  })
  it('writes a shared formula out for each cell before moving them', () => {
    const shared = row(1, c('A1', 1), '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c>') + row(2, c('A2', 2), '<c r="B2"><f t="shared" si="0"/><v>4</v></c>') + row(3, c('A3', 3), '<c r="B3"><f t="shared" si="0"/><v>6</v></c>')
    const { bytes } = change(workbook({ 数据: shared }), insertRows(2))
    expect(read(bytes).formulas).toEqual({ B1: 'A1*2', B2: 'A2*2', B3: 'A3*2', B4: 'A4*2' })
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).not.toContain('shared')
  })
})

describe('deleting rows', () => {
  const data = row(1, c('A1', 1)) + row(2, c('A2', 2)) + row(3, c('A3', 3)) + row(4, c('A4', 'SUM(A1:A3)'), c('B4', 'A2*10'), c('C4', 'A3+1'))
  const book = () => workbook({ 数据: '', 汇总: row(1, c('A1', '数据!A2'), c('B1', '数据!A4')) }, { 'xl/worksheets/sheet1.xml': sheetPart(data, '', '<mergeCells count="3"><mergeCell ref="D1:E2"/><mergeCell ref="D2:E2"/><mergeCell ref="G1:G2"/></mergeCells>') }, '<definedNames><definedName name="Second">数据!$A$2</definedName></definedNames>')
  it('closes the gap and names the formulas that lost their cells', () => {
    const { bytes, structure, touched } = change(book(), deleteRows(2))
    expect(read(bytes).rows.map(line => line[0])).toEqual([1, 3, null])
    expect(read(bytes).formulas).toEqual({ A3: 'SUM(A1:A2)', B3: '#REF!*10', C3: 'A2+1' })
    expect(read(bytes, undefined, '汇总').formulas).toEqual({ A1: '数据!#REF!', B1: '数据!A3' })
    expect(structure).toEqual({ brokenReferences: [{ sheet: '数据', cell: 'B3' }, { sheet: '汇总', cell: 'A1' }, { sheet: '(defined name)', cell: 'Second' }], brokenCount: 3 })
    expect(touched).toEqual([])
  })
  it('shrinks a merged range, and drops one left with a single cell or none', () => {
    expect(text(change(book(), deleteRows(2)).bytes, 'xl/worksheets/sheet1.xml')).toContain('<mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>')
    expect(text(change(book(), deleteRows(1, 2)).bytes, 'xl/worksheets/sheet1.xml')).not.toContain('mergeCell')
  })
})

describe('inserting and deleting columns', () => {
  const data = row(1, c('A1', 1), c('B1', 2, 1), c('C1', 'A1+B1')) + row(2, c('A2', 3), c('B2', 4, 1), c('C2', 'A2+B2'))
  const book = () => workbook({ 数据: '' }, { ...styles, 'xl/worksheets/sheet1.xml': sheetPart(data, '<cols><col min="1" max="2" width="20" customWidth="1"/><col min="3" max="3" width="9" customWidth="1"/></cols>') })
  it('moves the cells to the right and makes the new column like the one to its left', () => {
    const { bytes, touched } = change(book(), insertColumns('C'))
    const range = read(bytes)
    expect(range.rows).toEqual([[1, 2, null, null], [3, 4, null, null]])
    expect(range.formulas).toEqual({ D1: 'A1+B1', D2: 'A2+B2' })
    expect(range.looks).toEqual(['B1:C2 format #,##0.00'])
    expect(range.columnWidths).toEqual({ 'A:C': 20, D: 9 })
    expect(touched).toEqual([{ sheet: '数据', range: 'C1:C2' }])
  })
  it('removes a column with its width, and reports what referred to it', () => {
    const { bytes, structure } = change(book(), deleteColumns('B'))
    expect(read(bytes).formulas).toEqual({ B1: 'A1+#REF!', B2: 'A2+#REF!' })
    expect(read(bytes).columnWidths).toEqual({ A: 20, B: 9 })
    expect(structure.brokenCount).toBe(2)
  })
})

describe('tables, charts and pictures', () => {
  const table = `<?xml version="1.0"?><table ${NS} id="1" name="T" displayName="T" ref="B2:C4"><autoFilter ref="B2:C4"/><tableColumns count="2"><tableColumn id="1" name="a"/><tableColumn id="2" name="b"/></tableColumns></table>`
  const drawing = '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to></xdr:twoCellAnchor></xdr:wsDr>'
  const chart = '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:ser><c:cat><c:strRef><c:f>\'数据\'!$B$3:$B$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>数据!$C$3:$C$4</c:f></c:numRef></c:val></c:ser></c:chartSpace>'
  const data = row(2, '<c r="B2" t="inlineStr"><is><t>a</t></is></c>', '<c r="C2" t="inlineStr"><is><t>b</t></is></c>') + row(3, c('B3', 1), c('C3', 2)) + row(4, c('B4', 3), c('C4', 4))
  const book = () => workbook({ 数据: data }, {
    'xl/worksheets/_rels/sheet1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/><Relationship Id="rId2" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>`),
    'xl/tables/table1.xml': table, 'xl/drawings/drawing1.xml': drawing, 'xl/charts/chart1.xml': chart,
  })
  it('follow rows inserted inside and above them', () => {
    const { bytes } = change(book(), insertRows(4))
    expect(text(bytes, 'xl/tables/table1.xml')).toContain('ref="B2:C5"><autoFilter ref="B2:C5"/>')
    expect(text(bytes, 'xl/charts/chart1.xml')).toContain("<c:f>'数据'!$B$3:$B$5</c:f>")
    expect(text(bytes, 'xl/charts/chart1.xml')).toContain('<c:f>数据!$C$3:$C$5</c:f>')
    expect(text(bytes, 'xl/drawings/drawing1.xml')).toContain('<xdr:row>6</xdr:row>')
    expect(text(bytes, 'xl/drawings/drawing1.xml')).toContain('<xdr:row>16</xdr:row>')
  })
  it('follow a column inserted to their left, and a data row deleted', () => {
    const moved = change(book(), insertColumns('A', 2)).bytes
    expect(text(moved, 'xl/tables/table1.xml')).toContain('ref="D2:E4"')
    expect(text(moved, 'xl/drawings/drawing1.xml')).toContain('<xdr:col>6</xdr:col>')
    expect(text(moved, 'xl/charts/chart1.xml')).toContain('<c:f>数据!$E$3:$E$4</c:f>')
    expect(text(change(book(), deleteRows(3)).bytes, 'xl/tables/table1.xml')).toContain('ref="B2:C3"')
  })
  it('refuse a change that would break a table', () => {
    expect(() => change(book(), insertColumns('C'))).toThrow('runs through the columns of table T')
    expect(() => change(book(), deleteColumns('B'))).toThrow('runs through the columns of table T')
    expect(() => change(book(), deleteRows(2))).toThrow('header row')
    expect(() => change(book(), deleteRows(3, 2))).toThrow('every data row')
  })
})

describe('sheets a change cannot be made to follow', () => {
  const data = row(1, c('A1', 1)) + row(2, c('A2', 2))
  const withRelation = (kind: string) => workbook({ 数据: data }, { 'xl/worksheets/_rels/sheet1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/${kind}" Target="../x/${kind}1.xml"/>`), [`xl/x/${kind}1.xml`]: '<?xml version="1.0"?><x/>' })
  it('are refused whole', () => {
    expect(() => change(withRelation('comments'), insertRows(2))).toThrow('notes or comments')
    expect(() => change(withRelation('pivotTable'), insertRows(2))).toThrow('pivot table')
    expect(() => change(workbook({ 数据: '' }, { 'xl/worksheets/sheet1.xml': sheetPart(data, '', '<extLst><ext><x14:sparklineGroups xmlns:x14="u" xmlns:xm="m"><xm:sqref>A1</xm:sqref></x14:sparklineGroups></ext></extLst>') }), insertRows(2))).toThrow('sparklines')
    expect(() => change(workbook({ 数据: row(1, '<c r="A1"><f t="array" ref="A1:A3">B1:B3*2</f><v>0</v></c>') + row(2, c('A2', 0)) + row(3, c('A3', 0)) }), insertRows(2))).toThrow('array formula at A1:A3')
    expect(() => change(workbook({ 数据: data, 二: data, 汇总: row(1, c('A1', 'SUM(数据:二!A1)')) }), insertRows(2))).toThrow('several sheets')
    expect(() => change(workbook({ 数据: data }), insertRows(2, 1, '没有'))).toThrow('no sheet named')
  })
  it('leave an array formula the change does not run through', () => {
    const { bytes } = change(workbook({ 数据: row(1, c('A1', 1)) + row(3, '<c r="A3"><f t="array" ref="A3:A4">B3:B4*2</f><v>0</v></c>') + row(4, c('A4', 0)) }), insertRows(2))
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toContain('<f t="array" ref="A4:A5">B4:B5*2</f>')
  })
})

describe('checking an insertion by calculating before and after', () => {
  const renderer = new OfficeRenderer()
  afterAll(() => renderer.dispose())
  const calculate = (bytes: Uint8Array) => renderer.recalculate(bytes, signal)
  const verified = (bytes: Uint8Array, structure: StructureChange, calculates = true) => restructureVerified(bytes, structure, LIMIT, calculates ? calculate : undefined, signal)
  const data = row(1, c('A1', 1), c('B1', 'A1*2')) + row(2, c('A2', 2), c('B2', 'A2*2')) + row(3, c('A3', 3), c('B3', 'A3*2')) + row(4, c('A4', 'SUM(A1:A3)'), c('B4', 'SUM(B1:B3)'))
  it('makes an insertion that leaves every existing value as it was', async () => {
    const { bytes, structure, touched } = await verified(workbook({ 数据: data, 汇总: row(1, c('A1', '数据!B4/数据!A4')) }), insertRows(2))
    expect(structure).toEqual({ brokenReferences: [], brokenCount: 0, verified: true })
    expect(read(bytes).formulas).toMatchObject({ B2: 'A2*2', A5: 'SUM(A1:A4)' })
    expect(touched).toEqual([{ sheet: '数据', range: 'B2:B2' }])
  }, 120000)
  it('leaves out the carried formulas when they are what changes a value', async () => {
    const counted = data + row(6, c('A6', 'COUNT(B1:B4)'))
    const { bytes, structure } = await verified(workbook({ 数据: counted }), insertRows(2))
    expect(structure.verified).toBe(true)
    expect(read(bytes).formulas).toEqual({ B1: 'A1*2', B3: 'A3*2', B4: 'A4*2', A5: 'SUM(A1:A4)', B5: 'SUM(B1:B4)', A7: 'COUNT(B1:B5)' })
  }, 120000)
  it('does not make an insertion that changes an existing value', async () => {
    await expect(verified(workbook({ 数据: data + row(6, c('A6', 'ROW()*100')) }), insertRows(2))).rejects.toThrow(/The insertion was not made: after it, 1 existing cells would calculate to other values, for example 数据!A7 \("600" became "700"\)/u)
  }, 120000)
  it('says why values were not compared', async () => {
    expect((await verified(workbook({ 数据: data }), insertRows(2), false)).structure.reason).toContain('Temporary Chat')
    expect((await verified(workbook({ 数据: data }), deleteRows(2))).structure).toMatchObject({ brokenCount: 0, reason: expect.stringContaining('Deleting cells') })
    expect((await verified(workbook({ 数据: data + row(6, c('A6', 'TODAY()')) }), insertRows(2))).structure.reason).toContain('NOW or RAND')
    expect((await verified(workbook({ 数据: row(1, c('A1', 1)) + row(2, c('A2', 2)) }), insertRows(2))).structure.verified).toBe(true)
  }, 120000)
})
