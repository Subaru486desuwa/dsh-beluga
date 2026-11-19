/**
 * Insert or delete whole rows or columns of a worksheet. Cells move, and everything that refers to them
 * follows: formulas on every sheet, defined names, merged ranges, filters, conditional formats, data
 * validations, hyperlinks, tables, chart series and drawing anchors. A sheet holding something that
 * cannot be made to follow is refused whole, since a reference left behind calculates without any error.
 */
import { PersonalChatError } from 'dsh-beluga'
import type { StructureChange, StructureReport, TouchedRange } from 'dsh-beluga'
import { OfficePackage } from './package.ts'
import { all, buildTree, deep, dropAttr, element, find, getAttr, isElement, kids, parseTree, prefixOf, require, setAttr, tagOf, textNode, textOf, unescapeXml, type Element } from './tree.ts'
import { cellRef, columnName, columnNumber, findSheet, openBook, parseRange, position, related, sheetCells, targetError, translateFormula, type Book, type Cell, type Position, type SheetEntry } from './workbook.ts'
import { placeCell, reaches, refreshParts } from './workbook-write.ts'

const MAX_ROW = 1048576
const MAX_COLUMN = 16384
const REPORTED = 20
/** Functions whose result changes from one calculation to the next, so two calculations of the same workbook differ. */
const VOLATILE = /(?<![\p{L}\p{N}_.])(?:NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY)\s*\(/iu
const refused = (what: string): PersonalChatError => targetError(`Rows and columns cannot be inserted or deleted on this sheet here, because ${what}. Change cell values instead, or ask the user to make this change in Excel`)

/** Whole rows or columns of one sheet that open up at `at`, or go away from `at` on. */
export interface Shift { readonly sheet: string; readonly axis: 'row' | 'column'; readonly at: number; readonly count: number; readonly insert: boolean }
/** @returns where a row or column ends up, or undefined when it is deleted. */
function moved(shift: Shift, index: number): number | undefined {
  if (shift.insert) return index >= shift.at ? index + shift.count : index
  return index < shift.at ? index : index >= shift.at + shift.count ? index - shift.count : undefined
}
/** @returns where a run of rows or columns ends up: it grows around an insertion inside it and closes over a deletion; undefined when all of it is deleted. */
function span(shift: Shift, low: number, high: number): readonly [number, number] | undefined {
  if (shift.insert) return [moved(shift, low)!, moved(shift, high)!]
  const end = shift.at + shift.count - 1
  if (low >= shift.at && high <= end) return undefined
  return [low < shift.at ? low : low > end ? low - shift.count : shift.at, high < shift.at ? high : high > end ? high - shift.count : shift.at - 1]
}
interface Area { readonly first: Position; readonly last: Position }
function shiftArea(shift: Shift, { first, last }: Area): Area | undefined {
  const next = shift.axis === 'row' ? span(shift, first.row, last.row) : span(shift, first.column, last.column)
  if (!next) return undefined
  if (next[1] > (shift.axis === 'row' ? MAX_ROW : MAX_COLUMN)) throw targetError('The sheet has no room for this insertion')
  return shift.axis === 'row' ? { first: { row: next[0], column: first.column }, last: { row: next[1], column: last.column } } : { first: { row: first.row, column: next[0] }, last: { row: last.row, column: next[1] } }
}
const single = ({ first, last }: Area): boolean => first.row === last.row && first.column === last.column
const areaRef = (area: Area): string => single(area) ? cellRef(area.first) : cellRef(area.first) + ':' + cellRef(area.last)
const place = (shift: Shift, at: Position): Position | undefined => {
  const index = moved(shift, shift.axis === 'row' ? at.row : at.column)
  return index === undefined ? undefined : shift.axis === 'row' ? { row: index, column: at.column } : { row: at.row, column: index }
}
/** @returns a cell or range reference after the shift, or undefined when all of it is deleted. */
function shiftRef(shift: Shift, ref: string): string | undefined {
  const area = shiftArea(shift, parseRange(ref.replace(/\$/gu, '')))
  return area && (ref.includes(':') ? cellRef(area.first) + ':' + cellRef(area.last) : areaRef(area))
}
/** A space-separated list of references, as `sqref` attributes hold. @returns the ones that remain, or an empty string. */
const shiftList = (shift: Shift, list: string): string => list.split(/\s+/u).filter(Boolean).flatMap(ref => shiftRef(shift, ref) ?? []).join(' ')

/**
 * One reference, or a token to leave alone: a string, a structured reference, a name or a number.
 * The optional prefix is a sheet name, quoted when it needs to be.
 */
const TOKEN = /"(?:[^"]|"")*"|\[(?:[^[\]]|\[[^\]]*\])*\]|((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(?:(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?|(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})|(\$?)(\d+):(\$?)(\d+))(?![\p{L}\p{N}_.(!])|[\p{L}_\\][\p{L}\p{N}_.\\]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu
const sheetOf = (prefix: string): string => { const name = prefix.slice(0, -1); return name.startsWith('\'') ? name.slice(1, -1).replace(/''/gu, '\'') : name }
/**
 * Make a formula's references to the shifted sheet follow the cells.
 * @param home - the sheet an unprefixed reference means, or undefined where only prefixed ones count.
 * @returns the formula, and whether a reference in it lost all its cells and became `#REF!`.
 */
export function rewriteFormula(formula: string, home: string | undefined, shift: Shift): { readonly formula: string; readonly broken: boolean } {
  let broken = false
  const target = shift.sheet.toLowerCase()
  const rows = shift.axis === 'row'
  const most = rows ? MAX_ROW : MAX_COLUMN
  type Part = string | undefined
  const next = formula.replace(TOKEN, (token: string, prefix: Part, f1: Part, c1: Part, f2: Part, r1: Part, f3: Part, c2: Part, f4: Part, r2: Part, f5: Part, c3: Part, f6: Part, c4: Part, f7: Part, r3: Part, f8: Part, r4: Part, offset: number) => {
    if (c1 === undefined && c3 === undefined && r3 === undefined) return token
    const sheet = prefix ? sheetOf(prefix) : home
    // Which sheets lie between the two named ones depends on the tab order, so any such reference is refused.
    if (prefix && (formula[offset - 1] === ':' || sheet!.includes(':'))) throw refused('a formula refers to the same cells across several sheets')
    if (sheet?.toLowerCase() !== target) return token
    const lead = prefix ?? ''
    const lost = () => { broken = true; return lead + '#REF!' }
    const within = (reach: readonly [number, number]) => { if (reach[1] > most) throw targetError('The sheet has no room for this insertion'); return reach }
    if (c1 !== undefined && c2 === undefined) {
      const index = moved(shift, rows ? Number(r1) : columnNumber(c1))
      if (index === undefined) return lost()
      within([index, index])
      return lead + f1 + (rows ? c1 : columnName(index)) + f2 + (rows ? index : r1)
    }
    if (c1 !== undefined) {
      const reach = rows ? span(shift, Math.min(Number(r1), Number(r2)), Math.max(Number(r1), Number(r2))) : span(shift, Math.min(columnNumber(c1), columnNumber(c2!)), Math.max(columnNumber(c1), columnNumber(c2!)))
      if (!reach) return lost()
      within(reach)
      return rows ? `${lead}${f1}${c1}${f2}${reach[0]}:${f3}${c2}${f4}${reach[1]}` : `${lead}${f1}${columnName(reach[0])}${f2}${r1}:${f3}${columnName(reach[1])}${f4}${r2}`
    }
    if (c3 !== undefined) {
      if (rows) return token
      const reach = span(shift, Math.min(columnNumber(c3), columnNumber(c4!)), Math.max(columnNumber(c3), columnNumber(c4!)))
      return reach ? `${lead}${f5}${columnName(within(reach)[0])}:${f6}${columnName(reach[1])}` : lost()
    }
    if (!rows) return token
    const reach = span(shift, Math.min(Number(r3), Number(r4)), Math.max(Number(r3), Number(r4)))
    return reach ? `${lead}${f7}${within(reach)[0]}:${f8}${reach[1]}` : lost()
  })
  return { formula: next, broken }
}

const formulaText = (node: Element): string => unescapeXml(textOf(node))
const setFormula = (node: Element, text: string): void => { kids(node).splice(0, Infinity, textNode(text)) }
/** Rewrite the formula an element holds as text. @returns whether it changed, and whether it broke. */
function rewriteNode(node: Element, home: string | undefined, shift: Shift): { readonly changed: boolean; readonly broken: boolean } {
  const before = formulaText(node)
  if (!before) return { changed: false, broken: false }
  const { formula, broken } = rewriteFormula(before, home, shift)
  if (formula !== before) setFormula(node, formula)
  return { changed: formula !== before, broken }
}
/** Give every row and cell its own reference, and every shared formula its own text, so each can move on its own. */
function plain(tree: readonly Element[], cells: readonly Cell[]): void {
  const formulas = new Map(cells.map(cell => [cell.ref, cell.formula]))
  let row = 0
  for (const line of deep(tree, 'row')) {
    row = Number(getAttr(line, 'r')) || row + 1
    setAttr(line, 'r', String(row))
    let column = 0
    for (const node of all(kids(line), 'c')) {
      const ref = getAttr(node, 'r')
      column = ref ? position(ref).column : column + 1
      setAttr(node, 'r', cellRef({ row, column }))
      const formula = find(kids(node), 'f')
      if (!formula || getAttr(formula, 't') !== 'shared') continue
      const known = formulas.get(cellRef({ row, column }))
      if (!known) throw refused(`the shared formula at ${cellRef({ row, column })} cannot be written out cell by cell`)
      for (const name of ['t', 'si', 'ref']) dropAttr(formula, name)
      setFormula(formula, known)
    }
  }
}
/** Shift an attribute that holds one reference. @returns false, with the attribute removed, when all its cells are deleted. */
function shiftAttr(shift: Shift, node: Element, name: string): boolean {
  const value = getAttr(node, name)
  if (!value) return true
  const next = shiftRef(shift, value)
  if (next === undefined) { dropAttr(node, name); return false }
  setAttr(node, name, next)
  return true
}
/** Keep the items of a list that still have cells, and drop the list when none do. */
function prune(parentList: Element[], holder: Element, item: string, keep: (node: Element) => boolean, counted = true): void {
  const list = kids(holder)
  list.splice(0, Infinity, ...list.filter(node => !isElement(node, item) || keep(node)))
  const left = all(list, item).length
  if (!left) parentList.splice(parentList.indexOf(holder), 1)
  else if (counted) setAttr(holder, 'count', String(left))
}
/** What on the target sheet cannot be made to follow a shift. */
function refuseUnsupported(book: Book, target: SheetEntry, worksheet: Element, tree: readonly Element[]): void {
  const { office } = book
  if (related(book, target, 'pivotTable').length) throw refused('it holds a pivot table')
  for (const name of office.names().filter(key => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/u.test(key))) {
    if (deep(parseTree(office.source(name)), 'worksheetSource').some(source => (getAttr(source, 'sheet') ?? '').toLowerCase() === target.name.toLowerCase())) throw refused('a pivot table reads its data')
  }
  if (related(book, target, 'comments').length || related(book, target, 'threadedComment').length) throw refused('it holds notes or comments, whose boxes would stay behind')
  const list = kids(worksheet)
  if (find(list, 'oleObjects') || find(list, 'controls')) throw refused('it holds embedded objects or form controls')
  const extension = find(list, 'extLst')
  if (extension && (deep(kids(extension), 'sqref').length || deep(kids(extension), 'f').length)) throw refused('it uses sparklines or newer conditional formats and validations')
  if (deep(tree, 'f').some(formula => getAttr(formula, 't') === 'dataTable')) throw refused('it holds a what-if data table')
}
/**
 * Where an insertion may carry a formula on: the columns, for inserted rows, or the rows, for inserted columns,
 * in which the cells on both sides of the insertion repeat one formula.
 */
function repeated(shift: Shift, cells: readonly Cell[]): Set<number> {
  const found = new Set<number>()
  if (!shift.insert || shift.at < 2) return found
  const rows = shift.axis === 'row'
  const before = new Map<number, Cell>()
  const after = new Map<number, Cell>()
  for (const cell of cells) {
    if (cell.formula === undefined || cell.formulaKind === 'array') continue
    const line = rows ? cell.row : cell.column
    if (line === shift.at - 1) before.set(rows ? cell.column : cell.row, cell)
    else if (line === shift.at) after.set(rows ? cell.column : cell.row, cell)
  }
  for (const [across, cell] of before) {
    const next = after.get(across)
    if (next && translateFormula(cell.formula!, cell, next) === next.formula) found.add(across)
  }
  return found
}
/** Move the target sheet's own cells and everything in its part that names them. @returns the cells an insertion added, and whether any took a formula. */
function moveSheet(shift: Shift, worksheet: Element, cells: readonly Cell[], fill: boolean): { readonly added: Position[]; readonly filled: boolean } {
  const prefix = prefixOf(tagOf(worksheet))
  const list = kids(worksheet)
  const rows = shift.axis === 'row'
  const data = kids(require(list, 'sheetData'))
  const repeat = fill ? repeated(shift, cells) : new Set<number>()
  const added: Position[] = []
  let filled = false
  /** A new cell that looks like its neighbour before the insertion, with that neighbour's formula carried on when it repeats. */
  const like = (model: Element, at: Position): Element | undefined => {
    const style = getAttr(model, 's')
    const from = position(getAttr(model, 'r')!)
    const formula = repeat.has(rows ? from.column : from.row) ? find(kids(model), 'f') : undefined
    const carried = formula && translateFormula(formulaText(formula), from, at)
    if (style === undefined && carried === undefined) return undefined
    added.push(at)
    filled ||= carried !== undefined
    return element(prefix + 'c', { r: cellRef(at), ...(style === undefined ? {} : { s: style }) }, carried === undefined ? [] : [element(prefix + 'f', {}, [textNode(carried)])])
  }
  if (rows) {
    const kept: Element[] = []
    for (const line of data) {
      if (!isElement(line, 'row')) { kept.push(line); continue }
      const next = moved(shift, Number(getAttr(line, 'r')))
      if (next === undefined) continue
      if (next > MAX_ROW) throw targetError('The sheet has no room for this insertion')
      setAttr(line, 'r', String(next))
      dropAttr(line, 'spans')
      for (const node of all(kids(line), 'c')) setAttr(node, 'r', cellRef({ row: next, column: position(getAttr(node, 'r')!).column }))
      kept.push(line)
    }
    const above = shift.insert ? kept.find(line => isElement(line, 'row') && Number(getAttr(line, 'r')) === shift.at - 1) : undefined
    if (above) {
      const fresh = Array.from({ length: shift.count }, (_, offset) => {
        const row = shift.at + offset
        const attrs = Object.fromEntries(['s', 'customFormat', 'ht', 'customHeight'].flatMap(name => { const value = getAttr(above, name); return value === undefined ? [] : [[name, value]] }))
        return element(prefix + 'row', { r: String(row), ...attrs }, all(kids(above), 'c').flatMap((model): Element[] => { const fresh = like(model, { row, column: position(getAttr(model, 'r')!).column }); return fresh ? [fresh] : [] }))
      })
      kept.splice(kept.indexOf(above) + 1, 0, ...fresh)
    }
    data.splice(0, Infinity, ...kept)
  } else {
    for (const line of all(data, 'row')) {
      const row = Number(getAttr(line, 'r'))
      dropAttr(line, 'spans')
      const kept: Element[] = []
      let left: Element | undefined
      for (const node of kids(line)) {
        if (!isElement(node, 'c')) { kept.push(node); continue }
        const column = position(getAttr(node, 'r')!).column
        const next = moved(shift, column)
        if (next === undefined) continue
        if (next > MAX_COLUMN) throw targetError('The sheet has no room for this insertion')
        if (shift.insert && column === shift.at - 1) left = node
        setAttr(node, 'r', cellRef({ row, column: next }))
        kept.push(node)
      }
      kids(line).splice(0, Infinity, ...kept)
      if (left) for (let offset = 0; offset < shift.count; offset++) { const fresh = like(left, { row, column: shift.at + offset }); if (fresh) placeCell(line, { row, column: shift.at + offset }, () => fresh) }
    }
    const holder = find(list, 'cols')
    if (holder) prune(list, holder, 'col', column => {
      const min = Number(getAttr(column, 'min'))
      const max = Number(getAttr(column, 'max'))
      // A span that ends just left of an insertion grows over it, so the new columns take that width.
      const reach = shift.insert && max === shift.at - 1 ? [min, max + shift.count] as const : span(shift, min, max)
      if (!reach) return false
      setAttr(column, 'min', String(reach[0]))
      setAttr(column, 'max', String(Math.min(reach[1], MAX_COLUMN)))
      return true
    }, false)
  }
  const dimension = find(list, 'dimension')
  if (dimension && !shiftAttr(shift, dimension, 'ref')) setAttr(dimension, 'ref', 'A1')
  const merges = find(list, 'mergeCells')
  if (merges) prune(list, merges, 'mergeCell', merge => { const area = shiftArea(shift, parseRange(getAttr(merge, 'ref')!)); if (!area || single(area)) return false; setAttr(merge, 'ref', areaRef(area)); return true })
  const filter = find(list, 'autoFilter')
  if (filter) {
    if (!shiftAttr(shift, filter, 'ref')) list.splice(list.indexOf(filter), 1)
    else for (const node of [...deep(kids(filter), 'sortState'), ...deep(kids(filter), 'sortCondition')]) shiftAttr(shift, node, 'ref')
  }
  const sort = find(list, 'sortState')
  if (sort && !shiftAttr(shift, sort, 'ref')) list.splice(list.indexOf(sort), 1)
  for (const format of all(list, 'conditionalFormatting')) {
    const left = shiftList(shift, getAttr(format, 'sqref') ?? '')
    if (left) setAttr(format, 'sqref', left)
    else list.splice(list.indexOf(format), 1)
  }
  const validations = find(list, 'dataValidations')
  if (validations) prune(list, validations, 'dataValidation', item => { const left = shiftList(shift, getAttr(item, 'sqref') ?? ''); if (left) setAttr(item, 'sqref', left); return !!left })
  const links = find(list, 'hyperlinks')
  if (links) prune(list, links, 'hyperlink', link => shiftAttr(shift, link, 'ref'), false)
  for (const view of deep(list, 'sheetView')) {
    for (const pane of all(kids(view), 'pane')) if (!shiftAttr(shift, pane, 'topLeftCell')) setAttr(pane, 'topLeftCell', 'A1')
    for (const selection of all(kids(view), 'selection')) { setAttr(selection, 'activeCell', 'A1'); setAttr(selection, 'sqref', 'A1') }
  }
  const breaks = find(list, rows ? 'rowBreaks' : 'colBreaks')
  if (breaks) {
    prune(list, breaks, 'brk', item => { const next = moved(shift, Number(getAttr(item, 'id'))); if (next === undefined) return false; setAttr(item, 'id', String(next)); return true })
    if (list.includes(breaks)) setAttr(breaks, 'manualBreakCount', String(all(kids(breaks), 'brk').length))
  }
  for (const [name, item] of [['ignoredErrors', 'ignoredError'], ['protectedRanges', 'protectedRange']] as const) {
    const holder = find(list, name)
    if (holder) prune(list, holder, item, node => { const left = shiftList(shift, getAttr(node, 'sqref') ?? ''); if (left) setAttr(node, 'sqref', left); return !!left }, false)
  }
  return { added, filled }
}
/** Tables keep their columns and header row, so a shift may only move a table or change how many data rows it has. */
function moveTable(shift: Shift, tree: Element[]): void {
  const table = require(tree, 'table')
  const name = getAttr(table, 'displayName') ?? getAttr(table, 'name') ?? ''
  const before = parseRange(getAttr(table, 'ref')!)
  const after = shiftArea(shift, before)
  if (shift.axis === 'column') {
    if (!after || after.last.column - after.first.column !== before.last.column - before.first.column) throw refused(`the change runs through the columns of table ${name}`)
  } else {
    const header = Number(getAttr(table, 'headerRowCount') ?? 1) > 0
    const totals = Number(getAttr(table, 'totalsRowCount') ?? 0) > 0
    const headerGone = !shift.insert && header && moved(shift, before.first.row) === undefined
    const totalsGone = !shift.insert && totals && moved(shift, before.last.row) === undefined
    if (!after || headerGone || totalsGone || after.last.row - after.first.row + 1 < (header ? 1 : 0) + (totals ? 1 : 0) + 1) throw refused(`the change would remove the header row, the totals row or every data row of table ${name}`)
  }
  setAttr(table, 'ref', cellRef(after.first) + ':' + cellRef(after.last))
  for (const node of [...all(kids(table), 'autoFilter'), ...deep(kids(table), 'sortState'), ...deep(kids(table), 'sortCondition')]) shiftAttr(shift, node, 'ref')
}
/** Drawings are anchored to cells by row and column counted from zero; an anchor whose cell is deleted lands where the deletion began. */
function moveAnchors(shift: Shift, tree: Element[]): boolean {
  let changed = false
  for (const edge of [...deep(tree, 'from'), ...deep(tree, 'to')]) {
    const holder = find(kids(edge), shift.axis === 'row' ? 'row' : 'col')
    if (!holder) continue
    const index = Number(textOf(holder)) + 1
    const next = moved(shift, index) ?? shift.at
    if (next !== index) { kids(holder).splice(0, Infinity, textNode(String(next - 1))); changed = true }
  }
  return changed
}
function shiftOf(change: StructureChange): Shift {
  switch (change.action) {
    case 'insert_rows': return { sheet: change.sheet, axis: 'row', at: change.before, count: change.count, insert: true }
    case 'delete_rows': return { sheet: change.sheet, axis: 'row', at: change.first, count: change.count, insert: false }
    case 'insert_columns': return { sheet: change.sheet, axis: 'column', at: columnNumber(change.before), count: change.count, insert: true }
    case 'delete_columns': return { sheet: change.sheet, axis: 'column', at: columnNumber(change.first), count: change.count, insert: false }
  }
}
type Restructured = { readonly bytes: Uint8Array; readonly touched: readonly TouchedRange[]; readonly structure: StructureReport; readonly filled: boolean }
/**
 * @param fill - carry a formula on into inserted cells when the cells on both sides repeat it.
 * @param limit - bound on the inflated package.
 * @returns the workbook, the cells an insertion added, the formulas a deletion broke, and whether a formula was carried into new cells.
 */
export function restructure(bytes: Uint8Array, change: StructureChange, limit: number, signal: AbortSignal, fill = true): Restructured {
  signal.throwIfAborted()
  const office = OfficePackage.open(bytes, limit, signal, true)
  const book = openBook(office)
  const target = findSheet(book, change.sheet)
  const shift = { ...shiftOf(change), sheet: target.name }
  const parts = new Map<string, Uint8Array | undefined>()
  const broken: { sheet: string; cell: string }[] = []
  let added: Position[] = []
  let filled = false
  for (const sheet of book.sheets) {
    signal.throwIfAborted()
    const here = sheet === target
    const cells = sheetCells(book, sheet)
    const tree = parseTree(office.source(sheet.part))
    const worksheet = require(tree, 'worksheet')
    if (here) refuseUnsupported(book, sheet, worksheet, tree)
    let changed = here
    if (here || cells.some(cell => cell.formulaKind === 'shared')) { plain(tree, cells); changed = true }
    const lost: Element[] = []
    for (const node of deep(tree, 'c')) {
      const formula = find(kids(node), 'f')
      if (!formula) continue
      const result = rewriteNode(formula, sheet.name, shift)
      changed ||= result.changed
      if (result.broken) lost.push(node)
      const reach = here && getAttr(formula, 't') === 'array' ? getAttr(formula, 'ref') : undefined
      if (reach) {
        const before = parseRange(reach)
        const after = shiftArea(shift, before)
        if (!after || after.last.row - after.first.row !== before.last.row - before.first.row || after.last.column - after.first.column !== before.last.column - before.first.column) throw refused(`the change runs through the array formula at ${reach}`)
        setAttr(formula, 'ref', areaRef(after))
      }
    }
    for (const node of [...deep(kids(worksheet), 'conditionalFormatting').flatMap(format => deep(kids(format), 'formula')), ...deep(kids(worksheet), 'dataValidation').flatMap(item => [...all(kids(item), 'formula1'), ...all(kids(item), 'formula2')])]) changed = rewriteNode(node, sheet.name, shift).changed || changed
    if (here) {
      ({ added, filled } = moveSheet(shift, worksheet, cells, fill))
      for (const part of related(book, sheet, 'table')) { const table = parseTree(office.source(part)); moveTable(shift, table); parts.set(part, buildTree(table)) }
      for (const part of related(book, sheet, 'drawing')) { const drawing = parseTree(office.source(part)); if (moveAnchors(shift, drawing)) parts.set(part, buildTree(drawing)) }
    }
    // A deleted cell takes its formula with it, so only the formulas that remain are reported, where they are now.
    const remaining = new Set(deep(tree, 'c'))
    for (const node of lost) if (remaining.has(node)) broken.push({ sheet: sheet.name, cell: getAttr(node, 'r')! })
    if (changed) parts.set(sheet.part, buildTree(tree))
  }
  for (const name of office.names().filter(key => /^xl\/charts\/[^/]+\.xml$/u.test(key))) {
    const tree = parseTree(office.source(name))
    let changed = false
    for (const node of deep(tree, 'f')) changed = rewriteNode(node, undefined, shift).changed || changed
    if (changed) parts.set(name, buildTree(tree))
  }
  refreshParts(office, parts)
  const main = parseTree(new TextDecoder().decode(parts.get('xl/workbook.xml')!))
  for (const name of deep(main, 'definedName')) {
    const local = getAttr(name, 'localSheetId')
    if (rewriteNode(name, local === undefined ? undefined : book.sheets[Number(local)]?.name, shift).broken) broken.push({ sheet: '(defined name)', cell: getAttr(name, 'name') ?? '' })
  }
  parts.set('xl/workbook.xml', buildTree(main))
  let touched: TouchedRange[] = []
  if (added.length) {
    let top = Infinity; let left = Infinity; let bottom = 0; let right = 0
    for (const { row, column } of added) { top = Math.min(top, row); left = Math.min(left, column); bottom = Math.max(bottom, row); right = Math.max(right, column) }
    touched = [{ sheet: target.name, range: cellRef({ row: top, column: left }) + ':' + cellRef({ row: bottom, column: right }) }]
  }
  return { bytes: office.rewrite(parts), touched, structure: { brokenReferences: broken.slice(0, REPORTED), brokenCount: broken.length }, filled }
}

interface Value { readonly type: string; readonly raw: string }
function alike(a: Value | undefined, b: Value | undefined): boolean {
  const empty = (value: Value | undefined): boolean => !value || value.raw === ''
  if (empty(a) || empty(b)) return empty(a) && empty(b)
  const x = Number(a!.raw)
  const y = Number(b!.raw)
  if (a!.type === 'n' && b!.type === 'n' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))
  return a!.raw === b!.raw
}
/**
 * Calculate the workbook before and after an insertion and compare every cell that existed before, at the place it moved to.
 * @returns the cells whose value differs, or why the comparison could not be made.
 */
async function compare(before: Uint8Array, after: Uint8Array, shift: Shift, limit: number, calculate: (bytes: Uint8Array) => Promise<Uint8Array>, signal: AbortSignal): Promise<{ readonly differences: readonly string[] } | { readonly reason: string }> {
  const office = OfficePackage.open(before, limit, signal, true)
  const book = openBook(office)
  const formulas = book.sheets.flatMap(sheet => sheetCells(book, sheet).flatMap(cell => cell.formula ?? []))
  if (!formulas.length) return { differences: [] }
  if (formulas.some(formula => VOLATILE.test(formula))) return { reason: 'The workbook uses functions such as NOW or RAND that give a new result each time, so values before and after were not compared' }
  if (reaches(office, book)) return { reason: 'The workbook has external links or network functions, so it was not calculated here and values before and after were not compared' }
  let old: Book
  let fresh: Book
  try {
    old = openBook(OfficePackage.open(await calculate(before), limit, signal))
    fresh = openBook(OfficePackage.open(await calculate(after), limit, signal))
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PersonalChatError && error.reason === 'office-render') return { reason: 'The Office engine could not calculate this workbook, so values before and after were not compared' }
    throw error
  }
  const differences: string[] = []
  for (const sheet of old.sheets) {
    const here = sheet.name.toLowerCase() === shift.sheet.toLowerCase()
    const now = new Map(sheetCells(fresh, findSheet(fresh, sheet.name)).map(cell => [cell.ref, cell]))
    for (const cell of sheetCells(old, sheet)) {
      const at = here ? cellRef(place(shift, cell)!) : cell.ref
      const next = now.get(at)
      if (!alike(cell, next)) differences.push(`${sheet.name}!${at} (${JSON.stringify(cell.raw)} became ${JSON.stringify(next?.raw ?? '')})`)
    }
  }
  return { differences }
}
/**
 * Insert or delete rows or columns, and for an insertion make sure no existing cell calculates to another value.
 * An insertion that fails the comparison is tried once more without carrying formulas into the new cells, and is not made at all if it still fails.
 * @param calculate - the engine, or undefined when this file must not reach it.
 */
export async function restructureVerified(bytes: Uint8Array, change: StructureChange, limit: number, calculate: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly touched: readonly TouchedRange[]; readonly structure: StructureReport }> {
  const done = (result: Restructured, rest: Partial<StructureReport>) => ({ bytes: result.bytes, touched: result.touched, structure: { ...result.structure, ...rest } })
  let result = restructure(bytes, change, limit, signal, true)
  const shift = shiftOf(change)
  if (!shift.insert) return done(result, { reason: 'Deleting cells changes the results that used them, so values before and after were not compared; read the cells that depended on them' })
  if (!calculate) return done(result, { reason: 'Temporary Chat keeps files in memory, so values before and after were not compared' })
  let check = await compare(bytes, result.bytes, shift, limit, calculate, signal)
  if ('differences' in check && check.differences.length && result.filled) {
    result = restructure(bytes, change, limit, signal, false)
    check = await compare(bytes, result.bytes, shift, limit, calculate, signal)
  }
  if ('reason' in check) return done(result, { reason: check.reason })
  if (check.differences.length) throw targetError(`The insertion was not made: after it, ${check.differences.length} existing cells would calculate to other values, for example ${check.differences.slice(0, 5).join(', ')}. The workbook is as it was`)
  return done(result, { verified: true })
}
