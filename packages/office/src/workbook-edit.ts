/**
 * Change an existing workbook in place: cell values, looks, merged ranges, column widths, row heights,
 * rows added below the data, and new sheets. Every part the changes do not reach keeps its exact content.
 */
import type { CellFormat, TouchedRange, WorkbookCell, WorkbookChanges } from 'dsh-beluga'
import { OfficePackage, fail } from './package.ts'
import { all, buildTree, deep, element, escapeXml, find, getAttr, isElement, kids, localName, parseTree, prefixOf, require, setAttr, tagOf, type Element } from './tree.ts'
import { BUILT_IN_FORMATS, cellRef, columnNumber, findSheet, openBook, outlineSheet, parseRange, position, related, sheetCells, targetError, translateFormula, type Book, type Cell, type OutlinedSheet, type Position } from './workbook.ts'
import { cellNode, expandShared, growDimension, placeCell, placeRow, refreshParts, refuseProtected } from './workbook-write.ts'

const MAX_ROW = 1048576
/** Cells one call may give a look; a larger range is almost always a whole column named by mistake. */
const MAX_FORMATTED_CELLS = 50000
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const SHEET_RELATION = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
/** Worksheet children that come after `mergeCells`. */
const AFTER_MERGES = new Set(['phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'])
const VERTICAL = { top: 'top', middle: 'center', bottom: 'bottom' } as const
const argb = (hex: string): string => 'FF' + hex.replace('#', '').toUpperCase()
const overlaps = (a: string, b: string): boolean => { const x = parseRange(a); const y = parseRange(b); return x.first.row <= y.last.row && x.last.row >= y.first.row && x.first.column <= y.last.column && x.last.column >= y.first.column }
const normal = (range: string): string => { const { first, last } = parseRange(range); return cellRef(first) + ':' + cellRef(last) }

/** Adds cell styles to the workbook's style sheet, reusing one that already says the same. */
export class StyleWriter {
  private tree?: Element[]
  private readonly derived = new Map<string, string>()
  private date?: string
  constructor(private readonly book: Book) {}
  private sheet(): Element {
    if (!this.tree) {
      if (!this.book.office.has('xl/styles.xml')) throw targetError('This workbook has no styles part, so its cells cannot take a date or a look')
      this.tree = parseTree(this.book.office.source('xl/styles.xml'))
    }
    return require(this.tree, 'styleSheet')
  }
  /** @returns the index of a group's item that equals this one, adding it when there is none. */
  private add(group: string, node: Element): number {
    const holder = require(kids(this.sheet()), group)
    const list = kids(holder)
    const tag = localName(tagOf(node))
    const text = JSON.stringify(node)
    const same = all(list, tag).findIndex(item => JSON.stringify(item) === text)
    if (same >= 0) return same
    list.push(node)
    setAttr(holder, 'count', String(all(list, tag).length))
    return all(list, tag).length - 1
  }
  private items(group: string, item: string): Element[] { return all(kids(require(kids(this.sheet()), group)), item) }
  /** A style index for a date cell: the cell's own when it already shows a date, or a plain date style added to the workbook. */
  dateStyle(current: string | undefined): string {
    if (current !== undefined && this.book.dateStyles.has(Number(current))) return current
    this.date ??= String(this.add('cellXfs', element(prefixOf(tagOf(this.sheet())) + 'xf', { numFmtId: '14', fontId: '0', fillId: '0', borderId: '0', xfId: '0', applyNumberFormat: '1' })))
    return this.date
  }
  private numberFormat(code: string): string {
    const builtIn = Object.entries(BUILT_IN_FORMATS).find(([, known]) => known === code)
    if (builtIn) return builtIn[0]
    const sheet = this.sheet()
    const prefix = prefixOf(tagOf(sheet))
    let holder = find(kids(sheet), 'numFmts')
    if (!holder) { holder = element(prefix + 'numFmts', { count: '0' }); kids(sheet).unshift(holder) }
    const list = kids(holder)
    const escaped = escapeXml(code)
    const same = all(list, 'numFmt').find(item => getAttr(item, 'formatCode') === escaped)
    if (same) return getAttr(same, 'numFmtId')!
    // Ids below 164 are Excel's own.
    const id = String(all(list, 'numFmt').reduce((highest, item) => Math.max(highest, Number(getAttr(item, 'numFmtId'))), 163) + 1)
    list.push(element(prefix + 'numFmt', { numFmtId: id, formatCode: escaped }))
    setAttr(holder, 'count', String(all(list, 'numFmt').length))
    return id
  }
  /** @returns the index of a style that is the cell's current one with this look laid over it. */
  derive(current: string | undefined, format: CellFormat): string {
    const key = (current ?? '0') + JSON.stringify(format)
    const known = this.derived.get(key)
    if (known !== undefined) return known
    const styles = this.items('cellXfs', 'xf')
    const source = styles[Number(current ?? 0)] ?? styles[0]
    if (!source) throw targetError('This workbook\'s styles part has no cell styles to build on')
    const style = structuredClone(source)
    const prefix = prefixOf(tagOf(style))
    if (['font', 'size', 'bold', 'italic', 'underline', 'color'].some(name => name in format)) {
      const font = structuredClone(this.items('fonts', 'font')[Number(getAttr(style, 'fontId') ?? 0)] ?? element(prefix + 'font'))
      const list = kids(font)
      const set = (name: string, attrs: Record<string, string> | undefined) => {
        list.splice(0, Infinity, ...list.filter(node => !isElement(node, name)))
        if (attrs) list.push(element(prefix + name, attrs))
      }
      // A font that follows the theme takes its name from the theme, whatever name it carries.
      if (format.font !== undefined) { set('name', { val: escapeXml(format.font) }); set('scheme', undefined) }
      if (format.size !== undefined) set('sz', { val: String(format.size) })
      if (format.bold !== undefined) set('b', format.bold ? {} : undefined)
      if (format.italic !== undefined) set('i', format.italic ? {} : undefined)
      if (format.underline !== undefined) set('u', format.underline ? {} : undefined)
      if (format.color !== undefined) set('color', { rgb: argb(format.color) })
      setAttr(style, 'fontId', String(this.add('fonts', font)))
      setAttr(style, 'applyFont', '1')
    }
    if (format.fill !== undefined) {
      const fill = format.fill === 'none' ? 0 : this.add('fills', element(prefix + 'fill', {}, [element(prefix + 'patternFill', { patternType: 'solid' }, [element(prefix + 'fgColor', { rgb: argb(format.fill) }), element(prefix + 'bgColor', { indexed: '64' })])]))
      setAttr(style, 'fillId', String(fill))
      setAttr(style, 'applyFill', '1')
    }
    if (format.border !== undefined) {
      const side = (name: string) => element(prefix + name, { style: 'thin' }, [element(prefix + 'color', { auto: '1' })])
      const border = format.border === 'none' ? 0 : this.add('borders', element(prefix + 'border', {}, [side('left'), side('right'), side('top'), side('bottom'), element(prefix + 'diagonal')]))
      setAttr(style, 'borderId', String(border))
      setAttr(style, 'applyBorder', '1')
    }
    if (format.numberFormat !== undefined) {
      setAttr(style, 'numFmtId', this.numberFormat(format.numberFormat))
      setAttr(style, 'applyNumberFormat', '1')
    }
    if (format.align !== undefined || format.valign !== undefined || format.wrap !== undefined) {
      const list = kids(style)
      let alignment = find(list, 'alignment')
      if (!alignment) { alignment = element(prefix + 'alignment'); list.unshift(alignment) }
      if (format.align !== undefined) setAttr(alignment, 'horizontal', format.align)
      if (format.valign !== undefined) setAttr(alignment, 'vertical', VERTICAL[format.valign])
      if (format.wrap !== undefined) setAttr(alignment, 'wrapText', format.wrap ? '1' : '0')
      setAttr(style, 'applyAlignment', '1')
    }
    const index = String(this.add('cellXfs', style))
    this.derived.set(key, index)
    return index
  }
  part(): Uint8Array | undefined { return this.tree && buildTree(this.tree) }
}

/** Give columns `first` to `last` one width, splitting any stored span that reaches past them so its other columns keep theirs. */
function setColumnWidths(worksheet: Element, prefix: string, first: number, last: number, width: number): void {
  const list = kids(worksheet)
  let holder = find(list, 'cols')
  if (!holder) {
    holder = element(prefix + 'cols')
    list.splice(list.findIndex(node => isElement(node, 'sheetData')), 0, holder)
  }
  const span = (column: Element, min: number, max: number): Element => { const copy = structuredClone(column); setAttr(copy, 'min', String(min)); setAttr(copy, 'max', String(max)); return copy }
  const sized = (column: Element): Element => { setAttr(column, 'width', String(width)); setAttr(column, 'customWidth', '1'); return column }
  const next: Element[] = []
  const covered: [number, number][] = []
  for (const column of all(kids(holder), 'col')) {
    const min = Number(getAttr(column, 'min'))
    const max = Number(getAttr(column, 'max'))
    if (max < first || min > last) { next.push(column); continue }
    if (min < first) next.push(span(column, min, first - 1))
    next.push(sized(span(column, Math.max(min, first), Math.min(max, last))))
    covered.push([Math.max(min, first), Math.min(max, last)])
    if (max > last) next.push(span(column, last + 1, max))
  }
  let at = first
  for (const [min, max] of covered.sort((a, b) => a[0] - b[0])) {
    if (min > at) next.push(sized(element(prefix + 'col', { min: String(at), max: String(min - 1) })))
    at = max + 1
  }
  if (at <= last) next.push(sized(element(prefix + 'col', { min: String(at), max: String(last) })))
  next.sort((a, b) => Number(getAttr(a, 'min')) - Number(getAttr(b, 'min')))
  kids(holder).splice(0, Infinity, ...next)
}
/** Merge a range, or split one that is merged. A merged range shows only its first cell, so the others must be empty. */
function setMerge(worksheet: Element, prefix: string, cells: readonly Cell[], outline: OutlinedSheet, range: string, merge: boolean): void {
  const wanted = normal(range)
  const list = kids(worksheet)
  let holder = find(list, 'mergeCells')
  const existing = holder ? all(kids(holder), 'mergeCell') : []
  const same = existing.find(item => normal(getAttr(item, 'ref')!) === wanted)
  if (!merge) {
    if (!same) throw targetError(`${range} is not a merged range. This sheet's merged ranges: ${outline.merged.join(', ') || 'none'}`)
    kids(holder!).splice(kids(holder!).indexOf(same), 1)
    if (existing.length === 1) list.splice(list.indexOf(holder!), 1)
    else setAttr(holder!, 'count', String(existing.length - 1))
    return
  }
  if (same) return
  const { first, last } = parseRange(range)
  if (first.row === last.row && first.column === last.column) throw targetError(`${range} is one cell; a merge needs a range`)
  const crossing = existing.find(item => overlaps(getAttr(item, 'ref')!, wanted))
  if (crossing) throw targetError(`${range} overlaps merged range ${getAttr(crossing, 'ref')}; split that one first`)
  const table = outline.tables.find(item => overlaps(item.ref, wanted))
  if (table) throw targetError(`${range} reaches into table ${table.name}, whose cells cannot be merged`)
  const filled = cells.find(cell => cell.row >= first.row && cell.row <= last.row && cell.column >= first.column && cell.column <= last.column && (cell.row !== first.row || cell.column !== first.column) && (cell.raw !== '' || cell.formula !== undefined))
  if (filled) throw targetError(`${filled.ref} holds a value, and a merged range keeps only its first cell; clear or move it first`)
  if (!holder) {
    holder = element(prefix + 'mergeCells')
    const after = list.findIndex(node => AFTER_MERGES.has(localName(tagOf(node))))
    list.splice(after < 0 ? list.length : after, 0, holder)
  }
  kids(holder).push(element(prefix + 'mergeCell', { ref: wanted }))
  setAttr(holder, 'count', String(existing.length + 1))
}
/**
 * Write rows below the last row that holds a value. Each new cell takes the style of the cell above it,
 * and a cell given no value takes the formula above it, moved down.
 * A table or filter that ended on that last row grows to hold the new rows.
 * @returns the cells written.
 */
function appendRows(book: Book, sheet: { readonly part: string; readonly name: string }, worksheet: Element, rows: Element[], prefix: string, cells: readonly Cell[], added: readonly (readonly WorkbookCell[])[], styles: StyleWriter, parts: Map<string, Uint8Array | undefined>): Position[] {
  let lastRow = 0
  for (const cell of cells) if ((cell.raw !== '' || cell.formula !== undefined) && cell.row > lastRow) lastRow = cell.row
  if (lastRow + added.length > MAX_ROW) throw targetError('The sheet has no room for these rows')
  const above = new Map(cells.filter(cell => cell.row === lastRow).map(cell => [cell.column, cell]))
  const widest = Math.max(0, ...above.keys())
  const written: Position[] = []
  added.forEach((values, offset) => {
    const row = placeRow(rows, lastRow + 1 + offset, prefix)
    for (let column = 1; column <= Math.max(values.length, widest); column++) {
      const model = above.get(column)
      const at = { row: lastRow + 1 + offset, column }
      let value: WorkbookCell = values[column - 1] ?? null
      if (value === null && model?.formula) { const moved = translateFormula(model.formula, model, at); if (moved !== undefined) value = { formula: moved } }
      const style = model?.style === undefined ? undefined : String(model.style)
      if (value === null && style === undefined) continue
      const isDate = value !== null && typeof value === 'object' && 'date' in value
      placeCell(row, at, () => cellNode(prefix, cellRef(at), isDate ? styles.dateStyle(style) : style, value))
      written.push(at)
    }
  })
  const grown = (ref: string): string | undefined => { const range = parseRange(ref); return lastRow > 0 && range.last.row === lastRow ? cellRef(range.first) + ':' + cellRef({ row: lastRow + added.length, column: range.last.column }) : undefined }
  const filter = find(kids(worksheet), 'autoFilter')
  const filterRef = filter && getAttr(filter, 'ref') ? grown(getAttr(filter, 'ref')!) : undefined
  if (filter && filterRef) setAttr(filter, 'ref', filterRef)
  for (const part of related(book, sheet, 'table')) {
    const tree = parseTree(book.office.source(part))
    const table = require(tree, 'table')
    const ref = grown(getAttr(table, 'ref') ?? '')
    if (!ref) continue
    if (Number(getAttr(table, 'totalsRowCount') ?? 0) > 0) throw targetError(`Table ${getAttr(table, 'displayName') ?? ''} ends with a totals row, so rows cannot be added below it here; change its cells instead`)
    setAttr(table, 'ref', ref)
    const own = find(kids(table), 'autoFilter')
    if (own) setAttr(own, 'ref', ref)
    parts.set(part, buildTree(tree))
  }
  return written
}
/** @returns the package with empty sheets added after the existing ones. */
function addSheets(office: OfficePackage, names: readonly string[]): Uint8Array {
  const parts = new Map<string, Uint8Array | undefined>()
  const main = parseTree(office.source('xl/workbook.xml'))
  const sheets = require(kids(require(main, 'workbook')), 'sheets')
  const entries = all(kids(sheets), 'sheet')
  const taken = new Set(entries.map(entry => (getAttr(entry, 'name') ?? '').toLowerCase()))
  const relationsPath = 'xl/_rels/workbook.xml.rels'
  const relations = parseTree(office.source(relationsPath))
  const links = kids(require(relations, 'Relationships'))
  const types = parseTree(office.source('[Content_Types].xml'))
  const declared = kids(require(types, 'Types'))
  // The relationship attribute keeps the prefix this workbook already gives it.
  const idKey = Object.keys((entries[0]?.[':@'] ?? {}) as Record<string, string>).find(key => key.endsWith(':id'))?.slice(2) ?? fail('Workbook has no sheets')
  let sheetId = entries.reduce((highest, entry) => Math.max(highest, Number(getAttr(entry, 'sheetId'))), 0)
  let relationId = links.reduce((highest, link) => Math.max(highest, Number(/^rId(\d+)$/u.exec(getAttr(link, 'Id') ?? '')?.[1] ?? 0)), 0)
  let file = 0
  for (const name of names) {
    if (taken.has(name.toLowerCase())) throw targetError(`This workbook already has a sheet named ${JSON.stringify(name)}`)
    taken.add(name.toLowerCase())
    do file++; while (office.has(`xl/worksheets/sheet${file}.xml`) || parts.has(`xl/worksheets/sheet${file}.xml`))
    const path = `xl/worksheets/sheet${file}.xml`
    parts.set(path, new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'))
    kids(sheets).push(element(prefixOf(tagOf(sheets)) + 'sheet', { name: escapeXml(name), sheetId: String(++sheetId), [idKey]: 'rId' + ++relationId }))
    links.push(element(prefixOf(tagOf(links[0] ?? {})) + 'Relationship', { Id: 'rId' + relationId, Type: SHEET_RELATION, Target: `worksheets/sheet${file}.xml` }))
    declared.push(element(prefixOf(tagOf(declared[0] ?? {})) + 'Override', { PartName: '/' + path, ContentType: SHEET_TYPE }))
  }
  parts.set('xl/workbook.xml', buildTree(main))
  parts.set(relationsPath, buildTree(relations))
  parts.set('[Content_Types].xml', buildTree(types))
  return office.rewrite(parts)
}
const box = (positions: readonly Position[]): string => {
  let top = Infinity; let left = Infinity; let bottom = 0; let right = 0
  for (const { row, column } of positions) { top = Math.min(top, row); left = Math.min(left, column); bottom = Math.max(bottom, row); right = Math.max(right, column) }
  return cellRef({ row: top, column: left }) + ':' + cellRef({ row: bottom, column: right })
}
/**
 * @param limit - bound on the inflated package.
 * @returns the workbook, and the rectangle written on each sheet.
 */
export function editWorkbook(bytes: Uint8Array, edit: Omit<WorkbookChanges, 'structure'>, limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly touched: readonly TouchedRange[] } {
  signal.throwIfAborted()
  const office = OfficePackage.open(edit.sheets?.length ? addSheets(OfficePackage.open(bytes, limit, signal, true), edit.sheets.map(sheet => sheet.name)) : bytes, limit, signal, true)
  const book = openBook(office)
  const seen = new Set<string>()
  for (const change of edit.changes) {
    const key = change.sheet + '\u0000' + change.cell
    if (seen.has(key)) throw targetError(`${change.cell} on ${change.sheet} is changed twice`)
    seen.add(key)
  }
  const styles = new StyleWriter(book)
  const parts = new Map<string, Uint8Array | undefined>()
  const touched: TouchedRange[] = []
  const lists = [edit.changes, edit.append ?? [], edit.formats ?? [], edit.merges ?? [], edit.columnWidths ?? [], edit.rowHeights ?? []]
  let formatted = 0
  for (const name of new Set(lists.flatMap(list => list.map(item => item.sheet)))) {
    const sheet = findSheet(book, name)
    const here = <T extends { readonly sheet: string }>(list: readonly T[] | undefined): T[] => (list ?? []).filter(item => item.sheet === name)
    const cells = sheetCells(book, sheet)
    const outline = outlineSheet(book, sheet, cells)
    const tree = parseTree(office.source(sheet.part))
    const worksheet = require(tree, 'worksheet')
    const prefix = prefixOf(tagOf(worksheet))
    const rows = kids(require(kids(worksheet), 'sheetData'))
    const written: Position[] = []
    const changes = here(edit.changes)
    expandShared(cells, tree, new Set(changes.map(change => change.cell)))
    const arrays = deep(tree, 'f').flatMap(formula => { const range = getAttr(formula, 'ref'); return getAttr(formula, 't') === 'array' && range ? [range] : [] })
    for (const change of changes) {
      const at = position(change.cell)
      refuseProtected(outline, arrays, change, at)
      placeCell(placeRow(rows, at.row, prefix), at, current => {
        const style = current && getAttr(current, 's')
        const isDate = change.value !== null && typeof change.value === 'object' && 'date' in change.value
        return cellNode(prefix, change.cell, isDate ? styles.dateStyle(style) : style, change.value)
      })
      written.push(at)
    }
    for (const item of here(edit.append)) written.push(...appendRows(book, sheet, worksheet, rows, prefix, cells, item.rows, styles, parts))
    for (const item of here(edit.formats)) {
      const { first, last } = parseRange(item.range)
      formatted += (last.row - first.row + 1) * (last.column - first.column + 1)
      if (formatted > MAX_FORMATTED_CELLS) throw targetError(`One call gives a look to at most ${MAX_FORMATTED_CELLS} cells; name the cells that hold data instead of whole rows or columns`)
      for (let row = first.row; row <= last.row; row++) {
        const line = placeRow(rows, row, prefix)
        for (let column = first.column; column <= last.column; column++) placeCell(line, { row, column }, current => {
          const node = current ?? element(prefix + 'c', { r: cellRef({ row, column }) })
          setAttr(node, 's', styles.derive(getAttr(node, 's'), item.format))
          return node
        })
      }
      written.push(first, last)
    }
    for (const item of here(edit.merges)) { setMerge(worksheet, prefix, cells, outline, item.range, item.merge); written.push(parseRange(item.range).first, parseRange(item.range).last) }
    for (const item of here(edit.columnWidths)) {
      const [from, to = from] = item.columns.split(':')
      setColumnWidths(worksheet, prefix, Math.min(columnNumber(from!), columnNumber(to!)), Math.max(columnNumber(from!), columnNumber(to!)), item.width)
    }
    for (const item of here(edit.rowHeights)) {
      const [from, to = from] = item.rows.split(':').map(Number)
      if (Math.abs(to! - from!) >= 10000) throw targetError('One call sets the height of at most 10000 rows')
      for (let row = Math.min(from!, to!); row <= Math.max(from!, to!); row++) { const line = placeRow(rows, row, prefix); setAttr(line, 'ht', String(item.height)); setAttr(line, 'customHeight', '1') }
    }
    if (written.length) { growDimension(worksheet, written); touched.push({ sheet: name, range: box(written) }) }
    parts.set(sheet.part, buildTree(tree))
  }
  const styleSheet = styles.part()
  if (styleSheet) parts.set('xl/styles.xml', styleSheet)
  refreshParts(office, parts)
  return { bytes: office.rewrite(parts), touched }
}
