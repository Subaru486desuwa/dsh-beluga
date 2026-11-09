/**
 * Add native charts to a workbook. A chart's series read cells of its sheet, so Excel and LibreOffice
 * redraw it from the data; the values it saves are the settled ones, for readers that show only what a
 * file holds. Parts the charts do not need keep their exact content.
 */
import { posix } from 'node:path'
import type { ChartCheck, WorkbookChart } from 'dsh-beluga'
import { OfficePackage, attr, children, descendants, fail, relationshipId } from './package.ts'
import { all, buildTree, deep, element, escapeXml, find, getAttr, isElement, kids, parseTree, prefixOf, require, setAttr, tagOf, textOf, type Element } from './tree.ts'
import { cellRef, columnName, findSheet, openBook, parseRange, sheetCells, targetError, type Book, type Cell, type Position } from './workbook.ts'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MAIN = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const SHEET_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DRAWING_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
/** About 576 by 340 pixels at Excel's default column width and row height, the size of a chart in a document. */
const CHART_COLUMNS = 9
const CHART_ROWS = 17
/** Excel's default column width and row height in EMU, to size anchors that give only their extent. */
const COLUMN_EMU = 64 * 9525
const ROW_EMU = 20 * 9525
/** Excel's accent colours, then darker shades of them. Every series names its colour, so every application draws the same chart. */
const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E', '636363', '997300', '255E91', '43682B']
const MAX_POINTS = 1000
/** Lines with more points than this get no markers, which would only crowd them. */
const MARKED_POINTS = 24
const REPORTED_CELLS = 20
/** Worksheet children that come after `drawing`, in schema order. */
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']
const CATEGORY_AXIS = 100
const VALUE_AXIS = 200
const PIE_LABELS = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>'

/** Parts parsed once and written once, however many charts change them. */
class Edits {
  private readonly trees = new Map<string, Element[]>()
  private readonly added = new Map<string, Uint8Array>()
  constructor(private readonly office: OfficePackage) {}
  has(path: string): boolean { return this.office.has(path) || this.trees.has(path) || this.added.has(path) }
  /** @param blank - the part's text when the package does not have it yet. */
  tree(path: string, blank?: string): Element[] {
    let tree = this.trees.get(path)
    if (!tree) {
      const source = this.office.has(path) ? this.office.source(path) : blank ?? fail('Missing Office part: ' + path)
      tree = parseTree(source)
      this.trees.set(path, tree)
    }
    return tree
  }
  add(path: string, xml: string): void { this.added.set(path, new TextEncoder().encode(xml)) }
  /** The first unused part name of the form `stem` + number + `.xml`. */
  name(stem: string): string {
    let number = 1
    while (this.has(stem + number + '.xml')) number++
    return stem + number + '.xml'
  }
  bytes(): Uint8Array {
    const changes = new Map<string, Uint8Array | undefined>(this.added)
    for (const [path, tree] of this.trees) changes.set(path, buildTree(tree))
    return this.office.rewrite(changes)
  }
}

/** The prefix `root` declares for `uri`, declaring `preferred` for it when there is none. */
function prefixFor(root: Element, uri: string, preferred: string): string {
  const declared = Object.entries((root[':@'] ?? {}) as Record<string, string>).find(([key, value]) => key.startsWith('@_xmlns:') && value === uri)
  if (declared) return declared[0].slice('@_xmlns:'.length)
  let prefix = preferred
  for (let number = 2; getAttr(root, 'xmlns:' + prefix) !== undefined; number++) prefix = preferred + number
  setAttr(root, 'xmlns:' + prefix, uri)
  return prefix
}
const relationsOf = (part: string): string => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
/** @returns the id of a new relationship from `source` to `target`. */
function relate(edits: Edits, source: string, type: string, target: string): string {
  const root = require(edits.tree(relationsOf(source), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"></Relationships>`), 'Relationships')
  const list = kids(root)
  const used = new Set(all(list, 'Relationship').map(node => getAttr(node, 'Id')))
  let number = used.size + 1
  while (used.has('rId' + number)) number++
  list.push(element(prefixOf(tagOf(root)) + 'Relationship', { Id: 'rId' + number, Type: REL + '/' + type, Target: posix.relative(posix.dirname(source), target) }))
  return 'rId' + number
}
function declare(edits: Edits, part: string, type: string): void {
  const root = require(edits.tree('[Content_Types].xml'), 'Types')
  const list = kids(root)
  if (!all(list, 'Override').some(node => getAttr(node, 'PartName') === '/' + part)) list.push(element(prefixOf(tagOf(root)) + 'Override', { PartName: '/' + part, ContentType: type }))
}
/** The drawing part of a worksheet, made and linked from it when the sheet has none. */
function drawingOf(edits: Edits, office: OfficePackage, sheet: string): string {
  const linked = children(office.xml(sheet).children.find(node => node.tag === 'worksheet')!, 'drawing')[0]
  if (linked) return office.target(sheet, office.relationships(sheet).find(relation => attr(relation, 'Id') === relationshipId(linked)))
  const part = edits.name('xl/drawings/drawing')
  edits.tree(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${SHEET_DRAWING}" xmlns:a="${MAIN}"></xdr:wsDr>`)
  declare(edits, part, DRAWING_TYPE)
  const id = relate(edits, sheet, 'drawing', part)
  const worksheet = require(edits.tree(sheet), 'worksheet')
  const r = prefixFor(worksheet, REL, 'r')
  const list = kids(worksheet)
  const before = list.findIndex(node => AFTER_DRAWING.some(name => isElement(node, name)))
  list.splice(before < 0 ? list.length : before, 0, element(prefixOf(tagOf(worksheet)) + 'drawing', { [r + ':id']: id }))
  return part
}

/** Cells a drawing object covers, counted from 0, the right and bottom edges excluded. */
interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
const numberIn = (parent: Element, name: string): number => { const node = find(kids(parent), name); return node ? Number(textOf(node)) || 0 : 0 }
/** Where the objects of a drawing sit. An object anchored by its size alone is measured in default cells. */
function boxes(root: Element): Box[] {
  return kids(root).flatMap(anchor => {
    const from = find(kids(anchor), 'from')
    if (!from) return []
    const left = numberIn(from, 'col')
    const top = numberIn(from, 'row')
    const to = find(kids(anchor), 'to')
    if (to) return [{ left, top, right: numberIn(to, 'col') + (numberIn(to, 'colOff') > 0 ? 1 : 0), bottom: numberIn(to, 'row') + (numberIn(to, 'rowOff') > 0 ? 1 : 0) }]
    const size = find(kids(anchor), 'ext')
    return size ? [{ left, top, right: left + Math.ceil(Number(getAttr(size, 'cx')) / COLUMN_EMU), bottom: top + Math.ceil(Number(getAttr(size, 'cy')) / ROW_EMU) }] : []
  })
}
/** From row 2 of column `left` down, the first place a chart overlaps nothing. */
function place(left: number, taken: readonly Box[]): Box {
  let top = 1
  for (let moved = true; moved;) {
    moved = false
    for (const box of taken) {
      if (box.left < left + CHART_COLUMNS && left < box.right && box.top < top + CHART_ROWS && top < box.bottom) { top = box.bottom + 1; moved = true }
    }
  }
  return { left, top, right: left + CHART_COLUMNS, bottom: top + CHART_ROWS }
}
function anchorXml(xdr: string, a: string, box: Box, id: number, relation: string, title: string | undefined): string {
  const corner = (tag: string, column: number, row: number) => `<${xdr}${tag}><${xdr}col>${column}</${xdr}col><${xdr}colOff>0</${xdr}colOff><${xdr}row>${row}</${xdr}row><${xdr}rowOff>0</${xdr}rowOff></${xdr}${tag}>`
  return `<${xdr}twoCellAnchor>${corner('from', box.left, box.top)}${corner('to', box.right, box.bottom)}<${xdr}graphicFrame macro=""><${xdr}nvGraphicFramePr><${xdr}cNvPr id="${id}" name="Chart ${id}"${title ? ` descr="${escapeXml(title)}"` : ''}/><${xdr}cNvGraphicFramePr/></${xdr}nvGraphicFramePr>`
    + `<${xdr}xfrm><${a}:off x="0" y="0"/><${a}:ext cx="0" cy="0"/></${xdr}xfrm><${a}:graphic><${a}:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" xmlns:r="${REL}" r:id="${relation}"/></${a}:graphicData></${a}:graphic></${xdr}graphicFrame><${xdr}clientData/></${xdr}twoCellAnchor>`
}

/** The cells of a one-column or one-row range, in order. */
function lineOf(range: string, role: string): Position[] {
  const { first, last } = parseRange(range)
  if (first.row !== last.row && first.column !== last.column) throw targetError(`${role} ${range} must be one column or one row`)
  const cells: Position[] = []
  for (let row = first.row; row <= last.row; row++) for (let column = first.column; column <= last.column; column++) cells.push({ row, column })
  if (cells.length > MAX_POINTS) throw targetError(`${role} ${range} has more than ${MAX_POINTS} cells`)
  return cells
}
const quoted = (sheet: string): string => "'" + sheet.replace(/'/gu, "''") + "'"
const absolute = ({ row, column }: Position): string => '$' + columnName(column) + '$' + row
const formulaOf = (sheet: string, cells: readonly Position[]): string => quoted(sheet) + '!' + absolute(cells[0]!) + (cells.length > 1 ? ':' + absolute(cells.at(-1)!) : '')
/** What a value cell gives a chart: a number, a gap, a formula result still to be calculated, or something it cannot draw. */
type Plot = { readonly number: number } | 'blank' | 'pending' | 'other'
function plotOf(cell: Cell | undefined): Plot {
  if (!cell) return 'blank'
  if (cell.type === 'n') {
    if (cell.raw === '') return cell.formula === undefined ? 'blank' : 'pending'
    const number = Number(cell.raw)
    return Number.isFinite(number) ? { number } : 'other'
  }
  return cell.raw === '' && ['s', 'str', 'inlineStr'].includes(cell.type) ? 'blank' : 'other'
}
const formatOf = (book: Book, cell: Cell | undefined): string => book.formats[cell?.style ?? 0] ?? 'General'

type Cached = string | number | undefined
const v = (value: string | number): string => `<c:v>${escapeXml(String(value))}</c:v>`
function cache(numeric: boolean, values: readonly Cached[], format: string): string {
  const points = values.map((value, index) => value === undefined ? '' : `<c:pt idx="${index}">${v(value)}</c:pt>`).join('')
  return numeric ? `<c:numCache><c:formatCode>${escapeXml(format)}</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache>` : `<c:strCache><c:ptCount val="${values.length}"/>${points}</c:strCache>`
}
const dataRef = (numeric: boolean, formula: string, values: readonly Cached[], format = 'General'): string => {
  const kind = numeric ? 'num' : 'str'
  return `<c:${kind}Ref><c:f>${escapeXml(formula)}</c:f>${cache(numeric, values, format)}</c:${kind}Ref>`
}
const fill = (color: string): string => `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
/** `format` is the number format code of the cells, which numeric data saves with it. */
interface Labels { readonly formula: string; readonly numeric: boolean; readonly values: readonly Cached[]; readonly format: string }
interface Plotted { readonly name?: { readonly text: string; readonly formula?: string }; readonly formula: string; readonly values: readonly (number | undefined)[]; readonly format: string }
function seriesXml(chart: WorkbookChart['chart'], index: number, series: Plotted, labels: Labels): string {
  const color = PALETTE[index % PALETTE.length]!
  const name = series.name ? `<c:tx>${series.name.formula ? dataRef(false, series.name.formula, [series.name.text]) : v(series.name.text)}</c:tx>` : ''
  const head = `<c:idx val="${index}"/><c:order val="${index}"/>${name}`
  const data = `<c:cat>${dataRef(labels.numeric, labels.formula, labels.values, labels.format)}</c:cat><c:val>${dataRef(true, series.formula, series.values, series.format)}</c:val>`
  if (chart === 'pie') {
    const slices = series.values.map((_, point) => `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${fill(PALETTE[point % PALETTE.length]!)}</c:spPr></c:dPt>`).join('')
    return `<c:ser>${head}${slices}${PIE_LABELS}${data}</c:ser>`
  }
  if (chart === 'line') {
    const marker = series.values.length <= MARKED_POINTS ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fill(color)}<a:ln>${fill(color)}</a:ln></c:spPr></c:marker>` : '<c:marker><c:symbol val="none"/></c:marker>'
    return `<c:ser>${head}<c:spPr><a:ln w="28575" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr>${marker}${data}<c:smooth val="0"/></c:ser>`
  }
  return `<c:ser>${head}<c:spPr>${fill(color)}</c:spPr><c:invertIfNegative val="0"/>${data}</c:ser>`
}
/** Excel formats the labels as their cells, by `sourceLinked`; LibreOffice draws the code written here, so it is theirs. */
const numberFormat = (format: string): string => `<c:numFmt formatCode="${escapeXml(format)}" sourceLinked="1"/>`
/**
 * Category labels sit at the low end of the value axis, so they stay clear of bars below zero.
 * @param zero - start the value axis at 0, so bars keep their true proportions.
 */
function axesXml(across: boolean, zero: boolean, labels: string, values: string): string {
  return `<c:catAx><c:axId val="${CATEGORY_AXIS}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${across ? 'l' : 'b'}"/>${numberFormat(labels)}<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:crossAx val="${VALUE_AXIS}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="${VALUE_AXIS}"/><c:scaling><c:orientation val="minMax"/>${zero ? '<c:min val="0"/>' : ''}</c:scaling><c:delete val="0"/><c:axPos val="${across ? 'b' : 'l'}"/><c:majorGridlines/>${numberFormat(values)}<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${CATEGORY_AXIS}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
}
function chartXml(chart: WorkbookChart, labels: Labels, series: readonly Plotted[], zero: boolean): string {
  const items = series.map((item, index) => seriesXml(chart.chart, index, item, labels)).join('')
  const axes = `<c:axId val="${CATEGORY_AXIS}"/><c:axId val="${VALUE_AXIS}"/>`
  // The value axis shows the first series' format, as Excel does.
  const scales = (across: boolean): string => axesXml(across, zero, labels.format, series[0]!.format)
  const plot = chart.chart === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${items}<c:firstSliceAng val="0"/></c:pieChart>`
    : chart.chart === 'line' ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${items}<c:marker val="1"/>${axes}</c:lineChart>${scales(false)}`
      : `<c:barChart><c:barDir val="${chart.chart === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${items}<c:gapWidth val="150"/>${axes}</c:barChart>${scales(chart.chart === 'bar')}`
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>'
  const legend = chart.chart === 'pie' || series.length > 1 ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${CHART}" xmlns:a="${MAIN}" xmlns:r="${REL}"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
}

/**
 * Add each chart to the right of its sheet's data, below any drawing already there. Call it on a
 * settled workbook: charts save the values they show, and formulas have none before settling.
 * @param limit - bound on the inflated package.
 */
export function addCharts(bytes: Uint8Array, charts: readonly WorkbookChart[], limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly charts: readonly ChartCheck[] } {
  signal.throwIfAborted()
  const office = OfficePackage.open(bytes, limit, signal, true)
  const book = openBook(office)
  const edits = new Edits(office)
  const checks: ChartCheck[] = []
  /** Drawings made in this call, which the package does not know yet; a sheet has one at most. */
  const drawings = new Map<string, string>()
  for (const chart of charts) {
    signal.throwIfAborted()
    const sheet = findSheet(book, chart.sheet)
    if (!office.xml(sheet.part).children.some(node => node.tag === 'worksheet')) throw targetError(sheet.name + ' is not a worksheet, so it cannot hold a chart')
    const cells = sheetCells(book, sheet)
    const byRef = new Map(cells.map(cell => [cell.ref, cell]))
    const categories = lineOf(chart.categories, 'categories')
    const labelCells = categories.map(at => byRef.get(cellRef(at)))
    const labelValues = labelCells.map(cell => cell?.value ?? null)
    const numeric = labelValues.some(value => typeof value === 'number') && labelValues.every(value => value === null || typeof value === 'number')
    const labels = {
      formula: formulaOf(sheet.name, categories), numeric, values: labelValues.map(value => value === null ? undefined : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value),
      format: numeric ? formatOf(book, labelCells.find(cell => typeof cell?.value === 'number')) : 'General',
    }
    const notNumbers = new Set<string>()
    let pending = false
    let negative = false
    const series = chart.series.map((item): Plotted => {
      const at = lineOf(item.values, 'values')
      if (at.length !== categories.length) throw targetError(`values ${item.values} has ${at.length} cells, but categories ${chart.categories} has ${categories.length}`)
      /** The format of the first value cell that holds or awaits a number. */
      let format: string | undefined
      const values = at.map(position => {
        const cell = byRef.get(cellRef(position))
        const plot = plotOf(cell)
        if (plot === 'other') notNumbers.add(cellRef(position))
        if (plot === 'pending') pending = true
        if (typeof plot === 'object' || plot === 'pending') format ??= formatOf(book, cell)
        if (typeof plot === 'object' && plot.number < 0) negative = true
        return typeof plot === 'object' ? plot.number : undefined
      })
      const down = at.length === 1 || at[0]!.column === at[1]!.column
      const header = down ? (at[0]!.row > 1 ? { row: at[0]!.row - 1, column: at[0]!.column } : undefined) : (at[0]!.column > 1 ? { row: at[0]!.row, column: at[0]!.column - 1 } : undefined)
      const heading = header && byRef.get(cellRef(header))?.value
      const name = item.name !== undefined ? { text: item.name } : typeof heading === 'string' && heading.trim() ? { text: heading, formula: formulaOf(sheet.name, [header!]) } : undefined
      return { ...(name ? { name } : {}), formula: formulaOf(sheet.name, at), values, format: format ?? 'General' }
    })
    const zero = (chart.chart === 'column' || chart.chart === 'bar') && !pending && !negative
    const drawing = drawings.get(sheet.part) ?? drawingOf(edits, office, sheet.part)
    drawings.set(sheet.part, drawing)
    const root = edits.tree(drawing).find(node => isElement(node, 'wsDr')) ?? fail('Drawing part has no root element')
    let lastColumn = 0
    for (const cell of cells) if (cell.value !== null || cell.formula !== undefined) lastColumn = Math.max(lastColumn, cell.column)
    for (const merge of descendants(office.xml(sheet.part), 'mergeCell')) lastColumn = Math.max(lastColumn, parseRange(attr(merge, 'ref') || 'A1').last.column)
    const box = place(lastColumn + 1, boxes(root))
    const part = edits.name('xl/charts/chart')
    edits.add(part, chartXml(chart, labels, series, zero))
    declare(edits, part, CHART_TYPE)
    const relation = relate(edits, drawing, 'chart', part)
    const id = deep(kids(root), 'cNvPr').reduce((highest, node) => Math.max(highest, Number(getAttr(node, 'id')) || 0), 1) + 1
    kids(root).push(...parseTree(anchorXml(prefixOf(tagOf(root)), prefixFor(root, MAIN, 'a'), box, id, relation, chart.title)))
    checks.push({ sheet: sheet.name, ...(chart.title ? { title: chart.title } : {}), at: cellRef({ row: box.top + 1, column: box.left + 1 }) + ':' + cellRef({ row: box.bottom, column: box.right }), notNumbers: [...notNumbers].slice(0, REPORTED_CELLS) })
  }
  return { bytes: edits.bytes(), charts: checks }
}
