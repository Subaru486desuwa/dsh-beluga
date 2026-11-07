/**
 * Change paragraphs of any DOCX. Runs are split only where a change begins and ends, so the formatting
 * around it stays, and every part without a change keeps its exact content.
 */
import { PatchType, TextRun, patchDetector, patchDocument } from 'docx'
import { PersonalChatError } from 'dsh-beluga'
import type { ParagraphChange } from 'dsh-beluga'
import { OfficePackage } from './package.ts'
import { all, buildTree, deep, element, find, getAttr, isElement, kids, localName, parseTree, prefixOf, tagOf, textNode, textOf, unescapeXml, type Element } from './tree.ts'

const MAIN = 'word/document.xml'
const EDITABLE = /^word\/(?:document|header\d+|footer\d+)\.xml$/u
const AUTHOR = 'Beluga'
const LOCATION_TAGS: Readonly<Record<string, string>> = { paragraph: 'p', table: 'tbl', row: 'tr', cell: 'tc' }
/** What a reader of the document sees as text. */
const TEXT = new Set(['t', 'tab', 'br', 'cr'])
/** Removing these with a run loses nothing. Anything else in a run is an image, a field or the like. */
const DISPOSABLE = new Set(['rPr', 'lastRenderedPageBreak'])
/** Property lists, and text a tracked change already removed. */
const NOT_TEXT = new Set(['pPr', 'del', 'moveFrom'])
const INSERTED = new Set(['ins', 'moveTo'])
const PAIRED = [['bookmarkStart', 'bookmarkEnd'], ['commentRangeStart', 'commentRangeEnd']] as const

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
function insertParagraph(target: Located, value: string, revisions: Revisions | undefined): void {
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
interface Located { readonly paragraph: Element; readonly siblings: Element[]; readonly parent: Element }
/** Follow a location as `read_attachment` writes it. */
function locate(tree: Element[], location: string): Located {
  let parent: Element = {}
  let siblings = tree
  let node: Element | undefined
  for (const step of location.split('/').filter(Boolean)) {
    const match = /^(.+)\[([1-9]\d*)\]$/u.exec(step)
    if (!match) throw targetError('Unknown location: ' + location)
    if (node) { parent = node; siblings = kids(node) }
    node = all(siblings, LOCATION_TAGS[match[1]!] ?? match[1]!)[Number(match[2]) - 1]
    if (!node) throw targetError('Nothing at ' + location + '; read the file again')
  }
  if (!node || !isElement(node, 'p')) throw targetError('Not a paragraph: ' + location)
  return { paragraph: node, siblings, parent }
}
/**
 * @param track - write the changes as tracked changes Word can accept or reject.
 * @param limit - bound on the inflated package.
 * @returns the document with only the parts that hold these paragraphs rewritten.
 */
export function editDocument(bytes: Uint8Array, changes: readonly ParagraphChange[], track: boolean, limit: number, signal: AbortSignal): Uint8Array {
  signal.throwIfAborted()
  const office = OfficePackage.open(bytes, limit, signal, true)
  const rewritten = new Map<string, Uint8Array>()
  for (const part of new Set(changes.map(change => change.part ?? MAIN))) {
    if (!EDITABLE.test(part) || !office.has(part)) throw targetError('Not an editable part of this document: ' + part)
    const source = office.source(part)
    const tree = parseTree(source)
    const here = changes.filter(change => (change.part ?? MAIN) === part)
    if (new Set(here.map(change => change.location)).size !== here.length) throw targetError('Each paragraph takes one change; put a paragraph\'s whole new text in one replace')
    // Locations describe the file as read, so they all resolve before any change moves things.
    const targets = here.map(change => {
      const target = locate(tree, change.location)
      const current = textIn(target.paragraph)
      if (current !== change.expected) throw targetError(`${change.location} now reads ${JSON.stringify(current.slice(0, 200))}; read the file again`)
      return { change, target }
    })
    const revisions = track ? new Revisions(prefixOf(tagOf(targets[0]!.target.paragraph)), source) : undefined
    for (const { change, target } of targets) {
      if (change.action === 'replace') replaceText(target.paragraph, change.text ?? '', revisions)
      else if (change.action === 'insert_after') insertParagraph(target, change.text ?? '', revisions)
      else deleteParagraph(target, revisions)
    }
    rewritten.set(part, buildTree(tree))
  }
  return office.rewrite(rewritten)
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
