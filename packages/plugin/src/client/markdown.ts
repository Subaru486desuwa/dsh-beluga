import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root, RootContent, Definition } from 'mdast'

/** Prose separators; code and formulas do not read well aloud. */
const SPOKEN_BLOCKS = new Set(['heading', 'paragraph', 'tableCell'])
/** @returns the words of a Markdown reply, for speech. */
export function speakable(text: string): string {
  const parts: string[] = []
  const walk = (node: Root | RootContent): void => {
    if (node.type === 'text' || node.type === 'inlineCode') parts.push(node.value)
    else if ('children' in node) for (const child of node.children) walk(child)
    if (SPOKEN_BLOCKS.has(node.type)) parts.push(' ')
  }
  walk(fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] }))
  return parts.join('').replace(/\s+/gu, ' ').trim()
}

/** Keep original Markdown offsets; only image nodes become explicit links. */
export function withoutRemoteImages(text: string, label: string, streaming = false): string {
  // Match the public renderer: streaming uses GFM, settled text also parses math.
  const root = fromMarkdown(text, { extensions: [gfm(), ...(streaming ? [] : [math()])], mdastExtensions: [gfmFromMarkdown(), ...(streaming ? [] : [mathFromMarkdown()])] })
  const definitions = new Map<string, Definition>()
  const replacements: { start: number; end: number; text: string }[] = []
  const walk = (node: Root | RootContent, parent?: Root | RootContent): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    if ('children' in node) for (const child of node.children) walk(child, node)
  }
  walk(root)
  const images = (node: Root | RootContent, parent?: Root | RootContent): void => {
    if (node.type === 'image' || node.type === 'imageReference') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) return
      const raw = node.type === 'image' ? node.url : definitions.get(node.identifier)?.url
      const alt = (node.alt || label).replace(/[\\\[\]]/gu, '\\$&')
      let replacement = alt
      if (raw && parent?.type !== 'link') {
        try { const url = new URL(raw); if (['http:', 'https:'].includes(url.protocol)) replacement = '[' + alt + ' · ' + label + '](<' + url.href.replaceAll('<', '%3C').replaceAll('>', '%3E') + '>)' }
        catch { /* A relative image remains inert text, not a guessed host path. */ }
      }
      replacements.push({ start, end, text: replacement })
    } else if ('children' in node) for (const child of node.children) images(child, node)
  }
  images(root)
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end)
  return text
}
