/** Read and rewrite OOXML as bounded, inert parts. Never extract files or fetch relationships. */
import { Unzip, UnzipInflate, zipSync, type Zippable } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { posix } from 'node:path'
import { PersonalChatError } from 'dsh-beluga'

export function fail(message: string): never { throw new PersonalChatError('invalid-office', message) }
export interface Node { tag: string; attrs: Record<string, string>; children: Node[]; text: string }
type Ordered = { [key: string]: unknown }
function nodes(raw: Ordered[], depth = 0): Node[] {
  if (depth > 80) fail('Office XML nesting exceeds 80 levels')
  return raw.map(item => {
    const tag = Object.keys(item).find(key => key !== ':@') ?? ''
    return { tag: tag.split(':').at(-1)!, attrs: (item[':@'] ?? {}) as Record<string, string>, text: tag === '#text' ? String(item[tag]) : '', children: Array.isArray(item[tag]) ? nodes(item[tag] as Ordered[], depth + 1) : [] }
  })
}
export const children = (node: Node, tag: string) => node.children.filter(child => child.tag === tag)
export function descendants(node: Node, tag: string): Node[] { return node.children.flatMap(child => child.tag === tag ? [child] : descendants(child, tag)) }
export const attr = (node: Node, name: string): string => Object.entries(node.attrs).find(([key]) => key.replace(/^@_/u, '').split(':').at(-1) === name)?.[1] ?? ''
export function text(node: Node): string { return node.tag === '#text' ? node.text : node.tag === 'tab' ? '\t' : ['br', 'cr'].includes(node.tag) ? '\n' : node.children.map(text).join('') }
export const relationshipId = (node: Node): string => Object.entries(node.attrs).find(([key]) => key.endsWith(':id'))?.[1] ?? ''
export const content = (node: Node): string => ['t', 'tab', 'br', 'cr'].includes(node.tag) ? text(node) : ['pPr', 'del', 'moveFrom'].includes(node.tag) ? '' : node.children.map(content).join('')
function packageParts(bytes: Uint8Array, limit: number, signal: AbortSignal, every: boolean): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>()
  const names = new Set<string>()
  let size = 0
  let pending = 0
  const unzip = new Unzip(file => {
    signal.throwIfAborted()
    if (names.size >= 4096) fail('Office package exceeds 4096 entries')
    if (file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').includes('..') || names.has(file.name)) fail('Unsafe or duplicate Office package entry')
    names.add(file.name)
    if (file.name.endsWith('/') || (!every && !/\.(xml|rels)$/iu.test(file.name))) return
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
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false })
/** One opened package. Parts stay in memory, so Temporary Chat files can pass through it. */
export class OfficePackage {
  private readonly cache = new Map<string, Node>()
  private constructor(private readonly parts: Map<string, Uint8Array>, private readonly signal: AbortSignal) {}
  /**
   * @param limit - bound on the total inflated size.
   * @param every - keep binary parts too, which a rewrite needs and a read does not.
   */
  static open(bytes: Uint8Array, limit: number, signal: AbortSignal, every = false): OfficePackage {
    return new OfficePackage(packageParts(bytes, limit, signal, every), signal)
  }
  has(path: string): boolean { return this.parts.has(path) }
  names(): string[] { return [...this.parts.keys()] }
  /** @returns the validated XML of one part. */
  source(path: string): string {
    this.signal.throwIfAborted()
    const data = this.parts.get(path)
    if (!data) fail('Missing Office part: ' + path)
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('Office XML must be UTF-8') }
    if (/<!\s*(DOCTYPE|ENTITY)/iu.test(source)) fail('DTD and entity declarations are not allowed')
    if (XMLValidator.validate(source) !== true) fail('Malformed Office XML: ' + path)
    return source
  }
  xml(path: string): Node {
    const prior = this.cache.get(path)
    if (prior) return prior
    const source = this.source(path)
    let root: Node
    try { root = { tag: 'root', attrs: {}, text: '', children: nodes(parser.parse(source) as Ordered[]) } } catch { fail('Unsupported or excessively nested Office XML') }
    this.cache.set(path, root)
    return root
  }
  relationships(part: string): Node[] {
    const path = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
    return this.parts.has(path) ? descendants(this.xml(path), 'Relationship') : []
  }
  target(part: string, relation: Node | undefined): string {
    if (!relation || attr(relation, 'TargetMode') === 'External') fail('Missing or external Office relationship')
    const value = attr(relation, 'Target')
    if (!value || /[:\\?#]/u.test(value)) fail('Invalid Office relationship target')
    const path = value.startsWith('/') ? value.slice(1) : posix.normalize(posix.join(posix.dirname(part), value))
    if (path.startsWith('../') || !this.parts.has(path)) fail('Office relationship target is unavailable')
    return path
  }
  /** @returns the package again, with these parts replaced, or removed when given undefined; the rest keep their exact content. */
  rewrite(changes: ReadonlyMap<string, Uint8Array | undefined>): Uint8Array {
    const files: Zippable = {}
    for (const [name, data] of this.parts) {
      const next = changes.has(name) ? changes.get(name) : data
      if (next) files[name] = next
    }
    for (const [name, data] of changes) if (data && !this.parts.has(name)) files[name] = data
    return zipSync(files, { level: 6 })
  }
}
