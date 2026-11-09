/** Read a workbook as typed cells: values as last saved, formulas beside them. */
import { PersonalChatError } from 'dsh-beluga'
import type { SheetCell, SheetRange } from 'dsh-beluga'
import { attr, children, content, descendants, text, relationshipId, type Node, type OfficePackage } from './package.ts'

/** Rows of each sheet shown when a workbook is first read; read_sheet reaches the rest. */
const SAMPLE_ROWS = 20
const MAX_READ_ROWS = 500
const MAX_ROW = 1048576
const MAX_COLUMN = 16384
const DAY_MS = 86400000
/** Built-in number formats that mean a date or time, including the East Asian ones. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
/** Built-in number formats by id, as Excel reads them; dates, times, currency and accounting are left out, since they follow the locale. */
const BUILT_IN_FORMATS: Readonly<Record<number, string>> = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)', 48: '##0.0E+0', 49: '@' }

export interface Position { readonly row: number; readonly column: number }
export const targetError = (message: string): PersonalChatError => new PersonalChatError('workbook-target', message)
export function columnNumber(name: string): number { let total = 0; for (const letter of name) total = total * 26 + letter.charCodeAt(0) - 64; return total }
export function columnName(column: number): string {
  let name = ''
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + (rest - 1) % 26) + name
  return name
}
export const cellRef = ({ row, column }: Position): string => columnName(column) + row
export function position(ref: string): Position {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/u.exec(ref)
  const value = match ? { row: Number(match[2]), column: columnNumber(match[1]!) } : undefined
  if (!value || value.row > MAX_ROW || value.column > MAX_COLUMN) throw targetError('Use a cell reference such as B2')
  return value
}
export function parseRange(range: string): { readonly first: Position; readonly last: Position } {
  const [start, end = start, extra] = range.split(':')
  if (extra !== undefined) throw targetError('Use a range such as A1:C20')
  const a = position(start!)
  const b = position(end)
  return { first: { row: Math.min(a.row, b.row), column: Math.min(a.column, b.column) }, last: { row: Math.max(a.row, b.row), column: Math.max(a.column, b.column) } }
}
/**
 * Move a formula's relative references the way a shared formula repeats down a column.
 * @returns the formula at its new cell, or undefined when its references cannot be moved safely.
 */
export function translateFormula(formula: string, from: Position, to: Position): string | undefined {
  if (/(?:^|[^\w$.])\$?(?:[A-Z]{1,3}:\$?[A-Z]{1,3}|\d+:\$?\d+)(?![\w(])/u.test(formula)) return undefined
  let safe = true
  const moved = formula.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![\w(.])|[A-Za-z_][\w.]*/gu, (token, columnFixed: string | undefined, column: string | undefined, rowFixed: string | undefined, row: string | undefined) => {
    if (column === undefined) return token
    const nextColumn = columnNumber(column) + (columnFixed ? 0 : to.column - from.column)
    const nextRow = Number(row) + (rowFixed ? 0 : to.row - from.row)
    if (nextColumn < 1 || nextRow < 1 || nextColumn > MAX_COLUMN || nextRow > MAX_ROW) safe = false
    return columnFixed! + columnName(nextColumn) + rowFixed + nextRow
  })
  return safe ? moved : undefined
}
export interface Cell extends Position {
  readonly ref: string
  /** The stored `t` attribute; a plain number has `n`. */
  readonly type: string
  /** Text of `<v>`, or the resolved string for a shared or inline string. */
  readonly raw: string
  readonly formula?: string
  /** Set on the cell that holds the text of a shared formula. */
  readonly sharedAnchor?: boolean
  /** Set on a cell inside a shared or array formula. */
  readonly formulaKind?: string
  /** Index of the cell's style, when it is not the default one. */
  readonly style?: number
  readonly value: SheetCell
}
export interface SheetEntry { readonly name: string; readonly state: string; readonly part: string }
export interface Book {
  readonly office: OfficePackage
  readonly sheets: readonly SheetEntry[]
  readonly strings: readonly string[]
  readonly dateStyles: ReadonlySet<number>
  /** Number format code of each cell style, by index; a style missing here is General. */
  readonly formats: readonly string[]
  readonly date1904: boolean
}
function stylesOf(office: OfficePackage): Pick<Book, 'dateStyles' | 'formats'> {
  const dateStyles = new Set<number>()
  const formats: string[] = []
  if (!office.has('xl/styles.xml')) return { dateStyles, formats }
  const root = office.xml('xl/styles.xml')
  const custom = new Map(descendants(root, 'numFmt').map(format => [Number(attr(format, 'numFmtId')), attr(format, 'formatCode')]))
  const isDate = (id: number): boolean => DATE_FORMATS.has(id) || /[ymdhs]/iu.test((custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./gu, ''))
  const styles = descendants(root, 'cellXfs')[0]
  if (styles) children(styles, 'xf').forEach((style, index) => {
    const id = Number(attr(style, 'numFmtId'))
    if (isDate(id)) dateStyles.add(index)
    formats[index] = custom.get(id) ?? BUILT_IN_FORMATS[id] ?? 'General'
  })
  return { dateStyles, formats }
}
export function openBook(office: OfficePackage): Book {
  const main = 'xl/workbook.xml'
  const relations = office.relationships(main)
  const root = office.xml(main)
  const sheets = descendants(root, 'sheet').map(sheet => ({ name: attr(sheet, 'name'), state: attr(sheet, 'state') || 'visible', part: office.target(main, relations.find(relation => attr(relation, 'Id') === relationshipId(sheet))) }))
  const flag = descendants(root, 'workbookPr')[0]
  return {
    office, sheets,
    strings: office.has('xl/sharedStrings.xml') ? descendants(office.xml('xl/sharedStrings.xml'), 'si').map(content) : [],
    ...stylesOf(office),
    date1904: flag ? ['1', 'true'].includes(attr(flag, 'date1904')) : false,
  }
}
/** Sheet serial numbers count days; 1900 dates carry Excel's phantom leap day, so its origin is 1899-12-30. */
function dateText(serial: number, date1904: boolean): string {
  const time = (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + Math.round(serial * DAY_MS)
  const iso = new Date(time).toISOString()
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}
function cellValue(type: string, raw: string, style: number, book: Book): SheetCell {
  if (raw === '' && !['s', 'str', 'inlineStr'].includes(type)) return null
  if (type === 'b') return raw === '1'
  if (type === 'n') {
    const number = Number(raw)
    if (!Number.isFinite(number)) return raw
    return book.dateStyles.has(style) ? dateText(number, book.date1904) : number
  }
  return raw
}
function readCell(node: Node, at: Position, book: Book, shared: Map<string, { formula: string; origin: Position }>): Cell {
  const type = attr(node, 't') || 'n'
  const stored = children(node, 'v').map(text).join('')
  let raw = type === 'inlineStr' ? content(node) : stored
  if (type === 's') {
    const resolved = /^\d+$/u.test(stored) ? book.strings[Number(stored)] : undefined
    if (resolved === undefined) throw new PersonalChatError('invalid-office', 'Invalid shared string reference')
    raw = resolved
  }
  const formula = children(node, 'f')[0]
  const kind = formula && attr(formula, 't')
  let source: string | undefined = formula && text(formula)
  let sharedAnchor = false
  if (formula && kind === 'shared') {
    const group = attr(formula, 'si')
    if (source) { shared.set(group, { formula: source, origin: at }); sharedAnchor = true }
    else {
      const master = shared.get(group)
      source = master && translateFormula(master.formula, master.origin, at)
    }
  }
  const style = Number(attr(node, 's')) || 0
  return { ...at, ref: cellRef(at), type, raw, value: cellValue(type, raw, style, book), ...(formula ? { formula: source ?? '' } : {}), ...(sharedAnchor ? { sharedAnchor } : {}), ...(kind ? { formulaKind: kind } : {}), ...(style ? { style } : {}) }
}
export function sheetCells(book: Book, sheet: SheetEntry): Cell[] {
  const cells: Cell[] = []
  const shared = new Map<string, { formula: string; origin: Position }>()
  let row = 0
  for (const line of descendants(book.office.xml(sheet.part), 'row')) {
    row = Number(attr(line, 'r')) || row + 1
    let column = 0
    for (const node of children(line, 'c')) {
      const ref = attr(node, 'r')
      column = ref ? position(ref).column : column + 1
      cells.push(readCell(node, { row, column }, book, shared))
    }
  }
  return cells
}
export function findSheet(book: Book, name: string | undefined): SheetEntry {
  const sheet = name === undefined ? book.sheets.find(item => item.state === 'visible') ?? book.sheets[0] : book.sheets.find(item => item.name === name)
  if (!sheet) throw targetError('This workbook has no sheet named ' + JSON.stringify(name) + '. It has: ' + book.sheets.map(item => item.name).join(', '))
  return sheet
}
/** Sheet parts this sheet's relationships lead to, of one kind. */
function related(book: Book, sheet: SheetEntry, kind: string): string[] {
  return book.office.relationships(sheet.part).filter(relation => attr(relation, 'Type').endsWith('/' + kind) && attr(relation, 'TargetMode') !== 'External').map(relation => book.office.target(sheet.part, relation))
}
export interface SheetOutline {
  readonly sheet: string
  readonly state: string
  readonly range: string
  readonly cells: number
  readonly formulas: number
  readonly merged: readonly string[]
  readonly tables: readonly { readonly name: string; readonly ref: string }[]
  readonly charts: number
  readonly images: number
  readonly freeze?: string
}
/** The rectangle a sheet paints, including drawings that sit beyond its data. */
export interface OutlinedSheet extends SheetOutline { readonly extent: Position }
export function outlineSheet(book: Book, sheet: SheetEntry, cells = sheetCells(book, sheet)): OutlinedSheet {
  const root = book.office.xml(sheet.part)
  let row = 1
  let column = 1
  for (const cell of cells) { row = Math.max(row, cell.row); column = Math.max(column, cell.column) }
  const used = cellRef({ row, column })
  let charts = 0
  let images = 0
  for (const drawing of related(book, sheet, 'drawing').map(part => book.office.xml(part))) {
    charts += descendants(drawing, 'graphicFrame').length
    images += descendants(drawing, 'pic').length
    for (const edge of [...descendants(drawing, 'to'), ...descendants(drawing, 'from')]) {
      column = Math.max(column, Number(children(edge, 'col').map(text).join('')) + 1)
      row = Math.max(row, Number(children(edge, 'row').map(text).join('')) + 1)
    }
  }
  const pane = descendants(root, 'pane').find(item => attr(item, 'state') === 'frozen')
  return {
    sheet: sheet.name, state: sheet.state, range: 'A1:' + used, cells: cells.length, formulas: cells.filter(cell => cell.formula !== undefined).length,
    merged: descendants(root, 'mergeCell').map(merge => attr(merge, 'ref')),
    tables: related(book, sheet, 'table').map(part => { const table = descendants(book.office.xml(part), 'table')[0]!; return { name: attr(table, 'displayName') || attr(table, 'name'), ref: attr(table, 'ref') } }),
    charts, images, ...(pane && attr(pane, 'topLeftCell') ? { freeze: attr(pane, 'topLeftCell') } : {}), extent: { row, column },
  }
}
function gridOf(cells: readonly Cell[], sheet: string, first: Position, last: Position, budget: number): SheetRange {
  const byRow = new Map<number, Cell[]>()
  for (const cell of cells) if (cell.row >= first.row && cell.row <= last.row && cell.column >= first.column && cell.column <= last.column) (byRow.get(cell.row) ?? byRow.set(cell.row, []).get(cell.row)!).push(cell)
  const rows: SheetCell[][] = []
  const formulas: Record<string, string> = {}
  let spent = 0
  for (let row = first.row; row <= last.row; row++) {
    const line = new Array<SheetCell>(last.column - first.column + 1).fill(null)
    const added: Record<string, string> = {}
    for (const cell of byRow.get(row) ?? []) {
      line[cell.column - first.column] = cell.value
      if (cell.formula) added[cell.ref] = cell.formula
    }
    spent += JSON.stringify(line).length + JSON.stringify(added).length
    if (rows.length && (spent > budget || rows.length >= MAX_READ_ROWS)) return { sheet, range: cellRef(first) + ':' + cellRef({ row: row - 1, column: last.column }), rows, formulas, nextRange: cellRef({ row, column: first.column }) + ':' + cellRef(last) }
    rows.push(line)
    Object.assign(formulas, added)
  }
  return { sheet, range: cellRef(first) + ':' + cellRef(last), rows, formulas }
}
/** @returns one rectangle of a sheet, at most `budget` characters, and where to continue. */
export function readRange(office: OfficePackage, request: { readonly sheet?: string; readonly range?: string }, budget: number): SheetRange {
  const book = openBook(office)
  const sheet = findSheet(book, request.sheet)
  const cells = sheetCells(book, sheet)
  const { first, last } = parseRange(request.range ?? outlineSheet(book, sheet, cells).range)
  return gridOf(cells, sheet.name, first, last, budget)
}
/** @returns one record per sheet and its first rows, for a first read of the workbook. */
export function workbookRecords(office: OfficePackage): object[] {
  const book = openBook(office)
  const records: object[] = []
  for (const sheet of book.sheets) {
    const cells = sheetCells(book, sheet)
    const { extent: _extent, ...outline } = outlineSheet(book, sheet, cells)
    records.push(outline)
    if (!cells.length) continue
    const { last } = parseRange(outline.range)
    const sample = gridOf(cells, sheet.name, { row: 1, column: 1 }, { row: Math.min(last.row, SAMPLE_ROWS), column: last.column }, Number.MAX_SAFE_INTEGER)
    records.push(last.row > SAMPLE_ROWS ? { ...sample, nextRange: cellRef({ row: SAMPLE_ROWS + 1, column: 1 }) + ':' + cellRef(last) } : sample)
  }
  const names = descendants(office.xml('xl/workbook.xml'), 'definedName').map(name => ({ name: attr(name, 'name'), refersTo: text(name) }))
  if (names.length) records.push({ definedNames: names })
  return records
}
