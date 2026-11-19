/**
 * How the cells of a worksheet look, as short notes for a read: each cell style is told apart from
 * the workbook's default style, and neighbouring cells that look alike are named as one range.
 * Conditional formatting, table styles, and styles set on a whole row or column are not followed.
 */
import { attr, children, descendants, type Node, type OfficePackage } from './package.ts'
import { cellRef, columnName, type Cell, type Position } from './workbook.ts'

const first = (node: Node | undefined, tag: string): Node | undefined => node && children(node, tag)[0]
/** An attribute of a child element, or an empty string when either is missing. */
const value = (node: Node | undefined, tag: string, key: string): string => { const child = first(node, tag); return child ? attr(child, key) : '' }
const on = (node: Node | undefined): boolean => !!node && !['0', 'false'].includes(attr(node, 'val'))
/** Theme colour slots in the order styles index them, which swaps each light and dark pair. */
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
/** Regions listed for one read; a sheet formatted cell by cell would otherwise crowd out its values. */
const MAX_REGIONS = 150
const MAX_ROW_HEIGHTS = 50

/** Excel lightens or darkens a theme colour by a tint. This moves each channel instead of the luminance, which is close enough to name the colour. */
function tinted(hex: string, tint: number): string {
  if (!tint) return hex
  const channel = (index: number) => { const value = Number.parseInt(hex.slice(index, index + 2), 16); return Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint) }
  return [0, 2, 4].map(index => channel(index).toString(16).padStart(2, '0')).join('').toUpperCase()
}
export class CellLooks {
  private readonly theme: readonly string[]
  private readonly fonts: readonly Node[]
  private readonly fills: readonly Node[]
  private readonly borders: readonly Node[]
  private readonly styles: readonly Node[]
  private readonly known = new Map<number, string>()
  /**
   * @param formats - the number format code of each cell style, by index.
   */
  constructor(office: OfficePackage, private readonly formats: readonly string[]) {
    const root = office.has('xl/styles.xml') ? office.xml('xl/styles.xml').children.find(node => node.tag === 'styleSheet') : undefined
    const list = (group: string, item: string) => { const holder = first(root, group); return holder ? children(holder, item) : [] }
    this.fonts = list('fonts', 'font')
    this.fills = list('fills', 'fill')
    this.borders = list('borders', 'border')
    this.styles = list('cellXfs', 'xf')
    const themePart = office.names().find(key => /^xl\/theme\/[^/]+\.xml$/u.test(key))
    const scheme = themePart ? descendants(office.xml(themePart), 'clrScheme')[0] : undefined
    this.theme = THEME_ORDER.map(slot => { const colour = first(first(scheme, slot), 'srgbClr') ?? first(first(scheme, slot), 'sysClr'); return colour ? (attr(colour, 'val').length === 6 ? attr(colour, 'val') : attr(colour, 'lastClr')).toUpperCase() : '' })
  }
  /** @returns six hex digits, or an empty string for a colour that is automatic or not resolved here. */
  private colour(node: Node | undefined): string {
    if (!node) return ''
    const rgb = attr(node, 'rgb')
    if (/^[\da-f]{8}$/iu.test(rgb)) return rgb.slice(2).toUpperCase()
    const slot = attr(node, 'theme')
    const base = slot === '' ? '' : this.theme[Number(slot)] ?? ''
    return base ? tinted(base, Number(attr(node, 'tint')) || 0) : ''
  }
  private font(index: number): { readonly name: string; readonly size: string; readonly bold: boolean; readonly italic: boolean; readonly underline: boolean; readonly strike: boolean; readonly colour: string } {
    const font = this.fonts[index]
    return { name: value(font, 'name', 'val'), size: value(font, 'sz', 'val'), bold: on(first(font, 'b')), italic: on(first(font, 'i')), underline: !!first(font, 'u') && value(font, 'u', 'val') !== 'none', strike: on(first(font, 'strike')), colour: this.colour(first(font, 'color')) }
  }
  private fill(index: number): string {
    const pattern = first(this.fills[index], 'patternFill')
    return pattern && attr(pattern, 'patternType') === 'solid' ? this.colour(first(pattern, 'fgColor')) : ''
  }
  private border(index: number): string {
    const border = this.borders[index]
    const sides = ['left', 'right', 'top', 'bottom'].filter(side => value(border, side, 'style'))
    return sides.length === 4 ? 'border' : sides.length ? 'border ' + sides.join(',') : ''
  }
  private style(index: number): { readonly font: ReturnType<CellLooks['font']>; readonly fill: string; readonly border: string; readonly format: string; readonly align: string; readonly vertical: string; readonly wrap: boolean } {
    const style = this.styles[index]
    const alignment = first(style, 'alignment')
    const number = (name: string) => Number(style ? attr(style, name) : '') || 0
    return { font: this.font(number('fontId')), fill: this.fill(number('fillId')), border: this.border(number('borderId')), format: this.formats[index] ?? 'General', align: alignment ? attr(alignment, 'horizontal') : '', vertical: alignment ? attr(alignment, 'vertical') : '', wrap: !!alignment && ['1', 'true'].includes(attr(alignment, 'wrapText')) }
  }
  /** The look of a cell with the workbook's default style, which every other look is told apart from. */
  describeDefault(): string {
    const { font } = this.style(0)
    return [font.name, font.size && font.size + 'pt', font.bold && 'bold', font.italic && 'italic', font.colour && font.colour !== '000000' && '#' + font.colour].filter(Boolean).join(' ')
  }
  /** @returns what sets a cell style apart from the default one, or an empty string. */
  look(index: number): string {
    const known = this.known.get(index)
    if (known !== undefined) return known
    const base = this.style(0)
    const own = this.style(index)
    const tokens: string[] = []
    if (own.font.name && own.font.name !== base.font.name) tokens.push(own.font.name)
    if (own.font.size && own.font.size !== base.font.size) tokens.push(own.font.size + 'pt')
    for (const key of ['bold', 'italic', 'underline', 'strike'] as const) if (own.font[key] !== base.font[key]) tokens.push((own.font[key] ? '' : 'not ') + key)
    if (own.font.colour !== base.font.colour && own.font.colour) tokens.push('#' + own.font.colour)
    if (own.fill !== base.fill) tokens.push(own.fill ? 'fill #' + own.fill : 'no fill')
    if (own.border !== base.border) tokens.push(own.border || 'no border')
    if (own.align !== base.align && own.align && own.align !== 'general') tokens.push(own.align)
    if (own.vertical !== base.vertical && own.vertical) tokens.push('vertical ' + own.vertical)
    if (own.wrap !== base.wrap) tokens.push(own.wrap ? 'wrap' : 'no wrap')
    if (own.format !== base.format) tokens.push('format ' + own.format)
    const text = tokens.join(' ')
    this.known.set(index, text)
    return text
  }
}

/**
 * @param cells - a sheet's cells in row order, as `sheetCells` gives them.
 * @returns the ranges inside the rectangle whose cells share a look other than the default, each as `range look`, in reading order.
 */
export function lookRegions(cells: readonly Cell[], from: Position, to: Position, looks: CellLooks): string[] {
  interface Region { readonly left: number; readonly right: number; readonly look: string; readonly top: number; bottom: number }
  const done: Region[] = []
  const open = new Map<string, Region>()
  const close = (row: number) => { for (const [key, region] of open) if (region.bottom < row - 1 || row === Infinity) { done.push(region); open.delete(key) } }
  let row = 0
  let run: { left: number; right: number; look: string } | undefined
  const endRun = () => {
    if (!run) return
    const key = `${run.left}:${run.right}:${run.look}`
    const above = open.get(key)
    if (above && above.bottom === row - 1) above.bottom = row
    else { if (above) { done.push(above); open.delete(key) } open.set(key, { ...run, top: row, bottom: row }) }
    run = undefined
  }
  for (const cell of cells) {
    if (cell.row < from.row || cell.row > to.row || cell.column < from.column || cell.column > to.column) continue
    if (cell.row !== row) { endRun(); row = cell.row; close(row) }
    const look = cell.style === undefined ? '' : looks.look(cell.style)
    if (run && (look !== run.look || cell.column !== run.right + 1)) endRun()
    if (!look) continue
    if (run) run.right = cell.column
    else run = { left: cell.column, right: cell.column, look }
  }
  endRun()
  close(Infinity)
  done.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines = done.slice(0, MAX_REGIONS).map(region => {
    const start = cellRef({ row: region.top, column: region.left })
    const end = cellRef({ row: region.bottom, column: region.right })
    return (start === end ? start : start + ':' + end) + ' ' + region.look
  })
  if (done.length > MAX_REGIONS) lines.push(`${done.length - MAX_REGIONS} more ranges are not listed; read a smaller range to see them`)
  return lines
}
/** @returns the widths of columns in the rectangle that are not the default width, in characters, by column or column span. */
export function columnWidths(sheet: Node, from: Position, to: Position): Record<string, number> {
  const widths: Record<string, number> = {}
  for (const column of descendants(sheet, 'col')) {
    const left = Math.max(Number(attr(column, 'min')), from.column)
    const right = Math.min(Number(attr(column, 'max')), to.column)
    const width = Number(attr(column, 'width'))
    if (left <= right && width > 0 && !['1', 'true'].includes(attr(column, 'hidden'))) widths[left === right ? columnName(left) : columnName(left) + ':' + columnName(right)] = Math.round(width * 10) / 10
  }
  return widths
}
/** @returns the heights of rows in the rectangle that were set by hand, in points, first ones only. */
export function rowHeights(sheet: Node, from: Position, to: Position): Record<string, number> {
  const heights: Record<string, number> = {}
  let row = 0
  for (const line of descendants(sheet, 'row')) {
    row = Number(attr(line, 'r')) || row + 1
    if (row < from.row || row > to.row || !['1', 'true'].includes(attr(line, 'customHeight')) || Object.keys(heights).length >= MAX_ROW_HEIGHTS) continue
    heights[String(row)] = Math.round(Number(attr(line, 'ht')) * 10) / 10
  }
  return heights
}
