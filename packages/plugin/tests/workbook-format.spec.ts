import { describe, expect, it } from 'vitest'
import { OfficePackage } from '../../office/src/package.ts'
import { readRange } from '../../office/src/workbook.ts'
import { workbook } from './office-fixtures.ts'

const signal = new AbortController().signal
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const read = (bytes: Uint8Array, range?: string) => readRange(OfficePackage.open(bytes, 16 * 1024 * 1024, signal), range ? { range } : {}, 100000)
const styleSheet = (inner: string) => ({ 'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}>${inner}</styleSheet>` })
const fonts = '<fonts><font><sz val="11"/><color theme="1"/><name val="等线"/></font><font><b/><sz val="14"/><color rgb="FFC00000"/><name val="黑体"/></font><font><i/><u/><sz val="11"/><color theme="4" tint="-0.5"/><name val="等线"/></font></fonts>'
const fills = '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/></patternFill></fill></fills>'
const borders = '<borders><border><left/><right/><top/><bottom/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border><border><left/><right/><top/><bottom style="medium"/></border></borders>'
const xfs = '<cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="2"/></cellXfs>'
const theme = { 'xl/theme/theme1.xml': '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>' }
const c = (ref: string, style: number, value?: number) => `<c r="${ref}"${style ? ` s="${style}"` : ''}>${value === undefined ? '' : `<v>${value}</v>`}</c>`
const row = (number: number, ...cells: string[]) => `<row r="${number}">${cells.join('')}</row>`

describe('the look of cells in a read', () => {
  const data = row(1, c('A1', 1, 1), c('B1', 1, 2), c('C1', 1, 3)) + row(2, c('A2', 0, 1), c('B2', 2, 2), c('C2', 2, 3)) + row(3, c('A3', 0, 1), c('B3', 2, 2), c('C3', 2)) + row(4, c('A4', 3, 1), c('C4', 3, 1))
  const book = () => workbook({ 数据: data }, { ...styleSheet(fonts + fills + borders + xfs), ...theme })
  it('names ranges that share a look, told apart from the default style', () => {
    const result = read(book())
    expect(result.defaultLook).toBe('等线 11pt')
    expect(result.looks).toEqual([
      'A1:C1 黑体 14pt bold #C00000 fill #D9E1F2 border center vertical center wrap',
      'B2:C3 format #,##0.00',
      'A4 italic underline #223962 border bottom',
      'C4 italic underline #223962 border bottom',
    ])
    expect(result.rows).toEqual([[1, 2, 3], [1, 2, 3], [1, 2, null], [1, null, 1]])
  })
  it('keeps to the rectangle read', () => {
    expect(read(book(), 'B1:B2').looks).toEqual(['B1 黑体 14pt bold #C00000 fill #D9E1F2 border center vertical center wrap', 'B2 format #,##0.00'])
    expect(read(book(), 'A2:A3').looks).toBeUndefined()
  })
  it('gives column widths, row heights and merged ranges that touch the rectangle', () => {
    const sheet = `<?xml version="1.0"?><worksheet ${NS}><cols><col min="1" max="1" width="8.5" customWidth="1"/><col min="2" max="4" width="20.25" customWidth="1"/><col min="9" max="9" width="30" customWidth="1"/></cols><sheetData>${row(1, c('A1', 0, 1)) + '<row r="2" ht="30" customHeight="1"><c r="D2"><v>1</v></c></row>' + row(8, c('A8', 0, 1))}</sheetData><mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="A7:B8"/></mergeCells></worksheet>`
    const result = read(workbook({ 数据: '' }, { 'xl/worksheets/sheet1.xml': sheet }), 'A1:C3')
    expect(result.columnWidths).toEqual({ A: 8.5, 'B:C': 20.3 })
    expect(result.rowHeights).toEqual({ 2: 30 })
    expect(result.merged).toEqual(['A1:C1'])
    expect(result.defaultLook).toBe('')
  })
  it('caps the ranges it lists', () => {
    const many = Array.from({ length: 200 }, (_, index) => row(index + 1, c('A' + (index + 1), index % 2 ? 1 : 2, 1))).join('')
    const result = read(workbook({ 数据: many }, styleSheet(fonts + fills + borders + xfs)))
    expect(result.looks).toHaveLength(151)
    expect(result.looks!.at(-1)).toBe('50 more ranges are not listed; read a smaller range to see them')
  })
})
