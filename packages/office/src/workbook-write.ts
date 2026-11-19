/**
 * Write workbooks. New ones go through ExcelJS. Existing ones get their cells patched in the sheet XML,
 * because no library round-trips a workbook without dropping parts it does not model.
 */
import ExcelJS from 'exceljs'
import { PersonalChatError, reachesOutside, validateWorkbook } from 'dsh-beluga'
import type { CellChange, WorkbookCell, WorkbookCheck, WorkbookInput } from 'dsh-beluga'
import { OfficePackage, fail } from './package.ts'
import { all, buildTree, deep, dropAttr, element, escapeXml, find, getAttr, isElement, kids, parseTree, prefixOf, require, setAttr, tagOf, textNode, textOf, type Element } from './tree.ts'
import { cellRef, findSheet, openBook, outlineSheet, parseRange, position, sheetCells, targetError, type Book, type Cell, type OutlinedSheet, type Position } from './workbook.ts'

const REPORTED_CELLS = 20
/** Wider sheets print across the page. */
const PORTRAIT_COLUMNS = 6
const WORD_WIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/gu

const serialOf = (date: string): number => (Date.parse(date.replace(' ', 'T') + (date.length > 10 ? 'Z' : '')) - Date.UTC(1899, 11, 30)) / 86400000
function displayWidth(value: WorkbookCell): number {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  return text.length + (text.match(WORD_WIDTH)?.length ?? 0)
}
export async function createWorkbook(input: WorkbookInput, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const source = validateWorkbook(input)
  const book = new ExcelJS.Workbook()
  book.title = source.title
  const charted = new Set((source.charts ?? []).map(chart => chart.sheet))
  for (const sheet of source.sheets) {
    const frozen = sheet.freeze ? position(sheet.freeze) : undefined
    const target = book.addWorksheet(sheet.name, frozen ? { views: [{ state: 'frozen', xSplit: frozen.column - 1, ySplit: frozen.row - 1 }] } : {})
    sheet.rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      const cell = target.getCell(rowIndex + 1, columnIndex + 1)
      if (value !== null && typeof value === 'object') {
        if ('formula' in value) cell.value = { formula: value.formula }
        else { cell.value = new Date(value.date.replace(' ', 'T') + (value.date.length > 10 ? 'Z' : '')); cell.numFmt = value.date.length > 10 ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd' }
      } else cell.value = value
    }))
    const columns = Math.max(...sheet.rows.map(row => row.length))
    for (let column = 1; column <= columns; column++) {
      const widest = Math.max(...sheet.rows.map(row => displayWidth(row[column - 1] ?? null)))
      target.getColumn(column).width = Math.min(48, Math.max(10, widest + 2))
    }
    for (const [column, width] of Object.entries(sheet.widths ?? {})) target.getColumn(column).width = width
    // One page wide however long, so a PDF never moves columns onto later pages; charts sit to the right of the data.
    target.pageSetup.orientation = columns > PORTRAIT_COLUMNS || charted.has(sheet.name) ? 'landscape' : 'portrait'
    target.pageSetup.fitToPage = true
    target.pageSetup.fitToWidth = 1
    target.pageSetup.fitToHeight = 0
    for (const [column, format] of Object.entries(sheet.formats ?? {})) target.getColumn(column).eachCell(cell => { if (typeof cell.value !== 'string') cell.numFmt = format })
    if (sheet.header) target.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
      cell.alignment = { vertical: 'middle', wrapText: true }
    })
    if (sheet.filter) target.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } }
  }
  const bytes = new Uint8Array(await book.xlsx.writeBuffer())
  signal.throwIfAborted()
  return bytes
}
export function cellNode(prefix: string, ref: string, style: string | undefined, value: WorkbookCell): Element {
  const attrs: Record<string, string> = { r: ref, ...(style === undefined ? {} : { s: style }) }
  const leaf = (tag: string, text: string) => element(prefix + tag, {}, [textNode(text)])
  if (value === null) return element(prefix + 'c', attrs)
  if (typeof value === 'number') return element(prefix + 'c', attrs, [leaf('v', String(value))])
  if (typeof value === 'boolean') return element(prefix + 'c', { ...attrs, t: 'b' }, [leaf('v', value ? '1' : '0')])
  if (typeof value === 'string') return element(prefix + 'c', { ...attrs, t: 'inlineStr' }, [element(prefix + 'is', {}, [element(prefix + 't', { 'xml:space': 'preserve' }, [textNode(value)])])])
  if ('formula' in value) return element(prefix + 'c', attrs, [leaf('f', value.formula)])
  return element(prefix + 'c', attrs, [leaf('v', String(serialOf(value.date)))])
}
export function placeRow(rows: Element[], rowNumber: number, prefix: string): Element {
  const after = rows.findIndex(row => isElement(row, 'row') && Number(getAttr(row, 'r')) >= rowNumber)
  const existing = after >= 0 && Number(getAttr(rows[after]!, 'r')) === rowNumber ? rows[after]! : undefined
  if (existing) { dropAttr(existing, 'spans'); return existing }
  const row = element(prefix + 'row', { r: String(rowNumber) })
  rows.splice(after < 0 ? rows.length : after, 0, row)
  return row
}
export function placeCell(row: Element, at: Position, make: (current: Element | undefined) => Element): void {
  const cells = kids(row)
  const after = cells.findIndex(cell => isElement(cell, 'c') && position(getAttr(cell, 'r')!).column >= at.column)
  const current = after >= 0 && position(getAttr(cells[after]!, 'r')!).column === at.column ? cells[after] : undefined
  if (current) cells[after] = make(current)
  else cells.splice(after < 0 ? cells.length : after, 0, make(undefined))
}
export const inside = (range: string, at: Position): boolean => { const { first, last } = parseRange(range); return at.row >= first.row && at.row <= last.row && at.column >= first.column && at.column <= last.column }
export function refuseProtected(outline: OutlinedSheet, arrays: readonly string[], change: Pick<CellChange, 'cell'>, at: Position): void {
  const merged = outline.merged.find(range => inside(range, at))
  if (merged && cellRef(parseRange(merged).first) !== change.cell) throw targetError(`${change.cell} is inside merged range ${merged}; edit its first cell`)
  for (const table of outline.tables) if (inside(table.ref, at) && at.row === parseRange(table.ref).first.row) throw targetError(`${change.cell} is a header of table ${table.name}; table headers cannot be edited here`)
  if (arrays.some(range => inside(range, at))) throw targetError(`${change.cell} belongs to an array formula, which cannot be edited here`)
}
/** Turn a shared formula into plain ones so its anchor cell can change without breaking the cells that repeat it. */
export function expandShared(cells: readonly Cell[], tree: readonly Element[], targets: ReadonlySet<string>): void {
  const formulas = new Map(cells.map(cell => [cell.ref, cell.formula]))
  const anchors = deep(tree, 'c').filter(node => targets.has(getAttr(node, 'r')!) && find(kids(node), 'f') !== undefined && getAttr(find(kids(node), 'f')!, 't') === 'shared' && textOf(find(kids(node), 'f')!) !== '')
  for (const anchor of anchors) {
    const group = getAttr(find(kids(anchor), 'f')!, 'si')
    for (const node of deep(tree, 'c')) {
      const formula = find(kids(node), 'f')
      if (!formula || getAttr(formula, 't') !== 'shared' || getAttr(formula, 'si') !== group) continue
      const known = formulas.get(getAttr(node, 'r')!)
      if (!known) throw targetError(`${getAttr(anchor, 'r')} anchors a shared formula that cannot be expanded`)
      for (const name of ['t', 'si', 'ref']) dropAttr(formula, name)
      kids(formula).splice(0, Infinity, textNode(known))
    }
  }
}
export function growDimension(worksheet: Element, changed: readonly Position[]): void {
  const dimension = find(kids(worksheet), 'dimension')
  if (!dimension) return
  const ref = getAttr(dimension, 'ref')
  if (!ref) return
  const { first, last } = parseRange(ref)
  const row = Math.max(last.row, ...changed.map(item => item.row))
  const column = Math.max(last.column, ...changed.map(item => item.column))
  setAttr(dimension, 'ref', cellRef(first) + ':' + cellRef({ row, column }))
}
/** Parts that stay correct only if Excel rebuilds them, plus the flag that makes it calculate on opening. */
export function refreshParts(office: OfficePackage, changes: Map<string, Uint8Array | undefined>): void {
  const tree = parseTree(office.source('xl/workbook.xml'))
  const workbook = require(tree, 'workbook')
  const list = kids(workbook)
  let calculation = find(list, 'calcPr')
  if (!calculation) {
    calculation = element(prefixOf(tagOf(workbook)) + 'calcPr')
    const before = ['definedNames', 'externalReferences', 'functionGroups', 'sheets'].map(name => list.findIndex(node => isElement(node, name))).find(index => index >= 0)
    if (before === undefined) fail('Workbook has no sheets')
    list.splice(before + 1, 0, calculation)
  }
  setAttr(calculation, 'fullCalcOnLoad', '1')
  changes.set('xl/workbook.xml', buildTree(tree))
  if (!office.has('xl/calcChain.xml')) return
  changes.set('xl/calcChain.xml', undefined)
  const types = parseTree(office.source('[Content_Types].xml'))
  const declared = kids(require(types, 'Types'))
  declared.splice(0, Infinity, ...declared.filter(node => getAttr(node, 'PartName') !== '/xl/calcChain.xml'))
  changes.set('[Content_Types].xml', buildTree(types))
  const relationsPath = 'xl/_rels/workbook.xml.rels'
  const relations = parseTree(office.source(relationsPath))
  const links = kids(require(relations, 'Relationships'))
  links.splice(0, Infinity, ...links.filter(node => !getAttr(node, 'Type')?.endsWith('/calcChain')))
  changes.set(relationsPath, buildTree(relations))
}
export function reaches(office: OfficePackage, book: Book): boolean {
  if (office.names().some(name => name.startsWith('xl/externalLinks/') || name === 'xl/connections.xml')) return true
  if (deep(parseTree(office.source('xl/workbook.xml')), 'definedName').some(name => reachesOutside(textOf(name)))) return true
  return book.sheets.some(sheet => sheetCells(book, sheet).some(cell => cell.formula !== undefined && reachesOutside(cell.formula)))
}
const countFormulas = (book: Book): number => book.sheets.reduce((total, sheet) => total + sheetCells(book, sheet).filter(cell => cell.formula !== undefined).length, 0)
/**
 * Store calculated results beside the formulas, and report what they came to. LibreOffice's own copy
 * of the workbook is only read: delivering it would replace the original's styles and parts with its own.
 * @param calculate - the engine, or undefined when this file must not reach it.
 */
export async function settleWorkbook(bytes: Uint8Array, limit: number, calculate: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly check: WorkbookCheck }> {
  const office = OfficePackage.open(bytes, limit, signal, true)
  const book = openBook(office)
  const parts = new Map<string, Uint8Array | undefined>()
  refreshParts(office, parts)
  const formulas = countFormulas(book)
  const skipped = (reason: string) => ({ bytes: office.rewrite(parts), check: { recalculated: false, reason, formulas, errors: [], errorCount: 0, unverified: [] } })
  if (!calculate) return skipped('Temporary Chat keeps files in memory; Excel calculates the formulas when the file opens')
  if (!formulas) return { bytes: office.rewrite(parts), check: { recalculated: true, formulas, errors: [], errorCount: 0, unverified: [] } }
  if (reaches(office, book)) return skipped('The workbook has external links or network functions, so it was not calculated here')
  let calculated: Uint8Array
  try { calculated = await calculate(office.rewrite(parts)) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof PersonalChatError && error.reason === 'office-render') return skipped('The Office engine could not calculate this workbook; Excel calculates the formulas when the file opens')
    throw error
  }
  const fresh = openBook(OfficePackage.open(calculated, limit, signal))
  const errors: { sheet: string; cell: string; value: string }[] = []
  const unverified: { sheet: string; cell: string }[] = []
  let errorCount = 0
  for (const sheet of book.sheets) {
    const results = new Map(sheetCells(fresh, findSheet(fresh, sheet.name)).map(cell => [cell.ref, cell]))
    const tree = parseTree(office.source(sheet.part))
    for (const node of deep(tree, 'c')) {
      const formula = find(kids(node), 'f')
      if (!formula) continue
      const ref = getAttr(node, 'r')!
      const result = results.get(ref)
      if (!result) continue
      if (result.type === 'e' && result.raw === '#NAME?') { unverified.push({ sheet: sheet.name, cell: ref }); continue }
      if (result.type === 'e') { errorCount++; errors.push({ sheet: sheet.name, cell: ref, value: result.raw }) }
      const list = kids(node)
      const stored = find(list, 'v')
      const value = element(prefixOf(tagOf(formula)) + 'v', {}, [{ '#text': escapeXml(result.raw) }])
      if (stored) list[list.indexOf(stored)] = value
      else list.splice(list.indexOf(formula) + 1, 0, value)
      if (result.type === 'n') dropAttr(node, 't')
      else setAttr(node, 't', result.type === 'b' || result.type === 'e' ? result.type : 'str')
    }
    parts.set(sheet.part, buildTree(tree))
  }
  return { bytes: office.rewrite(parts), check: { recalculated: true, formulas, errors: errors.slice(0, REPORTED_CELLS), errorCount, unverified: unverified.slice(0, REPORTED_CELLS) } }
}
