/**
 * How the text of a Word file looks, and how its tables are built, as short notes for a read.
 * A run's look comes from the document defaults, the paragraph style, the character style and the run itself, in that order.
 * Table styles and conditional table formatting are not followed, so text they alone format reads as the default.
 */
import { attr, children, content, type Node, type OfficePackage } from './package.ts'

/** What one level states. A missing key leaves the level below in force. */
interface Look {
  latin?: string
  eastAsia?: string
  /** Points. */
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** Six hex digits, or an empty string for the automatic colour. */
  color?: string
  /** A highlight name, or an empty string for none. */
  highlight?: string
  align?: 'left' | 'center' | 'right' | 'justify'
}
const TWIPS_PER_CM = 567
const OFF = new Set(['0', 'false', 'off', 'none'])
const ALIGN: Readonly<Record<string, Look['align']>> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }
const first = (node: Node | undefined, tag: string): Node | undefined => node && children(node, tag)[0]
/** An attribute of a child element, or an empty string when either is missing. */
const value = (node: Node | undefined, tag: string, key: string): string => { const child = first(node, tag); return child ? attr(child, key) : '' }
/** Names go inside braces on one line, so they hold neither. */
const name = (value: string): string => value.replace(/[{}"\n]/gu, '')

export interface Segment { readonly text: string; readonly look: string }
export class WordFormats {
  private readonly styles = new Map<string, Node>()
  private readonly resolved = new Map<string, Look>()
  private readonly theme: Readonly<Record<string, string>>
  private readonly defaults: Look
  /** The paragraph style of a paragraph that names none. */
  private readonly normal: string | undefined
  private readonly base: Look
  constructor(office: OfficePackage) {
    const themePart = office.names().find(key => /^word\/theme\/[^/]+\.xml$/u.test(key))
    const scheme = themePart ? first(first(office.xml(themePart).children.find(node => node.tag === 'theme'), 'themeElements'), 'fontScheme') : undefined
    // East Asian theme fonts are usually given per script, with the general slot left empty.
    const face = (group: Node | undefined, script: 'latin' | 'ea'): string => value(group, script, 'typeface') || (script === 'ea' && group ? attr(children(group, 'font').find(font => attr(font, 'script') === 'Hans') ?? group, 'typeface') : '')
    const major = first(scheme, 'majorFont')
    const minor = first(scheme, 'minorFont')
    this.theme = { majorHAnsi: face(major, 'latin'), majorAscii: face(major, 'latin'), majorEastAsia: face(major, 'ea'), minorHAnsi: face(minor, 'latin'), minorAscii: face(minor, 'latin'), minorEastAsia: face(minor, 'ea') }
    let normal: string | undefined
    let defaults: Look = {}
    if (office.has('word/styles.xml')) {
      const root = office.xml('word/styles.xml').children.find(node => node.tag === 'styles')
      for (const style of root ? children(root, 'style') : []) {
        this.styles.set(attr(style, 'styleId'), style)
        if (attr(style, 'type') === 'paragraph' && !OFF.has(attr(style, 'default') || '0')) normal = attr(style, 'styleId')
      }
      const stated = first(root, 'docDefaults')
      defaults = { ...this.run(first(first(stated, 'rPrDefault'), 'rPr')), ...this.paragraphLook(first(first(stated, 'pPrDefault'), 'pPr')) }
    }
    this.defaults = defaults
    this.normal = normal
    this.base = this.styled(undefined)
  }
  private run(properties: Node | undefined): Look {
    const look: Look = {}
    if (!properties) return look
    const flag = (tag: string): boolean | undefined => { const node = first(properties, tag); return node ? !OFF.has(attr(node, 'val')) : undefined }
    const fonts = first(properties, 'rFonts')
    if (fonts) {
      const latin = attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || this.theme[attr(fonts, 'asciiTheme') || attr(fonts, 'hAnsiTheme')]
      const eastAsia = attr(fonts, 'eastAsia') || this.theme[attr(fonts, 'eastAsiaTheme')]
      if (latin) look.latin = name(latin)
      if (eastAsia) look.eastAsia = name(eastAsia)
    }
    const size = Number(value(properties, 'sz', 'val'))
    if (size > 0) look.size = size / 2
    for (const [tag, key] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['strike', 'strike']] as const) { const value = flag(tag); if (value !== undefined) look[key] = value }
    const color = first(properties, 'color')
    if (color) look.color = /^[\da-f]{6}$/iu.test(attr(color, 'val')) ? attr(color, 'val').toUpperCase() : ''
    const highlight = first(properties, 'highlight')
    if (highlight) look.highlight = OFF.has(attr(highlight, 'val')) ? '' : name(attr(highlight, 'val'))
    return look
  }
  private paragraphLook(properties: Node | undefined): Look {
    const align = ALIGN[value(properties, 'jc', 'val')]
    return align ? { align } : {}
  }
  /** A style with everything it is based on. A style that leads back to itself stops there. */
  private style(id: string, seen = new Set<string>()): Look {
    const known = this.resolved.get(id)
    if (known) return known
    const style = this.styles.get(id)
    if (!style || seen.has(id)) return {}
    seen.add(id)
    const parent = value(style, 'basedOn', 'val')
    const look = { ...(parent ? this.style(parent, seen) : {}), ...this.paragraphLook(first(style, 'pPr')), ...this.run(first(style, 'rPr')) }
    this.resolved.set(id, look)
    return look
  }
  /** The look of unformatted text in a paragraph of this style, or of the default paragraph style. */
  private styled(id: string | undefined): Look {
    const style = id || this.normal
    return { ...this.defaults, ...(style ? this.style(style) : {}) }
  }
  /** @returns what sets this look apart from the document default, or an empty string. */
  private differences(look: Look): string {
    const base = this.base
    const tokens: string[] = []
    const fonts = (value: Look) => [...new Set([value.eastAsia, value.latin].filter(Boolean))].join('/')
    if (fonts(look) !== fonts(base) && fonts(look)) tokens.push(fonts(look))
    if (look.size !== base.size && look.size !== undefined) tokens.push(look.size + 'pt')
    for (const key of ['bold', 'italic', 'underline', 'strike'] as const) if (!!look[key] !== !!base[key]) tokens.push((look[key] ? '' : 'not ') + key)
    if ((look.color ?? '') !== (base.color ?? '')) tokens.push(look.color ? '#' + look.color : 'automatic colour')
    if ((look.highlight ?? '') !== (base.highlight ?? '')) tokens.push(look.highlight ? 'highlight ' + look.highlight : 'no highlight')
    if ((look.align ?? 'left') !== (base.align ?? 'left')) tokens.push(look.align ?? 'left')
    return tokens.join(' ')
  }
  /** The default every paragraph note is measured against. */
  describeDefault(): string {
    const { base } = this
    return [[...new Set([base.eastAsia, base.latin].filter(Boolean))].join('/'), base.size === undefined ? '' : base.size + 'pt', base.bold ? 'bold' : '', base.italic ? 'italic' : '', base.color ? '#' + base.color : '', base.align ?? 'left'].filter(Boolean).join(' ')
  }
  /**
   * @returns the paragraph's stretches of text that look alike, each with what sets it apart from the default.
   * An empty paragraph gives one empty stretch with the look new text takes there.
   */
  paragraph(paragraph: Node): Segment[] {
    const properties = first(paragraph, 'pPr')
    const own: Look = { ...this.styled(value(properties, 'pStyle', 'val')), ...this.paragraphLook(properties) }
    const found: Segment[] = []
    const visit = (node: Node) => {
      if (['pPr', 'del', 'moveFrom'].includes(node.tag)) return
      if (node.tag !== 'r') { node.children.forEach(visit); return }
      const text = content(node)
      if (!text) return
      const direct = first(node, 'rPr')
      const character = value(direct, 'rStyle', 'val')
      const look = this.differences({ ...own, ...(character ? this.style(character) : {}), ...this.run(direct) })
      const last = found.at(-1)
      if (last?.look === look) found[found.length - 1] = { text: last.text + text, look }
      else found.push({ text, look })
    }
    paragraph.children.forEach(visit)
    return found.length ? found : [{ text: '', look: this.differences({ ...own, ...this.run(first(properties, 'rPr')) }) }]
  }
}

const cm = (twips: number): string => String(Math.round(twips / TWIPS_PER_CM * 10) / 10)
const MAX_LISTED = 24
const list = (items: readonly string[]): string => items.length > MAX_LISTED ? items.slice(0, MAX_LISTED).join(' ') + ` and ${items.length - MAX_LISTED} more` : items.join(' ')
/**
 * @param table - a `tbl` element.
 * @returns its grid, borders, merged cells and shaded cells in one line. Cells are named as locations name them: `c` counts a row's cells, so a cell merged across columns is one `c`.
 */
export function describeTable(table: Node): string {
  const rows = children(table, 'tr')
  const widths = children(first(table, 'tblGrid') ?? table, 'gridCol').map(column => Number(attr(column, 'w')))
  const properties = first(table, 'tblPr')
  const sides = first(properties, 'tblBorders')
  const drawn = (side: string): boolean => { const node = first(sides, side); return !!node && !['none', 'nil', ''].includes(attr(node, 'val')) }
  const outer = ['top', 'left', 'bottom', 'right', 'start', 'end'].some(drawn)
  const inner = ['insideH', 'insideV'].some(drawn)
  const style = value(properties, 'tblStyle', 'val')
  const borders = sides ? outer && inner ? 'all' : outer ? 'outer only' : inner ? 'inner only' : 'none' : style ? 'from table style ' + name(style) : 'none'
  const across: string[] = []
  const down: string[] = []
  const shaded = new Map<string, string[]>()
  /** By grid column: the cell that started a merge down, and the cells continuing it so far. */
  const open = new Map<number, { readonly at: string; readonly more: string[] }>()
  const close = (column: number) => { const merge = open.get(column); if (merge?.more.length) down.push(`${merge.at} down ${merge.more.length + 1} rows (${merge.more.join(', ')} continue it and stay empty)`); open.delete(column) }
  rows.forEach((row, rowIndex) => {
    let column = 0
    const continued = new Set<number>()
    children(row, 'tc').forEach((cell, cellIndex) => {
      const at = `r${rowIndex + 1}.c${cellIndex + 1}`
      const cellProperties = first(cell, 'tcPr')
      const span = Math.max(1, Number(value(cellProperties, 'gridSpan', 'val')) || 1)
      if (span > 1) across.push(`${at} across ${span} columns`)
      const merge = first(cellProperties, 'vMerge')
      if (merge && attr(merge, 'val') !== 'restart' && open.has(column)) { open.get(column)!.more.push(at); continued.add(column) }
      else {
        close(column)
        if (merge) { open.set(column, { at, more: [] }); continued.add(column) }
      }
      const fill = value(cellProperties, 'shd', 'fill')
      if (/^[\da-f]{6}$/iu.test(fill) && fill.toUpperCase() !== 'FFFFFF') shaded.set(fill.toUpperCase(), [...(shaded.get(fill.toUpperCase()) ?? []), at])
      column += span
    })
    for (const key of [...open.keys()]) if (!continued.has(key)) close(key)
  })
  for (const key of [...open.keys()]) close(key)
  return [
    `table: ${rows.length} rows, ${widths.length} columns`,
    ...(widths.length && widths.every(width => width > 0) ? ['column widths ' + widths.map(cm).join(' ') + ' cm'] : []),
    'borders ' + borders,
    ...(across.length || down.length ? ['merged: ' + [...across, ...down].join(', ')] : []),
    ...[...shaded].map(([fill, cells]) => `shaded #${fill}: ${list(cells)}`),
  ].join('; ')
}
