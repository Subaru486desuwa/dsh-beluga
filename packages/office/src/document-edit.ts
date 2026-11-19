/**
 * Change paragraphs of any DOCX. Runs are split only where a change begins and ends, so the formatting
 * around it stays, and every part without a change keeps its exact content.
 */
import { PatchType, TextRun, patchDetector, patchDocument } from 'docx'
import { PersonalChatError } from 'dsh-beluga'
import type { ChangedParagraph, ParagraphChange, ParagraphFormat } from 'dsh-beluga'
import { OfficePackage } from './package.ts'
import { parseLocation, shortStep } from './locations.ts'
import { all, buildTree, deep, dropAttr, element, escapeXml, find, getAttr, isElement, kids, localName, parseTree, prefixOf, setAttr, tagOf, textNode, textOf, unescapeXml, type Element } from './tree.ts'

const MAIN = 'word/document.xml'
const EDITABLE = /^word\/(?:document|header\d+|footer\d+)\.xml$/u
const AUTHOR = 'Beluga'
/** What a reader of the document sees as text. */
const TEXT = new Set(['t', 'tab', 'br', 'cr'])
/** Removing these with a run loses nothing. Anything else in a run is an image, a field or the like. */
const DISPOSABLE = new Set(['rPr', 'lastRenderedPageBreak'])
/** Property lists, and text a tracked change already removed. */
const NOT_TEXT = new Set(['pPr', 'del', 'moveFrom'])
const INSERTED = new Set(['ins', 'moveTo'])
const PAIRED = [['bookmarkStart', 'bookmarkEnd'], ['commentRangeStart', 'commentRangeEnd']] as const

const ROW_ACTIONS: ReadonlySet<string> = new Set(['insert_row_after', 'delete_row'])
const targetError = (message: string): PersonalChatError => new PersonalChatError('document-target', message)
function plain(node: Element): string {
  const name = localName(tagOf(node))
  if (name === 't') return unescapeXml(textOf(node))
  if (name === 'tab') return '\t'
  if (name === 'br' || name === 'cr') return '\n'
  return NOT_TEXT.has(name) ? '' : kids(node).map(plain).join('')
}
const textIn = (paragraph: Element): string => kids(paragraph).map(plain).join('')

/** One run, where its text falls in the paragraph, and whether a tracked insertion holds it. */
interface Piece { readonly run: Element; readonly siblings: Element[]; readonly start: number; readonly end: number; readonly revised: boolean }
function pieces(paragraph: Element): Piece[] {
  const found: Piece[] = []
  let offset = 0
  const visit = (nodes: Element[], revised: boolean) => {
    for (const node of nodes) {
      const name = localName(tagOf(node))
      if (name === 'r') {
        const start = offset
        offset += plain(node).length
        found.push({ run: node, siblings: nodes, start, end: offset, revised })
      } else if (!NOT_TEXT.has(name)) visit(kids(node), revised || INSERTED.has(name))
    }
  }
  visit(kids(paragraph), false)
  return found
}
const textPieces = (paragraph: Element): Piece[] => pieces(paragraph).filter(piece => piece.end > piece.start)
const runProperties = (run: Element | undefined): Element | undefined => run && find(kids(run), 'rPr')
function splitRun(piece: Piece, offset: number): void {
  const list = kids(piece.run)
  let index = 0
  let at = piece.start
  while (at < offset) {
    const child = list[index]!
    const width = plain(child).length
    if (at + width > offset) {
      if (!isElement(child, 't')) throw targetError('The change falls inside an embedded object')
      const value = plain(child)
      const preserved = { 'xml:space': 'preserve' }
      list.splice(index, 1, element(tagOf(child), preserved, [textNode(value.slice(0, offset - at))]), element(tagOf(child), preserved, [textNode(value.slice(offset - at))]))
      at = offset
    } else at += width
    index++
  }
  const moved = list.splice(index)
  const properties = runProperties(piece.run)
  const right: Element = { [tagOf(piece.run)]: [...(properties ? [structuredClone(properties)] : []), ...moved], ':@': structuredClone(piece.run[':@'] ?? {}) }
  piece.siblings.splice(piece.siblings.indexOf(piece.run) + 1, 0, right)
}
function textRun(prefix: string, properties: Element | undefined, value: string): Element {
  const children = value.split(/(\t|\n)/u).filter(Boolean).map(part => part === '\t' ? element(prefix + 'tab') : part === '\n' ? element(prefix + 'br') : element(prefix + 't', { 'xml:space': 'preserve' }, [textNode(part)]))
  return element(prefix + 'r', {}, [...(properties ? [structuredClone(properties)] : []), ...children])
}
/** Mints tracked-change elements. Their ids must not collide with any other annotation in the part. */
class Revisions {
  private next: number
  private readonly date = new Date().toISOString().replace(/\.\d+Z$/u, 'Z')
  constructor(private readonly prefix: string, source: string) { this.next = Math.max(0, ...Array.from(source.matchAll(/:id="(\d+)"/gu), match => Number(match[1]))) + 1 }
  mark(kind: 'ins' | 'del', children: Element[] = []): Element {
    return element(this.prefix + kind, { [this.prefix + 'id']: String(this.next++), [this.prefix + 'author']: AUTHOR, [this.prefix + 'date']: this.date }, children)
  }
  /** Put a run in a tracked deletion, where its text must be written as `delText`. */
  remove(piece: Piece): void {
    const list = kids(piece.run)
    for (const [index, child] of list.entries()) if (isElement(child, 't')) list[index] = { [this.prefix + 'delText']: kids(child), ':@': { '@_xml:space': 'preserve' } }
    piece.siblings[piece.siblings.indexOf(piece.run)] = this.mark('del', [piece.run])
  }
}
function refuseObjects(piece: Piece): void {
  if (kids(piece.run).some(child => { const name = localName(tagOf(child)); return !TEXT.has(name) && !DISPOSABLE.has(name) })) throw targetError('The change would remove an image, field or other object; leave that text as it is')
}
function narrowed(before: string, after: string): { readonly start: number; readonly end: number; readonly inserted: string } {
  const room = Math.min(before.length, after.length)
  let head = 0
  while (head < room && before[head] === after[head]) head++
  if (head > 0 && /[\ud800-\udbff]/u.test(before[head - 1]!)) head--
  let tail = 0
  while (tail < room - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  if (tail > 0 && /[\udc00-\udfff]/u.test(before[before.length - tail]!)) tail--
  return { start: head, end: before.length - tail, inserted: after.slice(head, after.length - tail) }
}
function replaceText(paragraph: Element, after: string, revisions: Revisions | undefined): void {
  const { start, end, inserted } = narrowed(textIn(paragraph), after)
  if (start === end && !inserted) return
  for (const offset of [start, end]) { const piece = pieces(paragraph).find(item => item.start < offset && offset < item.end); if (piece) splitRun(piece, offset) }
  const runs = textPieces(paragraph)
  const removed = runs.filter(piece => piece.start >= start && piece.end <= end)
  const previous = removed.length ? undefined : runs.findLast(piece => piece.end === start)
  const following = removed.length || previous ? undefined : runs.find(piece => piece.start === start)
  const neighbour = removed[0] ?? previous ?? following
  removed.forEach(refuseObjects)
  if (revisions && [...removed, ...(neighbour ? [neighbour] : [])].some(piece => piece.revised)) throw targetError('This text is part of an unresolved tracked change; resolve it or edit without tracking')
  if (inserted) {
    const prefix = prefixOf(tagOf(paragraph))
    const properties = neighbour ? runProperties(neighbour.run) : find(kids(find(kids(paragraph), 'pPr') ?? element('')), 'rPr')
    const run = textRun(prefix, properties, inserted)
    const added = revisions ? revisions.mark('ins', [run]) : run
    const before = removed.at(-1) ?? previous
    if (before) before.siblings.splice(before.siblings.indexOf(before.run) + 1, 0, added)
    else if (following) following.siblings.splice(following.siblings.indexOf(following.run), 0, added)
    else kids(paragraph).push(added)
  }
  for (const piece of removed) {
    if (revisions) revisions.remove(piece)
    else piece.siblings.splice(piece.siblings.indexOf(piece.run), 1)
  }
}
/** A tracked paragraph mark, which is what makes a whole paragraph count as inserted or removed. */
function markParagraph(paragraph: Element, mark: Element): void {
  const prefix = prefixOf(tagOf(paragraph))
  const list = kids(paragraph)
  let properties = find(list, 'pPr')
  if (!properties) { properties = element(prefix + 'pPr'); list.unshift(properties) }
  const inner = kids(properties)
  let runMark = find(inner, 'rPr')
  if (!runMark) {
    runMark = element(prefix + 'rPr')
    const tail = inner.findIndex(node => isElement(node, 'sectPr') || isElement(node, 'pPrChange'))
    inner.splice(tail < 0 ? inner.length : tail, 0, runMark)
  }
  kids(runMark).unshift(mark)
}
function insertParagraph(target: Located, value: string, revisions: Revisions | undefined): Element {
  const prefix = prefixOf(tagOf(target.paragraph))
  const source = find(kids(target.paragraph), 'pPr')
  const properties = source && structuredClone(source)
  if (properties) {
    const inner = kids(properties)
    inner.splice(0, Infinity, ...inner.filter(node => !isElement(node, 'sectPr') && !isElement(node, 'pPrChange')))
    const runMark = find(inner, 'rPr')
    if (runMark) kids(runMark).splice(0, Infinity, ...kids(runMark).filter(node => !isElement(node, 'ins') && !isElement(node, 'del')))
  }
  const run = textRun(prefix, runProperties(textPieces(target.paragraph).at(-1)?.run), value)
  const fresh = element(prefix + 'p', {}, [...(properties ? [properties] : []), revisions ? revisions.mark('ins', [run]) : run])
  if (revisions) markParagraph(fresh, revisions.mark('ins'))
  target.siblings.splice(target.siblings.indexOf(target.paragraph) + 1, 0, fresh)
  return fresh
}
function deleteParagraph(target: Located, revisions: Revisions | undefined): void {
  const { paragraph, siblings, parent } = target
  if (find(kids(find(kids(paragraph), 'pPr') ?? element('')), 'sectPr')) throw targetError('This paragraph ends a document section and cannot be deleted')
  const blocks = siblings.filter(node => node !== paragraph && (isElement(node, 'p') || isElement(node, 'tbl')))
  if (!blocks.length || (isElement(parent, 'tc') && !isElement(blocks.at(-1)!, 'p'))) throw targetError('This is the last paragraph here, which must stay; replace its text with an empty string instead')
  const runs = pieces(paragraph)
  runs.forEach(refuseObjects)
  if (revisions) {
    if (runs.some(piece => piece.revised)) throw targetError('This text is part of an unresolved tracked change; resolve it or edit without tracking')
    runs.forEach(piece => revisions.remove(piece))
    markParagraph(paragraph, revisions.mark('del'))
    return
  }
  for (const [start, end] of PAIRED) {
    const ids = (name: string) => deep(kids(paragraph), name).map(node => getAttr(node, tagOf(node).replace(/[^:]*$/u, 'id'))).sort().join()
    if (ids(start) !== ids(end)) throw targetError('A bookmark or comment reaches outside this paragraph, so it cannot be deleted')
  }
  siblings.splice(siblings.indexOf(paragraph), 1)
}
/** `row` is the table row the paragraph sits in, innermost when tables nest, with the rows beside it. */
interface Located { readonly paragraph: Element; readonly siblings: Element[]; readonly parent: Element; readonly row?: { readonly row: Element; readonly rows: Element[] } }
/** Every paragraph a read lists in a part, with the location the read gives it now. */
function listed(tree: Element[]): (Located & { readonly location: string })[] {
  const root = tree.find(node => !tagOf(node).startsWith('?') && !tagOf(node).startsWith('#'))
  if (!root) throw targetError('This part has no root element')
  const found: (Located & { readonly location: string })[] = []
  const walk = (parent: Element, path: string, row: Located['row']) => {
    const counts: Record<string, number> = {}
    const siblings = kids(parent)
    for (const node of siblings) {
      const tag = localName(tagOf(node))
      counts[tag] = (counts[tag] ?? 0) + 1
      const location = (path ? path + '.' : '') + shortStep(tag, counts[tag])
      if (tag === 'p') found.push({ paragraph: node, siblings, parent, location, ...(row ? { row } : {}) })
      else walk(node, location, tag === 'tr' ? { row: node, rows: siblings } : tag === 'tbl' ? undefined : row)
    }
  }
  walk(find(kids(root), 'body') ?? root, '', undefined)
  return found
}
/** Follow a location as `read_attachment` writes it, or as earlier versions wrote it. @returns the element there, if one is. */
function nodeAt(tree: Element[], location: string): Element | undefined {
  const parsed = parseLocation(location)
  if (!parsed) throw targetError('Unknown location: ' + location)
  let siblings = tree
  if (parsed.fromBody) {
    const root = tree.find(node => !tagOf(node).startsWith('?') && !tagOf(node).startsWith('#'))
    if (!root) throw targetError('This part has no root element')
    siblings = kids(find(kids(root), 'body') ?? root)
  }
  let node: Element | undefined
  for (const { tag, index } of parsed.steps) {
    if (node) siblings = kids(node)
    node = all(siblings, tag)[index - 1]
    if (!node) return undefined
  }
  return node
}
/** @returns the paragraph at a location, if one is there. */
function locate(tree: Element[], location: string): Element | undefined {
  const node = nodeAt(tree, location)
  return node && isElement(node, 'p') ? node : undefined
}
/** A table cell and the paragraphs it holds directly. */
interface CellTarget { readonly cell: Element; readonly paragraphs: Located[] }
/** The table cell a location names, or the one that holds the paragraph it names. */
function cellAt(tree: Element[], paragraphs: readonly Located[], change: ParagraphChange): CellTarget {
  const cell = nodeAt(tree, change.location.replace(/\.p\d+$/u, ''))
  if (!cell || !isElement(cell, 'tc')) throw targetError(`${change.location} is not a table cell; set_cell takes a location such as t1.r2.c3, and other text takes replace`)
  if (find(kids(cell), 'tbl')) throw targetError(`${change.location} holds a table of its own; change its paragraphs one by one`)
  const own = paragraphs.filter(item => item.parent === cell)
  const text = own.map(item => textIn(item.paragraph)).join('\n')
  if (change.expected && text !== change.expected && !(change.expected.length >= EXPECTED_START && text.startsWith(change.expected))) throw targetError(`${change.location} now reads ${JSON.stringify(text.slice(0, 200))}; leave expected out to write the cell whatever it holds`)
  return { cell, paragraphs: own }
}
/**
 * Give a table cell its whole text, one paragraph per line. Paragraphs the cell has take the lines in order,
 * further lines become paragraphs that look like the one before, and paragraphs left over are removed.
 * @returns the paragraphs the cell now holds.
 */
function setCell(target: CellTarget, value: string, revisions: Revisions | undefined): Element[] {
  const lines = value.split('\n')
  const written: Element[] = []
  let last = target.paragraphs[0]!
  lines.forEach((line, index) => {
    const existing = target.paragraphs[index]
    if (existing) { replaceText(existing.paragraph, line, revisions); last = existing }
    else last = { ...last, paragraph: insertParagraph(last, line, revisions) }
    written.push(last.paragraph)
  })
  for (const extra of target.paragraphs.slice(lines.length)) deleteParagraph(extra, revisions)
  return written
}
/**
 * The paragraph a change means. An earlier change in the same reply may have moved it, so when the
 * location no longer holds the expected text, the one paragraph of the part that reads so is taken.
 * @param paragraphs - every paragraph of the part, as `listed` gives them.
 */
/** A long paragraph is named by how it begins, so a change need not repeat all of it. */
const EXPECTED_START = 20
const reads = (paragraph: Element, expected: string): boolean => { const text = textIn(paragraph); return text === expected || (expected.length >= EXPECTED_START && text.startsWith(expected)) }
function resolve(tree: Element[], paragraphs: readonly (Located & { readonly location: string })[], change: ParagraphChange): Located {
  const expected = change.expected ?? ''
  const at = locate(tree, change.location)
  const direct = at && paragraphs.find(item => item.paragraph === at)
  if (direct && reads(direct.paragraph, expected)) return direct
  const same = expected ? paragraphs.filter(item => reads(item.paragraph, expected)) : []
  if (same.length === 1) return same[0]!
  if (same.length > 1) throw targetError(`${change.location} no longer reads as expected, and ${same.length} paragraphs read so, at ${same.slice(0, 8).map(item => item.location).join(', ')}; give the location of the one you mean`)
  throw targetError(at ? `${change.location} now reads ${JSON.stringify(textIn(at).slice(0, 200))}; read the file again` : 'Nothing at ' + change.location + '; read the file again')
}
/** Run properties in the order Word writes them, so a property added to a run lands where Word expects it. */
const RUN_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange']
/** What follows `jc` in paragraph properties. */
const AFTER_ALIGNMENT = ['textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']
const ALIGNMENT = { left: 'left', center: 'center', right: 'right', justify: 'both' } as const
/** Replace a property, or add it before the first property that Word writes after it. */
function setProperty(list: Element[], prefix: string, name: string, attrs: Record<string, string>, after: readonly string[]): void {
  const fresh = element(prefix + name, Object.fromEntries(Object.entries(attrs).map(([key, value]) => [prefix + key, escapeXml(value)])))
  const current = list.findIndex(node => isElement(node, name))
  if (current >= 0) { list[current] = fresh; return }
  const next = list.findIndex(node => after.includes(localName(tagOf(node))))
  list.splice(next < 0 ? list.length : next, 0, fresh)
}
function formatRun(properties: Element[], prefix: string, format: ParagraphFormat): void {
  const set = (name: string, attrs: Record<string, string>) => { setProperty(properties, prefix, name, attrs, RUN_ORDER.slice(RUN_ORDER.indexOf(name) + 1)) }
  const toggle = (name: string, on: boolean | undefined) => { if (on !== undefined) set(name, on ? {} : { val: '0' }) }
  if (format.font !== undefined) {
    // Theme font attributes win over named fonts, so a run that carries them would keep its old font.
    const kept = Object.fromEntries(Object.entries((find(properties, 'rFonts')?.[':@'] ?? {}) as Record<string, string>).filter(([key]) => key.endsWith(':hint')).map(([key, value]) => [key.slice(2 + prefix.length), value]))
    set('rFonts', { ...kept, ascii: format.font, hAnsi: format.font, eastAsia: format.font, cs: format.font })
  }
  toggle('b', format.bold)
  toggle('i', format.italic)
  if (format.color !== undefined) set('color', { val: format.color.replace('#', '').toUpperCase() })
  if (format.size !== undefined) { set('sz', { val: String(Math.round(format.size * 2)) }); set('szCs', { val: String(Math.round(format.size * 2)) }) }
  if (format.highlight !== undefined) set('highlight', { val: format.highlight })
  if (format.underline !== undefined) set('u', { val: format.underline ? 'single' : 'none' })
}
/** Give a whole paragraph one look: its alignment, every run that holds text, and the paragraph mark, which later text there takes after. */
function formatParagraph(paragraph: Element, format: ParagraphFormat): void {
  const prefix = prefixOf(tagOf(paragraph))
  const list = kids(paragraph)
  let properties = find(list, 'pPr')
  if (!properties) { properties = element(prefix + 'pPr'); list.unshift(properties) }
  const inner = kids(properties)
  if (format.align !== undefined) setProperty(inner, prefix, 'jc', { val: ALIGNMENT[format.align] }, AFTER_ALIGNMENT)
  const { align: _align, ...look } = format
  if (!Object.keys(look).length) return
  let mark = find(inner, 'rPr')
  if (!mark) {
    mark = element(prefix + 'rPr')
    const tail = inner.findIndex(node => isElement(node, 'sectPr') || isElement(node, 'pPrChange'))
    inner.splice(tail < 0 ? inner.length : tail, 0, mark)
  }
  formatRun(kids(mark), prefix, look)
  for (const piece of textPieces(paragraph)) {
    const runKids = kids(piece.run)
    let own = find(runKids, 'rPr')
    if (!own) { own = element(prefixOf(tagOf(piece.run)) + 'rPr'); runKids.unshift(own) }
    formatRun(kids(own), prefixOf(tagOf(piece.run)), look)
  }
}
/** The grid column each cell of a row starts at. */
function columnsOf(row: Element): { readonly cell: Element; readonly column: number }[] {
  let column = 0
  return all(kids(row), 'tc').map(cell => {
    const at = column
    const span = find(kids(find(kids(cell), 'tcPr') ?? element('')), 'gridSpan')
    column += Math.max(1, Number(span ? getAttr(span, prefixOf(tagOf(span)) + 'val') : 1) || 1)
    return { cell, column: at }
  })
}
const mergeOf = (cell: Element): Element | undefined => find(kids(find(kids(cell), 'tcPr') ?? element('')), 'vMerge')
const startsMerge = (merge: Element): boolean => getAttr(merge, prefixOf(tagOf(merge)) + 'val') === 'restart'
/**
 * Add a row built like the one given: the same cells, widths, shading and merges, each cell holding one paragraph
 * that looks like the first paragraph of the cell above it. A cell merged down goes on through the new row.
 * @returns the new row's paragraphs.
 */
function insertRow(target: Located, texts: readonly string[]): Element[] {
  if (!target.row) throw targetError('insert_row_after needs the location of a paragraph inside the table row to copy')
  const { row, rows } = target.row
  const prefix = prefixOf(tagOf(row))
  const cells = all(kids(row), 'tc')
  if (texts.length > cells.length) throw targetError(`This row has ${cells.length} cells, and ${texts.length} texts were given`)
  const paragraphs: Element[] = []
  const fresh = element(tagOf(row), {}, kids(row).flatMap(node => {
    if (isElement(node, 'trPr')) return [element(tagOf(node), {}, structuredClone(kids(node).filter(item => !['ins', 'del', 'tblHeader', 'trPrChange'].includes(localName(tagOf(item))))))]
    if (isElement(node, 'tblPrEx')) return [structuredClone(node)]
    if (!isElement(node, 'tc')) return []
    const cellProperties = find(kids(node), 'tcPr')
    const copied = cellProperties && element(tagOf(cellProperties), {}, structuredClone(kids(cellProperties).filter(item => !['cellIns', 'cellDel', 'cellMerge', 'tcPrChange'].includes(localName(tagOf(item))))))
    const merge = copied && find(kids(copied), 'vMerge')
    if (merge) dropAttr(merge, prefixOf(tagOf(merge)) + 'val')
    const model = find(kids(node), 'p')
    const source = model && find(kids(model), 'pPr')
    const properties = source && element(tagOf(source), {}, structuredClone(kids(source).filter(item => !isElement(item, 'sectPr') && !isElement(item, 'pPrChange'))))
    const mark = properties && find(kids(properties), 'rPr')
    if (mark) kids(mark).splice(0, Infinity, ...kids(mark).filter(item => !isElement(item, 'ins') && !isElement(item, 'del')))
    const value = merge ? '' : texts[paragraphs.length] ?? ''
    const look = model && (runProperties(textPieces(model)[0]?.run) ?? mark)
    const paragraph = element(prefix + 'p', {}, [...(properties ? [properties] : []), ...(value ? [textRun(prefix, look, value)] : [])])
    paragraphs.push(paragraph)
    return [element(tagOf(node), {}, [...(copied ? [copied] : []), paragraph])]
  }))
  rows.splice(rows.indexOf(row) + 1, 0, fresh)
  return paragraphs
}
/** Remove a table row. A cell merged down that starts in it starts in the next row instead. */
function deleteRow(target: Located): void {
  if (!target.row) throw targetError('delete_row needs the location of a paragraph inside the table row to remove')
  const { row, rows } = target.row
  const others = all(rows, 'tr').filter(item => item !== row)
  if (!others.length) throw targetError('This is the only row of its table, which must stay')
  for (const paragraph of deep(kids(row), 'p')) pieces(paragraph).forEach(refuseObjects)
  for (const [start, end] of PAIRED) {
    const ids = (name: string) => deep(kids(row), name).map(node => getAttr(node, tagOf(node).replace(/[^:]*$/u, 'id'))).sort().join()
    if (ids(start) !== ids(end)) throw targetError('A bookmark or comment reaches outside this row, so it cannot be deleted')
  }
  const below = all(rows.slice(rows.indexOf(row) + 1), 'tr')[0]
  for (const { cell, column } of columnsOf(row)) {
    const merge = mergeOf(cell)
    if (!merge || !startsMerge(merge)) continue
    const next = below && mergeOf(columnsOf(below).find(item => item.column === column)?.cell ?? element(''))
    if (next && !startsMerge(next)) setAttr(next, prefixOf(tagOf(next)) + 'val', 'restart')
  }
  rows.splice(rows.indexOf(row), 1)
}
/**
 * @param track - write the changes as tracked changes Word can accept or reject.
 * @param limit - bound on the inflated package.
 * @returns the document with only the parts that hold these paragraphs rewritten, and each replaced or inserted paragraph as a read now lists it.
 */
export function editDocument(bytes: Uint8Array, changes: readonly ParagraphChange[], track: boolean, limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly changed: readonly ChangedParagraph[] } {
  signal.throwIfAborted()
  const office = OfficePackage.open(bytes, limit, signal, true)
  const rewritten = new Map<string, Uint8Array>()
  const changed: ChangedParagraph[] = []
  for (const part of new Set(changes.map(change => change.part ?? MAIN))) {
    if (!EDITABLE.test(part) || !office.has(part)) throw targetError('Not an editable part of this document: ' + part)
    const source = office.source(part)
    const tree = parseTree(source)
    // Locations describe the file as read, so they all resolve before any change moves things.
    const paragraphs = listed(tree)
    const targets = changes.filter(change => (change.part ?? MAIN) === part).map(change => {
      const cell = change.action === 'set_cell' ? cellAt(tree, paragraphs, change) : undefined
      return { change, cell, target: cell ? cell.paragraphs[0]! : resolve(tree, paragraphs, change) }
    })
    const claimed = targets.filter(item => !ROW_ACTIONS.has(item.change.action)).flatMap(item => item.cell ? item.cell.paragraphs.map(own => own.paragraph) : [item.target.paragraph])
    if (new Set(claimed).size !== claimed.length) throw targetError('Each paragraph takes one change; put a paragraph\'s whole new text and look in one replace, or a cell\'s in one set_cell')
    if (track && targets.some(item => ROW_ACTIONS.has(item.change.action) || item.change.format)) throw targetError('Looks and table rows cannot be written as tracked changes; make those changes without track')
    const revisions = track ? new Revisions(prefixOf(tagOf(targets[0]!.target.paragraph)), source) : undefined
    const written: Element[] = []
    const cells: Element[][] = []
    for (const { change, cell, target } of targets) {
      const fresh: Element[] = []
      switch (change.action) {
        case 'set_cell': fresh.push(...setCell(cell!, change.text ?? '', revisions)); cells.push(fresh); break
        case 'replace': replaceText(target.paragraph, change.text ?? '', revisions); fresh.push(target.paragraph); break
        case 'insert_after': fresh.push(insertParagraph(target, change.text ?? '', revisions)); break
        case 'format': fresh.push(target.paragraph); break
        case 'insert_row_after': fresh.push(...insertRow(target, change.cells ?? [])); break
        case 'delete_row': deleteRow(target); break
        case 'delete': deleteParagraph(target, revisions); break
      }
      if (change.format) for (const paragraph of fresh) formatParagraph(paragraph, change.format)
      if (change.action !== 'set_cell') written.push(...fresh)
    }
    const now = listed(tree)
    for (const item of now) if (written.includes(item.paragraph)) changed.push({ part, location: item.location, text: textIn(item.paragraph), characters: [...textIn(item.paragraph)].length })
    // A cell is reported whole, since a limit a form sets is on the cell and not on each paragraph.
    for (const own of cells) {
      const lines = own.map(textIn)
      changed.push({ part, location: now.find(item => item.paragraph === own[0])!.location.replace(/\.p\d+$/u, ''), text: lines.join('\n'), characters: lines.reduce((total, line) => total + [...line].length, 0), paragraphs: own.length })
    }
    rewritten.set(part, buildTree(tree))
  }
  return { bytes: office.rewrite(rewritten), changed }
}
/**
 * Fill `{{name}}` placeholders, keeping the formatting of the text around each one.
 * @returns the document, and the placeholders it still has.
 */
export async function fillTemplate(bytes: Uint8Array, values: Readonly<Record<string, string>>, limit: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly unfilled: readonly string[] }> {
  signal.throwIfAborted()
  OfficePackage.open(bytes, limit, signal)
  const names = new Set(await patchDetector({ data: bytes }))
  if (!names.size) throw targetError('This document has no {{name}} placeholders')
  // Each placeholder is filled in its own pass, so a later one would rewrite a value that looks like it.
  if (Object.values(values).some(value => /\{\{.*\}\}/su.test(value))) throw targetError('A value cannot contain a {{name}} placeholder')
  const unknown = Object.keys(values).filter(name => !names.has(name))
  if (unknown.length) throw targetError(`No placeholder named ${unknown.join(', ')}; this document has ${[...names].join(', ')}`)
  const patches = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { type: PatchType.PARAGRAPH, children: value.split('\n').map((line, index) => new TextRun({ text: line, ...(index ? { break: 1 } : {}) })) }]))
  const filled = await patchDocument({ outputType: 'uint8array', data: bytes, patches, keepOriginalStyles: true })
  signal.throwIfAborted()
  return { bytes: filled, unfilled: [...names].filter(name => !Object.hasOwn(values, name)) }
}
