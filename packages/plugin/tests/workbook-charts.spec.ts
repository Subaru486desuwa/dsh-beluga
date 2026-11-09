import { afterAll, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { OfficePackage } from '../../office/src/package.ts'
import { workbookRecords } from '../../office/src/workbook.ts'
import { addCharts } from '../../office/src/workbook-charts.ts'
import { createWorkbook, settleWorkbook } from '../../office/src/workbook-write.ts'
import { workbook } from './office-fixtures.ts'
import { validateWorkbook, workbookEdit } from '../src/host/workbooks.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const ENGINE_TIME = 60000
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const relationships = (items: string) => `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
const text = (bytes: Uint8Array, part: string) => strFromU8(unzipSync(bytes)[part]!)
const budget = { title: '预算', sheets: [{ name: '预算', rows: [['季度', '预算', '实际'], ['Q1', 55000, 54000], ['Q2', 57000, 58500], ['Q3', 58000, 62000], ['Q4', 60000, 60500]] }] }
const column = { sheet: '预算', chart: 'column', title: '预算与实际', categories: 'A2:A5', series: [{ values: 'B2:B5' }, { values: 'C2:C5' }] }
async function created(charts: readonly object[], input: object = budget) {
  const source = validateWorkbook({ ...input, charts })
  return addCharts(await createWorkbook(source, signal), source.charts!, LIMIT, signal)
}
/** A sheet of two months beside whatever else `tail` puts after its data. */
const sheetXml = (tail: string) => `${DECLARATION}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月</t></is></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c><c r="B2"><v>5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>二月</t></is></c><c r="B3"><v>7</v></c></row></sheetData>${tail}</worksheet>`
const monthly = { sheet: 'S', chart: 'line', categories: 'A2:A3', series: [{ values: 'B2:B3' }] } as const

describe('adding charts', () => {
  it('draws a chart beside the data that reads its cells', async () => {
    const { bytes, charts } = await created([column])
    expect(charts).toEqual([{ sheet: '预算', title: '预算与实际', at: 'E2:M18', notNumbers: [] }])
    const chart = text(bytes, 'xl/charts/chart1.xml')
    expect(chart).toContain("<c:cat><c:strRef><c:f>'预算'!$A$2:$A$5</c:f>")
    expect(chart).toContain("<c:val><c:numRef><c:f>'预算'!$C$2:$C$5</c:f>")
    expect(chart).toContain("<c:tx><c:strRef><c:f>'预算'!$B$1</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>预算</c:v></c:pt></c:strCache></c:strRef></c:tx>")
    expect(chart).toContain('<c:pt idx="2"><c:v>62000</c:v></c:pt>')
    expect(chart).toContain('<c:barDir val="col"/>')
    expect(chart).toContain('<c:min val="0"/>')
    expect(chart).toContain('<c:legend>')
    const types = text(bytes, '[Content_Types].xml')
    expect(types).toContain('<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>')
    expect(types).toContain('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>')
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toMatch(/<pageSetup [^>]*\/><drawing r:id="rId1"\/><\/worksheet>$/u)
    expect(text(bytes, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain(`Type="${REL}/drawing" Target="../drawings/drawing1.xml"`)
    expect(text(bytes, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(`Type="${REL}/chart" Target="../charts/chart1.xml"`)
    expect(workbookRecords(OfficePackage.open(bytes, LIMIT, signal))[0]).toMatchObject({ sheet: '预算', charts: 1, images: 0 })
  })
  it('formats the saved values and the value axis as their cells are formatted', async () => {
    const sheet = { ...budget.sheets[0]!, formats: { B: '#,##0', C: '#,##0" 元"' } }
    const { bytes } = await created([column, { ...column, series: [{ values: 'C2:C5' }] }], { ...budget, sheets: [sheet] })
    // A built-in format, written out as Excel saves it; the axis takes the first series' format.
    const first = text(bytes, 'xl/charts/chart1.xml')
    expect(first).toContain("<c:f>'预算'!$B$2:$B$5</c:f><c:numCache><c:formatCode>#,##0</c:formatCode>")
    expect(first).toContain('<c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="1"/>')
    expect(first).toContain('<c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/>')
    // A custom one, quotes escaped.
    const second = text(bytes, 'xl/charts/chart2.xml')
    expect(second).toContain('<c:numCache><c:formatCode>#,##0&quot; 元&quot;</c:formatCode>')
    expect(second).toContain('<c:majorGridlines/><c:numFmt formatCode="#,##0&quot; 元&quot;" sourceLinked="1"/>')
  })
  it('lets the axis go below zero for negative values, with the labels clear of the bars', async () => {
    const { bytes } = await created([{ sheet: '预算', chart: 'bar', categories: 'A2:A3', series: [{ values: 'B2:B3', name: '差额' }] }], { title: 't', sheets: [{ name: '预算', rows: [['季度', '差额'], ['Q1', -1000], ['Q2', 1500]] }] })
    const chart = text(bytes, 'xl/charts/chart1.xml')
    expect(chart).not.toContain('<c:min ')
    expect(chart).toContain('<c:barDir val="bar"/>')
    expect(chart).toContain('<c:tickLblPos val="low"/>')
    expect(chart).toContain('<c:tx><c:v>差额</c:v></c:tx>')
    expect(chart).toContain('<c:autoTitleDeleted val="1"/>')
    expect(chart).not.toContain('<c:legend>')
  })
  it('reports value cells that are not numbers and leaves them out', async () => {
    const { bytes, charts } = await created([{ sheet: 'S', chart: 'line', categories: 'B1:D1', series: [{ values: 'B2:D2' }] }], { title: 't', sheets: [{ name: 'S', rows: [[null, 'Jan', 'Feb', 'Mar'], ['收入', 100, '1,200', 300]] }] })
    expect(charts[0]!.notNumbers).toEqual(['C2'])
    const chart = text(bytes, 'xl/charts/chart1.xml')
    // A row of values takes its name from the cell to its left.
    expect(chart).toContain("<c:tx><c:strRef><c:f>'S'!$A$2</c:f>")
    expect(chart).toContain('<c:ptCount val="3"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="2"><c:v>300</c:v></c:pt></c:numCache>')
  })
  it('colours each slice of a pie and shows its share', async () => {
    const { bytes } = await created([{ sheet: '预算', chart: 'pie', categories: 'A2:A5', series: [{ values: 'C2:C5' }] }])
    const chart = text(bytes, 'xl/charts/chart1.xml')
    expect(chart.match(/<c:dPt>/gu)).toHaveLength(4)
    expect(chart).toContain('<c:showPercent val="1"/>')
    expect(chart).not.toContain('<c:catAx>')
  })
  it('puts several charts on a sheet into one drawing, each below the last', async () => {
    const { bytes, charts } = await created([column, { ...column, chart: 'line', title: '走势' }])
    expect(charts.map(item => item.at)).toEqual(['E2:M18', 'E20:M36'])
    expect(text(bytes, 'xl/worksheets/sheet1.xml').match(/<drawing /gu)).toHaveLength(1)
    const drawing = text(bytes, 'xl/drawings/drawing1.xml')
    expect(drawing.match(/<xdr:twoCellAnchor>/gu)).toHaveLength(2)
    expect(drawing).toContain('<xdr:cNvPr id="3" name="Chart 3" descr="走势"/>')
    expect(Object.keys(unzipSync(bytes)).filter(name => name.startsWith('xl/drawings/drawing'))).toEqual(['xl/drawings/drawing1.xml'])
  })
  it('adds to the drawing a sheet already has, below what is there, and keeps the rest', async () => {
    const picture = '<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="5" name="Logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>'
    const source = workbook({ S: '' }, {
      'xl/worksheets/sheet1.xml': sheetXml('<drawing r:id="rId1"/>'),
      'xl/worksheets/_rels/sheet1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>`),
      'xl/drawings/drawing1.xml': `${DECLARATION}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">${picture}</xdr:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/>`),
      'xl/media/image1.png': 'image bytes',
    })
    const { bytes, charts } = addCharts(source, [monthly], LIMIT, signal)
    // The picture covers columns E:H of rows 1 to 10, so the chart starts below it.
    expect(charts[0]!.at).toBe('D12:L28')
    const drawing = text(bytes, 'xl/drawings/drawing1.xml')
    expect(drawing).toContain(picture)
    expect(drawing).toContain('<xdr:cNvPr id="6" name="Chart 6"/>')
    expect(text(bytes, 'xl/drawings/_rels/drawing1.xml.rels')).toBe(relationships(`<Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${REL}/chart" Target="../charts/chart1.xml"/>`))
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toBe(sheetXml('<drawing r:id="rId1"/>'))
    expect(text(bytes, 'xl/media/image1.png')).toBe('image bytes')
    expect(workbookRecords(OfficePackage.open(bytes, LIMIT, signal))[0]).toMatchObject({ charts: 1, images: 1 })
  })
  it('links a new drawing ahead of the parts a worksheet keeps after it', () => {
    const source = workbook({ S: '' }, {
      'xl/worksheets/sheet1.xml': sheetXml('<legacyDrawing r:id="rId1"/>'),
      'xl/worksheets/_rels/sheet1.xml.rels': relationships(`<Relationship Id="rId1" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>`),
      'xl/drawings/vmlDrawing1.vml': '<xml/>',
    })
    const { bytes } = addCharts(source, [monthly], LIMIT, signal)
    expect(text(bytes, 'xl/worksheets/sheet1.xml')).toBe(sheetXml('<drawing r:id="rId2"/><legacyDrawing r:id="rId1"/>'))
    expect(text(bytes, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain(`<Relationship Id="rId2" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>`)
  })
  it('refuses what a chart cannot draw', async () => {
    await expect(created([{ ...column, categories: 'A2:B5' }])).rejects.toThrow('must be one column or one row')
    await expect(created([{ ...column, series: [{ values: 'B2:B4' }] }])).rejects.toThrow('values B2:B4 has 3 cells, but categories A2:A5 has 4')
    expect(() => validateWorkbook({ ...budget, charts: [{ ...column, sheet: '其他' }] })).toThrow('the sheets are 预算')
    expect(() => validateWorkbook({ ...budget, charts: [{ ...column, chart: 'pie' }] })).toThrow('A pie chart takes one series')
    expect(() => workbookEdit.parse({ attachmentId: crypto.randomUUID(), summary: 'Nothing' })).toThrow('Give changes, charts or both')
    expect(() => addCharts(workbook({ S: '' }), [{ ...monthly, sheet: 'T' }], LIMIT, signal)).toThrow('no sheet named "T"')
  })
})

describe('printing a new workbook', () => {
  it('fits each sheet to one page wide, across the page when it is wide or has charts', async () => {
    const parts = unzipSync(await createWorkbook(validateWorkbook({ title: 't', sheets: [{ name: 'W', rows: [[1, 2, 3, 4, 5, 6, 7, 8]] }, { name: 'N', rows: [[1, 2]] }] }), signal))
    const wide = strFromU8(parts['xl/worksheets/sheet1.xml']!)
    expect(wide).toContain('<pageSetUpPr fitToPage="1"/>')
    expect(wide).toMatch(/<pageSetup [^>]*orientation="landscape"[^>]*fitToWidth="1" fitToHeight="0"/u)
    expect(strFromU8(parts['xl/worksheets/sheet2.xml']!)).toMatch(/<pageSetup [^>]*orientation="portrait"/u)
    const charted = unzipSync(await createWorkbook(validateWorkbook({ ...budget, charts: [column] }), signal))
    expect(strFromU8(charted['xl/worksheets/sheet1.xml']!)).toContain('orientation="landscape"')
  })
})

describe('charts of a settled workbook', () => {
  const renderer = new OfficeRenderer()
  afterAll(() => renderer.dispose())
  it('save the calculated values, and LibreOffice reads them as charts', async () => {
    const source = validateWorkbook({ title: 't', sheets: [{ name: 'S', rows: [['季度', '差额'], ['Q1', { formula: '1-2' }], ['Q2', { formula: '2*3' }]] }], charts: [{ sheet: 'S', chart: 'column', categories: 'A2:A3', series: [{ values: 'B2:B3' }] }] })
    const settled = await settleWorkbook(await createWorkbook(source, signal), LIMIT, data => renderer.recalculate(data, signal), signal)
    const { bytes } = addCharts(settled.bytes, source.charts!, LIMIT, signal)
    const chart = text(bytes, 'xl/charts/chart1.xml')
    expect(chart).toContain('<c:pt idx="0"><c:v>-1</c:v></c:pt><c:pt idx="1"><c:v>6</c:v></c:pt>')
    expect(chart).not.toContain('<c:min ')
    // LibreOffice writes back only the charts it understood.
    expect(Object.keys(unzipSync(await renderer.recalculate(bytes, signal))).filter(name => /^xl\/charts\/chart\d+\.xml$/u.test(name))).toHaveLength(1)
    const preview = await renderer.preview(bytes, 't.xlsx', undefined, LIMIT, signal)
    expect(preview.range).toBe('A1:M19')
    expect(preview.pages).toHaveLength(1)
  }, ENGINE_TIME)
  it('leave formula results out until Excel calculates them, and keep the axis free meanwhile', async () => {
    const source = validateWorkbook({ title: 't', sheets: [{ name: 'S', rows: [['季度', '差额'], ['Q1', 5], ['Q2', { formula: 'B2*2' }]] }], charts: [{ sheet: 'S', chart: 'column', categories: 'A2:A3', series: [{ values: 'B2:B3' }] }] })
    const settled = await settleWorkbook(await createWorkbook(source, signal), LIMIT, undefined, signal)
    const { bytes, charts } = addCharts(settled.bytes, source.charts!, LIMIT, signal)
    expect(charts[0]!.notNumbers).toEqual([])
    const chart = text(bytes, 'xl/charts/chart1.xml')
    expect(chart).toContain('<c:ptCount val="2"/><c:pt idx="0"><c:v>5</c:v></c:pt></c:numCache>')
    expect(chart).not.toContain('<c:min ')
  })
})
