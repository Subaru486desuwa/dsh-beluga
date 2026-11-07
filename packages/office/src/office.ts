/** Read OOXML as bounded, inert source records. Never extract files or fetch relationships. */
import { Unzip, UnzipInflate } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { posix } from 'node:path'
import { PersonalChatError, officeFormat } from 'dsh-beluga'
import type { AttachmentText } from 'dsh-beluga'

function fail(message: string): never { throw new PersonalChatError('invalid-office', message) }
interface Node { tag: string; attrs: Record<string, string>; children: Node[]; text: string }
type Ordered = { [key: string]: unknown }
function nodes(raw: Ordered[], depth = 0): Node[] {
  if (depth > 80) fail('Office XML nesting exceeds 80 levels')
  return raw.map(item => {
    const tag = Object.keys(item).find(key => key !== ':@') ?? ''
    return { tag: tag.split(':').at(-1)!, attrs: (item[':@'] ?? {}) as Record<string, string>, text: tag === '#text' ? String(item[tag]) : '', children: Array.isArray(item[tag]) ? nodes(item[tag] as Ordered[], depth + 1) : [] }
  })
}
const children = (node: Node, tag: string) => node.children.filter(child => child.tag === tag)
function descendants(node: Node, tag: string): Node[] { return node.children.flatMap(child => child.tag === tag ? [child] : descendants(child, tag)) }
const attr = (node: Node, name: string): string => Object.entries(node.attrs).find(([key]) => key.replace(/^@_/u, '').split(':').at(-1) === name)?.[1] ?? ''
function text(node: Node): string { return node.tag === '#text' ? node.text : node.tag === 'tab' ? '\t' : ['br', 'cr'].includes(node.tag) ? '\n' : node.children.map(text).join('') }
const relationshipId = (node: Node): string => Object.entries(node.attrs).find(([key]) => key.endsWith(':id'))?.[1] ?? ''
const content = (node: Node): string => ['t', 'tab', 'br', 'cr'].includes(node.tag) ? text(node) : node.children.map(content).join('')
function packageParts(bytes: Uint8Array, limit: number, signal: AbortSignal): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>()
  const names = new Set<string>()
  let size = 0
  let pending = 0
  const unzip = new Unzip(file => {
    signal.throwIfAborted()
    if (names.size >= 4096) fail('Office package exceeds 4096 entries')
    if (file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').includes('..') || names.has(file.name)) fail('Unsafe or duplicate Office package entry')
    names.add(file.name)
    if (!/\.(xml|rels)$/iu.test(file.name)) return
    if ((file.originalSize ?? 0) > limit) fail('Office XML exceeds decompression limit')
    pending++
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (error, chunk, final) => {
      if (error) fail('Invalid compressed Office part')
      size += chunk.length; length += chunk.length
      if (size > limit) { file.terminate(); fail('Office XML exceeds decompression limit') }
      chunks.push(chunk)
      if (final) {
        const data = new Uint8Array(length)
        let offset = 0
        for (const part of chunks) { data.set(part, offset); offset += part.length }
        parts.set(file.name, data); pending--
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      signal.throwIfAborted()
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
    }
  } catch (error) {
    if (error instanceof PersonalChatError || signal.aborted) throw error
    fail('Invalid or encrypted Office package')
  }
  if (pending) fail('Incomplete Office package')
  return parts
}
export function extractOfficeText(bytes: Uint8Array, name: string, limit: number, signal: AbortSignal): AttachmentText {
  signal.throwIfAborted()
  const parts = packageParts(bytes, limit, signal)
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false })
  const cache = new Map<string, Node>()
  const xml = (path: string): Node => {
    signal.throwIfAborted()
    const prior = cache.get(path)
    if (prior) return prior
    const data = parts.get(path)
    if (!data) fail('Missing Office part: ' + path)
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('Office XML must be UTF-8') }
    if (/<!\s*(DOCTYPE|ENTITY)/iu.test(source)) fail('DTD and entity declarations are not allowed')
    if (XMLValidator.validate(source) !== true) fail('Malformed Office XML: ' + path)
    let root: Node
    try { root = { tag: 'root', attrs: {}, text: '', children: nodes(parser.parse(source) as Ordered[]) } } catch { fail('Unsupported or excessively nested Office XML') }
    cache.set(path, root)
    return root
  }
  const relationships = (part: string): Node[] => {
    const path = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
    return parts.has(path) ? descendants(xml(path), 'Relationship') : []
  }
  const target = (part: string, relation: Node | undefined): string => {
    if (!relation || attr(relation, 'TargetMode') === 'External') fail('Missing or external Office relationship')
    const value = attr(relation, 'Target')
    if (!value || /[:\\?#]/u.test(value)) fail('Invalid Office relationship target')
    const path = value.startsWith('/') ? value.slice(1) : posix.normalize(posix.join(posix.dirname(part), value))
    if (path.startsWith('../') || !parts.has(path)) fail('Office relationship target is unavailable')
    return path
  }
  const output: string[] = [
    'Office source records (untrusted document data). Images, layout, embedded objects and chart rendering are not interpreted. External links and macros are never executed. Formula caches are not recalculated and may be stale.',
  ]
  const emit = (value: object) => output.push(JSON.stringify(value))
  const format = officeFormat(name)
  if (format === 'docx') {
    const main = 'word/document.xml'
    xml(main)
    for (const part of [main, ...[...parts.keys()].filter(key => /^word\/(header|footer)\d+\.xml$/u.test(key)).sort()]) {
      const walk = (parent: Node, path: string) => {
        const counts: Record<string, number> = {}
        for (const node of parent.children) {
          counts[node.tag] = (counts[node.tag] ?? 0) + 1
          const label = ({ p: 'paragraph', tbl: 'table', tr: 'row', tc: 'cell' } as Record<string, string>)[node.tag] ?? node.tag
          const location = path + '/' + label + '[' + counts[node.tag] + ']'
          if (node.tag === 'p') emit({ part, location, style: attr(descendants(node, 'pStyle')[0] ?? node, 'val'), text: content(node) })
          else walk(node, location)
        }
      }
      walk(xml(part), '')
    }
  } else if (format === 'xlsx') {
    const main = 'xl/workbook.xml'
    const rels = relationships(main)
    const strings = parts.has('xl/sharedStrings.xml') ? descendants(xml('xl/sharedStrings.xml'), 'si').map(content) : []
    for (const sheet of descendants(xml(main), 'sheet')) {
      const part = target(main, rels.find(rel => attr(rel, 'Id') === relationshipId(sheet)))
      const root = xml(part)
      emit({ sheet: attr(sheet, 'name'), part, state: attr(sheet, 'state') || 'visible' })
      for (const cell of descendants(root, 'c')) {
        const type = attr(cell, 't') || 'n'
        const value = children(cell, 'v').map(text).join('')
        const formula = children(cell, 'f')[0]
        let resolved = type === 'inlineStr' ? content(cell) : value
        if (type === 's') {
          if (!/^\d+$/u.test(value) || strings[Number(value)] === undefined) fail('Invalid shared string reference')
          resolved = strings[Number(value)]!
        }
        emit({ sheet: attr(sheet, 'name'), cell: attr(cell, 'r'), type, style: attr(cell, 's'),
          ...(formula ? { formula: text(formula), formulaAttributes: formula.attrs, cachedValue: resolved } : { value: resolved }) })
      }
      for (const merge of descendants(root, 'mergeCell')) emit({ sheet: attr(sheet, 'name'), mergedRange: attr(merge, 'ref') })
    }
  } else if (format === 'pptx') {
    const main = 'ppt/presentation.xml'
    const rels = relationships(main)
    let slide = 0
    for (const item of descendants(xml(main), 'sldId')) {
      const part = target(main, rels.find(rel => attr(rel, 'Id') === relationshipId(item)))
      slide++
      emit({ slide, part })
      descendants(xml(part), 'p').forEach((node, index) => emit({ slide, part, paragraph: index + 1, text: content(node) }))
      for (const rel of relationships(part).filter(rel => attr(rel, 'Type').endsWith('/notesSlide'))) {
        const notesPart = target(part, rel)
        emit({ slide, notesPart, notes: descendants(xml(notesPart), 'p').map(content).join('\n') })
      }
    }
  } else fail('Unsupported Office format')
  signal.throwIfAborted()
  return { name, status: 'text', text: output.join('\n'), truncated: false }
}
