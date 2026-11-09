/**
 * Build a 16:9 PPTX from slides in fixed layouts. The engine places and sizes everything: a model does not lay out
 * geometry well, and fixed regions keep slides aligned and the fit estimate sound. Text names no typeface of its
 * own, so the theme's fonts apply, and replacing theme1.xml restyles a deck.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import pptxgen from 'pptxgenjs'
import { PersonalChatError, validatePresentation, type PresentationInput, type Slide, type SlideImage, type SlideIssue } from 'dsh-beluga'
import { fitText, lineCount, LINE_EM, widthEm, type Room } from './slide-fit.ts'

/** Its types describe CommonJS, but Node loads the ES build, whose default export is the class itself. */
const PptxGenJS = ((pptxgen as unknown as { default?: unknown }).default ?? pptxgen) as typeof pptxgen.default
type Deck = InstanceType<typeof PptxGenJS>
type Page = ReturnType<Deck['addSlide']>
type Runs = Exclude<Parameters<Page['addText']>[0], string>
type ChartOptions = NonNullable<Parameters<Page['addChart']>[2]>
type Bullet = Extract<Slide, { layout: 'bullets' }>['bullets'][number]
type Column = Extract<Slide, { layout: 'two_column' }>['left']

/** Inches, on a 13.333 by 7.5 inch slide. */
interface Region { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const PT = 72
const SLIDE_WIDTH = 13.333
const SIDE = 0.6
const CONTENT = SLIDE_WIDTH - 2 * SIDE
const TITLE: Region = { x: SIDE, y: 0.35, w: CONTENT, h: 1.2 }
const BODY: Region = { x: SIDE, y: 1.85, w: CONTENT, h: 5.25 }
const COLUMN_GAP = 0.6
const HALF = (CONTENT - COLUMN_GAP) / 2
const COVER_TITLE: Region = { x: 0.9, y: 2.2, w: 11.5, h: 2.0 }
const COVER_SUBTITLE: Region = { x: 0.9, y: 4.35, w: 11.5, h: 1.3 }
const SECTION_TITLE: Region = { x: 1.3, y: 2.65, w: 11.2, h: 2.2 }
/** Points of air inside every edge of a text box. */
const INSET = 7.2
/** Inches from a text box's edge to its text, so accents, tables and images line up with the words. */
const EDGE = INSET / PT
/** Inches of air inside every edge of a table cell. */
const CELL_INSET = 0.06
/** Points between a bullet and its text, for each level, as pptxgenjs indents them. */
const BULLET = 27
/** The header colour of generated workbooks, so files made together look related. */
const PRIMARY = '1F4E79'
const ON_PRIMARY = 'D6E0EE'
const INK = '262626'
const MUTED = '595959'
const TINT = 'EEF3F9'
const RULE = 'BFBFBF'
const GRID = 'D9D9D9'
const WHITE = 'FFFFFF'
/** Excel's accent colours, as workbook charts use them. */
const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E']
const EAST_ASIAN = 'Microsoft YaHei'
const THEME_FONTS = '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>'
const MASTER = 'BELUGA'
const COVER = 'BELUGA_COVER'
const SECTION = 'BELUGA_SECTION'
/** A figure as a table shows it: digits with separators, a sign or brackets, a currency and a unit. */
const FIGURE = /^[-+−(]?[$¥€£]?\d[\d,]*(?:\.\d+)?\)?\s*(?:%|‰|[kKmMbB]|元|万|亿)?$/u

const spacing = (size: number): number => Math.round(size * 0.4)
const room = (region: Region): Room => ({ width: region.w * PT - 2 * INSET, height: region.h * PT - 2 * INSET })
const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0)
/** The proofing language of a run: what spell checkers use, not which font draws it. */
const langOf = (text: string): string => /[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text) ? 'ja-JP' : /\p{sc=Hangul}/u.test(text) ? 'ko-KR' : /\p{sc=Han}/u.test(text) ? 'zh-CN' : 'en-US'
const textOf = (item: Bullet): string => typeof item === 'string' ? item : item.text
const levelOf = (item: Bullet): 1 | 2 => typeof item === 'string' ? 1 : item.level
/** Thousands separators, with as many decimals as the values have, at most two. */
function numberFormat(values: readonly number[]): string {
  const places = Math.min(2, Math.max(0, ...values.map(value => /e/iu.test(String(value)) ? 0 : (String(value).split('.')[1] ?? '').length)))
  return places ? '#,##0.' + '0'.repeat(places) : '#,##0'
}

/** One slide being laid out, and the regions of the deck whose text did not fit. */
interface Place { readonly page: Page; readonly number: number; readonly issues: SlideIssue[] }
function overflow(place: Place, region: string, fits: boolean): void {
  if (!fits && !place.issues.some(issue => issue.slide === place.number && issue.region === region)) place.issues.push({ slide: place.number, region, issue: 'overflow' })
}
interface Look { readonly start: number; readonly min: number; readonly color: string; readonly bold?: boolean; readonly valign: 'top' | 'middle' | 'bottom' }
/** One paragraph in a region, at the largest size that fits it. A title fills the slide's title placeholder. */
function words(place: Place, value: string, region: Region, look: Look, name: string): void {
  const { size, fits } = fitText([{ text: value }], room(region), look.start, look.min)
  overflow(place, name, fits)
  // The master's title style centres, as PowerPoint's default does; these titles start at the accent.
  place.page.addText(value, { ...region, ...(name === 'title' ? { placeholder: 'title' } : {}), fontSize: size, bold: look.bold ?? false, color: look.color, align: 'left', valign: look.valign, margin: INSET, lang: langOf(value) })
}
const heading = (place: Place, value: string): void => { words(place, value, TITLE, { start: 32, min: 24, color: PRIMARY, bold: true, valign: 'bottom' }, 'title') }
function bullets(place: Place, items: readonly Bullet[], region: Region, start: number, name: string): void {
  const { size, fits } = fitText(items.map(item => ({ text: textOf(item), indent: BULLET * levelOf(item), smaller: levelOf(item) === 2 ? 2 : 0 })), room(region), start, 16, spacing)
  overflow(place, name, fits)
  const runs: Runs = items.map(item => ({ text: textOf(item), options: { bullet: { indent: BULLET }, indentLevel: levelOf(item) - 1, fontSize: levelOf(item) === 2 ? size - 2 : size, color: INK, paraSpaceAfter: spacing(size), lang: langOf(textOf(item)) } }))
  place.page.addText(runs, { ...region, valign: 'top', margin: INSET })
}
function column(place: Place, part: Column, region: Region, name: 'left' | 'right'): void {
  if (!part.heading) return bullets(place, part.bullets, region, 20, name)
  words(place, part.heading, { ...region, h: 0.75 }, { start: 24, min: 18, color: PRIMARY, bold: true, valign: 'bottom' }, name)
  place.page.addShape('line', { x: region.x + INSET / PT, y: region.y + 0.82, w: region.w - 2 * INSET / PT, h: 0, line: { color: RULE, width: 1 } })
  bullets(place, part.bullets, { ...region, y: region.y + 0.95, h: region.h - 0.95 }, 20, name)
}
function chart(place: Place, slide: Extract<Slide, { layout: 'chart' }>): void {
  const round = slide.chart === 'pie' || slide.chart === 'doughnut'
  const values = slide.series.flatMap(series => series.values)
  const data = slide.series.map(series => ({ name: series.name, labels: [...slide.categories], values: [...series.values] }))
  const shared: ChartOptions = {
    ...BODY, altText: slide.title, lang: langOf(slide.title + slide.categories.join('') + slide.series.map(series => series.name).join('')),
    chartColors: PALETTE, showTitle: false, showLegend: round || slide.series.length > 1, legendPos: round ? 'r' : 'b', legendFontSize: 14, legendColor: INK,
  }
  // Bars start at 0 so their lengths compare truly; negative values or a line keep the axis free.
  const options: ChartOptions = round
    ? { ...shared, showPercent: true, showValue: false, dataLabelFormatCode: '0.0%', dataLabelColor: INK, dataLabelFontSize: 14, ...(slide.chart === 'pie' ? { dataLabelPosition: 'outEnd' } : { holeSize: 55 }) }
    : {
      ...shared, catAxisLabelPos: 'low', catAxisLabelFontSize: 14, catAxisLabelColor: INK, valAxisLabelFontSize: 12, valAxisLabelColor: MUTED,
      valAxisLabelFormatCode: numberFormat(values), valGridLine: { color: GRID, size: 0.5 },
      ...(slide.unit ? { showValAxisTitle: true, valAxisTitle: slide.unit, valAxisTitleFontSize: 12, valAxisTitleColor: MUTED } : {}),
      ...(slide.chart === 'line' ? { lineSize: 2, lineDataSymbol: 'circle', lineDataSymbolSize: 7 } : { barDir: slide.chart === 'bar' ? 'bar' : 'col', barGrouping: 'clustered', ...(values.every(value => value >= 0) ? { valAxisMinVal: 0 } : {}) }),
    }
  place.page.addChart(slide.chart === 'column' ? 'bar' : slide.chart, data, options)
}
/** Columns as wide as their text, figures on the right, rows as tall as their longest cell, at the largest size that fits. */
function table(place: Place, rows: readonly (readonly string[])[]): void {
  const columns = rows[0]!.length
  const body = rows.slice(1)
  const figures = Array.from({ length: columns }, (_, index) => body.some(row => row[index]!.trim()) && body.every(row => !row[index]!.trim() || FIGURE.test(row[index]!.trim())))
  const width = Math.min(CONTENT - 2 * EDGE, 2.6 * columns + 1)
  const weights = Array.from({ length: columns }, (_, index) => Math.min(24, Math.max(4, ...rows.map(row => widthEm(row[index]!)))))
  const colW = weights.map(weight => width * weight / total(weights))
  const heights = (size: number): number[] => rows.map(row => Math.max(...row.map((cell, index) => lineCount(cell, (colW[index]! - 2 * CELL_INSET) * PT / size))) * size * LINE_EM + 2 * CELL_INSET * PT)
  let size = 18
  while (size > 12 && total(heights(size)) > BODY.h * PT) size -= 2
  overflow(place, 'rows', total(heights(size)) <= BODY.h * PT)
  const cells = rows.map((row, index) => row.map((text, column) => ({
    text, options: { bold: index === 0, color: index ? INK : WHITE, fill: { color: index ? (index % 2 ? WHITE : TINT) : PRIMARY }, align: figures[column] ? 'right' as const : 'left' as const, lang: langOf(text) },
  })))
  place.page.addTable(cells, { x: SIDE + EDGE, y: BODY.y, w: width, colW, rowH: heights(size).map(height => height / PT), fontSize: size, valign: 'middle', margin: CELL_INSET, border: { type: 'solid', pt: 0.75, color: RULE }, autoPage: false })
}
/** Up to four figures on cards in one row centred in the body, every value at one size and every label at another. */
function metrics(place: Place, items: Extract<Slide, { layout: 'metrics' }>['metrics']): void {
  const gap = 0.4
  const height = 3.2
  const top = BODY.y + (BODY.h - height) / 2
  const width = Math.min(4.2, (CONTENT - gap * (items.length - 1)) / items.length)
  const left = (SLIDE_WIDTH - width * items.length - gap * (items.length - 1)) / 2
  const value = (x: number): Region => ({ x, y: top + 0.35, w: width, h: 1.35 })
  const label = (x: number): Region => ({ x, y: top + 1.8, w: width, h: 1.15 })
  const values = items.map(item => fitText([{ text: item.value }], room(value(0)), 44, 28))
  const labels = items.map(item => fitText([{ text: item.label }], room(label(0)), 18, 14))
  overflow(place, 'metrics', [...values, ...labels].every(fit => fit.fits))
  items.forEach((item, index) => {
    const x = left + index * (width + gap)
    place.page.addShape('rect', { x, y: top, w: width, h: height, fill: { color: TINT }, line: { color: TINT } })
    place.page.addText(item.value, { ...value(x), fontSize: Math.min(...values.map(fit => fit.size)), bold: true, color: PRIMARY, align: 'center', valign: 'middle', margin: INSET, lang: langOf(item.value) })
    place.page.addText(item.label, { ...label(x), fontSize: Math.min(...labels.map(fit => fit.size)), color: MUTED, align: 'center', valign: 'top', margin: INSET, lang: langOf(item.label) })
  })
}
/** The image as large as its region allows, never stretched; bullets, when given, take the right third. */
function picture(place: Place, image: SlideImage, items: readonly Bullet[] | undefined, title: string): void {
  const area: Region = { ...BODY, x: SIDE + EDGE, w: items ? 7.3 : CONTENT - 2 * EDGE }
  const aspect = image.width / image.height
  const w = Math.min(area.w, area.h * aspect)
  const h = w / aspect
  place.page.addImage({ data: image.mediaType + ';base64,' + Buffer.from(image.data).toString('base64'), x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h, altText: title })
  if (items) bullets(place, items, { x: SIDE + 7.7, y: BODY.y, w: CONTENT - 7.7, h: BODY.h }, 20, 'bullets')
}
function layout(place: Place, slide: Slide, images: ReadonlyMap<string, SlideImage>): void {
  switch (slide.layout) {
    case 'title':
      words(place, slide.title, COVER_TITLE, { start: 40, min: 28, color: WHITE, bold: true, valign: 'bottom' }, 'title')
      if (slide.subtitle) words(place, slide.subtitle, COVER_SUBTITLE, { start: 24, min: 16, color: ON_PRIMARY, valign: 'top' }, 'subtitle')
      return
    case 'section': return words(place, slide.title, SECTION_TITLE, { start: 36, min: 28, color: PRIMARY, bold: true, valign: 'middle' }, 'title')
    case 'bullets': heading(place, slide.title); return bullets(place, slide.bullets, BODY, 22, 'bullets')
    case 'two_column':
      heading(place, slide.title)
      column(place, slide.left, { ...BODY, w: HALF }, 'left')
      return column(place, slide.right, { ...BODY, x: SIDE + HALF + COLUMN_GAP, w: HALF }, 'right')
    case 'chart': heading(place, slide.title); return chart(place, slide)
    case 'table': heading(place, slide.title); return table(place, slide.rows)
    case 'metrics': heading(place, slide.title); return metrics(place, slide.metrics)
    case 'image': {
      heading(place, slide.title)
      const image = images.get(slide.image)
      if (!image) throw new PersonalChatError('attachment-unavailable', 'Slide ' + place.number + ': its image was not provided')
      return picture(place, image, slide.bullets, slide.title)
    }
  }
}
function masters(deck: Deck): void {
  const title = (region: Region) => ({ placeholder: { options: { name: 'title', type: 'title' as const, ...region }, text: '' } })
  const accent = (x: number, y: number, color: string) => ({ rect: { x: x + EDGE, y, w: 0.9, h: 0.06, fill: { color }, line: { color } } })
  deck.defineSlideMaster({ title: MASTER, background: { color: WHITE }, objects: [accent(TITLE.x, 1.62, PRIMARY), title(TITLE)] })
  deck.defineSlideMaster({ title: COVER, background: { color: PRIMARY }, objects: [accent(COVER_TITLE.x, 4.24, ON_PRIMARY), title(COVER_TITLE)] })
  deck.defineSlideMaster({ title: SECTION, background: { color: TINT }, objects: [{ rect: { x: 0.9, y: 2.85, w: 0.12, h: 1.8, fill: { color: PRIMARY }, line: { color: PRIMARY } } }, title(SECTION_TITLE)] })
}
/**
 * Finish the package pptxgenjs writes. Its typefaces point at the theme, and the theme gains its East Asian face, so no
 * text asks for Arial. As in PowerPoint's own files, the notes master gets a theme of its own and only parts that
 * exist are declared; pptxgenjs shares theme1 and declares a slide master per slide (its issues 1443 and 1449).
 * presentation.xml keeps pptxgenjs's order, notes master after the slides, against the schema: PowerPoint for Mac
 * was reported not to open a deck with the schema's order.
 */
function finished(bytes: Uint8Array): Uint8Array {
  const files: Zippable = {}
  for (const [name, data] of Object.entries(unzipSync(bytes))) if (!name.endsWith('/')) files[name] = data
  const edit = (name: string, change: (xml: string) => string) => { files[name] = strToU8(change(strFromU8(files[name] as Uint8Array))) }
  edit('ppt/theme/theme1.xml', xml => xml.replace(/(<a:(?:major|minor)Font><a:latin [^>]*\/>)<a:ea typeface=""\/>/gu, '$1<a:ea typeface="' + EAST_ASIAN + '"/>'))
  for (const name of Object.keys(files)) {
    if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(name)) edit(name, xml => xml.replace(/<a:buFont typeface="Arial"[^>]*\/>/gu, '<a:buFont typeface="+mn-lt"/>'))
    if (/^ppt\/charts\/chart\d+\.xml$/u.test(name)) edit(name, xml => xml.replace(/<a:latin typeface="Arial"\/>/gu, THEME_FONTS))
  }
  files['ppt/theme/theme2.xml'] = files['ppt/theme/theme1.xml']!
  edit('ppt/notesMasters/_rels/notesMaster1.xml.rels', xml => xml.replace('../theme/theme1.xml', '../theme/theme2.xml'))
  edit('[Content_Types].xml', xml => xml.replace(/<Override PartName="\/([^"]+)"[^>]*\/>/gu, (override, part: string) => part in files ? override : '')
    .replace('</Types>', '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'))
  return zipSync(files, { level: 6 })
}
/** @returns the deck, and the regions whose text does not fit even at the smallest size. */
export async function renderPresentation(input: PresentationInput, images: ReadonlyMap<string, SlideImage>, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly issues: readonly SlideIssue[] }> {
  signal.throwIfAborted()
  const source = validatePresentation(input)
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  deck.title = source.title
  // In place of pptxgenjs's own name in the file's properties; the tracked changes Beluga makes carry the same.
  deck.author = 'Beluga'
  deck.company = ''
  deck.subject = ''
  deck.theme = { headFontFace: 'Calibri', bodyFontFace: 'Calibri' }
  masters(deck)
  const issues: SlideIssue[] = []
  source.slides.forEach((slide, index) => {
    const page = deck.addSlide({ masterName: slide.layout === 'title' ? COVER : slide.layout === 'section' ? SECTION : MASTER })
    layout({ page, number: index + 1, issues }, slide, images)
    if (slide.notes) page.addNotes(slide.notes)
  })
  const bytes = await deck.write({ outputType: 'uint8array' }) as Uint8Array
  signal.throwIfAborted()
  return { bytes: finished(bytes), issues }
}
