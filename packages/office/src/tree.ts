/** An editable XML tree. Attributes and text pass through as written, so a rewrite changes only what an edit changes. */
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { fail } from './package.ts'

export interface Element { [key: string]: unknown }
const shape = { preserveOrder: true, ignoreAttributes: false, processEntities: false, commentPropName: '#comment', cdataPropName: '#cdata' }
const parser = new XMLParser({ ...shape, parseTagValue: false, parseAttributeValue: false, trimValues: false })
const builder = new XMLBuilder({ ...shape, suppressBooleanAttributes: false, suppressEmptyNode: true, format: false })
export const parseTree = (source: string): Element[] => parser.parse(source) as Element[]
export const buildTree = (tree: readonly Element[]): Uint8Array => new TextEncoder().encode(builder.build(tree) as string)
export const tagOf = (node: Element): string => Object.keys(node).find(key => key !== ':@') ?? ''
export const localName = (tag: string): string => tag.split(':').at(-1)!
/** @returns the namespace prefix a part uses, so new elements match their neighbours. */
export const prefixOf = (tag: string): string => tag.includes(':') ? tag.slice(0, tag.indexOf(':') + 1) : ''
export const isElement = (node: Element, name: string): boolean => localName(tagOf(node)) === name
export const kids = (node: Element): Element[] => { const value = node[tagOf(node)]; return Array.isArray(value) ? value as Element[] : [] }
export const find = (nodes: readonly Element[], name: string): Element | undefined => nodes.find(node => isElement(node, name))
export function require(nodes: readonly Element[], name: string): Element { return find(nodes, name) ?? fail('Missing Office element: ' + name) }
export const all = (nodes: readonly Element[], name: string): Element[] => nodes.filter(node => isElement(node, name))
/** Every element of one name below these nodes, in document order. */
export function deep(nodes: readonly Element[], name: string): Element[] { return nodes.flatMap(node => isElement(node, name) ? [node] : deep(kids(node), name)) }
const attributes = (node: Element): Record<string, string> => (node[':@'] ??= {}) as Record<string, string>
export const getAttr = (node: Element, name: string): string | undefined => attributes(node)['@_' + name]
export function setAttr(node: Element, name: string, value: string): void { attributes(node)['@_' + name] = value }
export function dropAttr(node: Element, name: string): void { delete attributes(node)['@_' + name] }
export function element(tag: string, attrs: Record<string, string> = {}, children: Element[] = []): Element {
  return { [tag]: children, ':@': Object.fromEntries(Object.entries(attrs).map(([key, value]) => ['@_' + key, value])) }
}
export const escapeXml = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export const unescapeXml = (value: string): string => value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/giu, (_, decimal?: string, hex?: string, name?: string) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ENTITIES[name!]!)
export const textNode = (value: string): Element => ({ '#text': escapeXml(value) })
export const textOf = (node: Element): string => kids(node).map(child => typeof child['#text'] === 'string' ? child['#text'] : '').join('')
