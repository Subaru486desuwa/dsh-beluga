import { afterAll, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { OfficeRenderer } from '../../office/src/engine.ts'
import { renderPresentation } from '../../office/src/presentations.ts'
import { fitText, lineCount, widthEm } from '../../office/src/slide-fit.ts'
import { budgetDeck } from './office-fixtures.ts'
import { validatePresentation, type SlideImage } from '../src/host/presentations.ts'

const signal = new AbortController().signal
const ENGINE_TIME = 60000
const IMAGE = '7b0e3f9e-3c55-4f61-9a77-2f4b1d1c0a11'
const LAYOUTS = ['title', 'section', 'metrics', 'chart', 'table', 'two_column', 'bullets', 'image']
const picture = async (): Promise<SlideImage> => {
  const { data, info } = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4472c4' } }).png().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType: 'image/png', width: info.width, height: info.height }
}
const build = async (source: object, images: ReadonlyMap<string, SlideImage> = new Map()) => {
  const { bytes, issues } = await renderPresentation(validatePresentation(source), images, signal)
  return { bytes, issues, parts: unzipSync(bytes) }
}
const xml = (parts: Record<string, Uint8Array>, name: string) => strFromU8(parts[name]!)
const named = (parts: Record<string, Uint8Array>, pattern: RegExp) => Object.keys(parts).filter(name => pattern.test(name)).sort()
/** The table cell, or the paragraph of a text box, that holds `text`. */
const around = (source: string, element: string, text: string) => new RegExp(`<${element}>(?:(?!</${element}>).)*<a:t>${text}</a:t>.*?</${element}>`, 'su').exec(source)?.[0] ?? ''
const deck = (slides: object[]) => ({ title: 'Deck', slides })
const chart = (extra: object) => ({ layout: 'chart', title: 'Chart', chart: 'column', categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }], ...extra })

describe('presentation source', () => {
  it('accepts every layout', () => {
    expect(validatePresentation(budgetDeck(IMAGE)).slides.map(slide => slide.layout)).toEqual(LAYOUTS)
  })
  it('refuses more than a slide holds, saying how to split it', () => {
    const refusals: [object, RegExp][] = [
      [{ layout: 'bullets', title: 'T', bullets: Array.from({ length: 9 }, () => 'x') }, /at most 8 bullets; split them across slides/u],
      [{ layout: 'bullets', title: 'T', bullets: [{ text: 'x', level: 3 }] }, /level/u],
      [{ layout: 'table', title: 'T', rows: [Array.from({ length: 9 }, () => 'h'), Array.from({ length: 9 }, () => '1')] }, /at most 8 columns; split it across slides/u],
      [{ layout: 'table', title: 'T', rows: Array.from({ length: 13 }, () => ['x']) }, /at most 12 rows, the header included; split it across slides/u],
      [{ layout: 'table', title: 'T', rows: [['a', 'b'], ['1']] }, /same number of cells/u],
      [chart({ series: [{ name: 'S', values: [1] }] }), /one value per category/u],
      [chart({ categories: Array.from({ length: 25 }, (_, index) => 'C' + index) }), /at most 24 categories; split it across slides/u],
      [chart({ series: Array.from({ length: 7 }, (_, index) => ({ name: 'S' + index, values: [1, 2] })) }), /at most 6 series/u],
      [chart({ chart: 'pie', series: [{ name: 'S', values: [1, 2] }, { name: 'U', values: [3, 4] }] }), /one series of at most 8 slices/u],
      [chart({ chart: 'doughnut', categories: Array.from({ length: 9 }, (_, index) => 'C' + index), series: [{ name: 'S', values: Array.from({ length: 9 }, () => 1) }] }), /one series of at most 8 slices/u],
      [{ layout: 'metrics', title: 'T', metrics: Array.from({ length: 5 }, () => ({ value: '1', label: 'x' })) }, /at most 4 metrics/u],
      [{ layout: 'section', title: 'T', notes: 'x'.repeat(4001) }, /4000/u],
      [{ layout: 'section', title: 'T', x: 1, y: 2 }, /unrecognized|Unrecognized/u],
    ]
    for (const [slide, message] of refusals) expect(() => validatePresentation(deck([slide])), JSON.stringify(slide).slice(0, 80)).toThrow(message)
    expect(() => validatePresentation(deck(Array.from({ length: 41 }, () => ({ layout: 'section', title: 'T' }))))).toThrow(/at most 40 slides/u)
    expect(() => validatePresentation(deck(Array.from({ length: 40 }, () => ({ layout: 'bullets', title: 'T', bullets: Array.from({ length: 8 }, () => 'x'.repeat(1000)) }))))).toThrow('exceeds 256 KiB')
  })
  it('takes an image only as the id of a file attached to the chat', () => {
    for (const image of ['https://example.com/a.png', '/etc/passwd', 'file:///etc/passwd', 'data:image/png;base64,iVBORw0KGgo=', '../a.png']) {
      expect(() => validatePresentation(deck([{ layout: 'image', title: 'T', image }])), image).toThrow(/uuid/iu)
    }
  })
})

describe('slide text fit', () => {
  it('counts East Asian characters a whole em and others about half', () => {
    expect(widthEm('预算，')).toBe(3)
    expect(widthEm('Budget')).toBeCloseTo(3.3)
  })
  it('breaks lines between words and around East Asian characters', () => {
    expect(lineCount('一二三四五六七八九十', 4)).toBe(3)
    expect(lineCount('alpha beta', 5)).toBe(2)
    expect(lineCount('alpha beta', 6)).toBe(1)
    expect(lineCount('x'.repeat(20), 5)).toBe(3)
    expect(lineCount('a\nb', 5)).toBe(2)
  })
  it('steps down two points at a time to the largest size that fits, and says when even the smallest does not', () => {
    expect(fitText([{ text: 'aaaa' }], { width: 100, height: 30 }, 22, 16)).toEqual({ size: 22, fits: true })
    expect(fitText([{ text: 'a'.repeat(10) }], { width: 100, height: 30 }, 22, 16)).toEqual({ size: 18, fits: true })
    expect(fitText([{ text: 'a'.repeat(10) }], { width: 100, height: 10 }, 22, 16)).toEqual({ size: 16, fits: false })
  })
})

describe('building a presentation', async () => {
  const image = await picture()
  const budget = await build(budgetDeck(IMAGE), new Map([[IMAGE, image]]))
  const slides = named(budget.parts, /^ppt\/slides\/slide\d+\.xml$/u)
  const text = slides.map(name => xml(budget.parts, name)).join('')

  it('lays out every slide on the theme, its titles in title placeholders', () => {
    expect(slides).toHaveLength(8)
    expect(budget.issues).toEqual([])
    for (const name of slides) expect(xml(budget.parts, name), name).toMatch(/<p:ph\s+idx="\d+"\s+type="title"/u)
    expect(around(xml(budget.parts, 'ppt/slides/slide3.xml'), 'a:p', '全年关键数字')).toContain('algn="l"')
    expect(around(xml(budget.parts, 'ppt/slides/slide1.xml'), 'a:p', '2026 年度预算回顾')).toContain('lang="zh-CN"')
    const core = xml(budget.parts, 'docProps/core.xml')
    expect(core).toContain('<dc:title>2026 年度预算回顾</dc:title>')
    expect(core).toContain('<dc:creator>Beluga</dc:creator>')
    expect(core + xml(budget.parts, 'docProps/app.xml')).not.toContain('PptxGenJS')
  })
  it('declares a content type for every part and none for a part it lacks, as PowerPoint expects', () => {
    const types = xml(budget.parts, '[Content_Types].xml')
    const overrides = [...types.matchAll(/<Override PartName="\/([^"]+)"/gu)].map(match => match[1]!)
    const defaults = new Set([...types.matchAll(/<Default Extension="([^"]+)"/gu)].map(match => match[1]!))
    expect(overrides.filter(part => !(part in budget.parts))).toEqual([])
    expect(Object.keys(budget.parts).filter(part => part !== '[Content_Types].xml' && !overrides.includes(part) && !defaults.has(part.split('.').pop()!))).toEqual([])
    expect(overrides.filter(part => part.startsWith('ppt/slideMasters/'))).toEqual(['ppt/slideMasters/slideMaster1.xml'])
  })
  it('gives the notes master a theme of its own, and keeps the order PowerPoint for Mac opens', () => {
    expect(xml(budget.parts, 'ppt/notesMasters/_rels/notesMaster1.xml.rels')).toContain('Target="../theme/theme2.xml"')
    expect(xml(budget.parts, 'ppt/theme/theme2.xml')).toBe(xml(budget.parts, 'ppt/theme/theme1.xml'))
    // The schema puts the notes master list first, but PowerPoint for Mac was reported not to open that order.
    const presentation = xml(budget.parts, 'ppt/presentation.xml')
    expect(presentation.indexOf('<p:notesMasterIdLst>')).toBeGreaterThan(presentation.indexOf('</p:sldIdLst>'))
  })
  it('names no typeface but the theme, which sets Chinese in Microsoft YaHei', () => {
    const theme = xml(budget.parts, 'ppt/theme/theme1.xml')
    expect(theme.match(/<a:latin typeface="Calibri"\/><a:ea typeface="Microsoft YaHei"\/>/gu)).toHaveLength(2)
    for (const name of named(budget.parts, /^ppt\/(slides|slideMasters|slideLayouts|charts|notesSlides|notesMasters)\/[a-zA-Z]+\d+\.xml$/u)) expect(xml(budget.parts, name), name).not.toMatch(/typeface="(?!\+m[jn]-)/u)
  })
  it('says the figures the workbook and report say', () => {
    for (const figure of ['230,000', '235,000', '5,000', '2.17%']) expect(text).toContain('<a:t>' + figure + '</a:t>')
  })
  it('draws a native chart with its data in an embedded workbook, bars from zero', () => {
    const [part] = named(budget.parts, /^ppt\/charts\/chart\d+\.xml$/u)
    const chartXml = xml(budget.parts, part!)
    expect(chartXml).toContain('<c:barDir val="col"/>')
    expect(chartXml).toContain('<c:min val="0"/>')
    expect(chartXml).toContain('<c:numFmt formatCode="#,##0" sourceLinked="0"/>')
    expect(chartXml).toContain('<c:tickLblPos val="low"/>')
    expect(chartXml).toContain('<c:v>62000</c:v>')
    const embedded = /Target="\.\.\/embeddings\/([^"]+\.xlsx)"/u.exec(xml(budget.parts, part!.replace('charts/', 'charts/_rels/') + '.rels'))?.[1]
    const book = unzipSync(budget.parts['ppt/embeddings/' + embedded]!)
    expect(strFromU8(book['xl/worksheets/sheet1.xml']!)).toContain('62000')
  })
  it('sets figures right in a table and words left, under a filled header', () => {
    const table = xml(budget.parts, 'ppt/slides/slide5.xml')
    expect(around(table, 'a:tc', '55,000')).toContain('algn="r"')
    expect(around(table, 'a:tc', '-1,000')).toContain('algn="r"')
    expect(around(table, 'a:tc', '预算（元）')).toContain('algn="r"')
    expect(around(table, 'a:tc', 'Q1')).toContain('algn="l"')
    expect(around(table, 'a:tc', '季度')).toContain('<a:srgbClr val="1F4E79"/>')
  })
  it('keeps speaker notes', () => {
    expect(xml(budget.parts, 'ppt/notesSlides/notesSlide1.xml')).toContain('开场：先说结论，超支 5,000 元。')
    expect(xml(budget.parts, 'ppt/notesSlides/notesSlide7.xml')).toContain('强调预警阈值。')
  })
  it('embeds the image from the bytes it was given, never a link', () => {
    const media = named(budget.parts, /^ppt\/media\//u)
    expect(media).toHaveLength(1)
    expect(Buffer.from(budget.parts[media[0]!]!)).toEqual(Buffer.from(image.data))
    expect(xml(budget.parts, 'ppt/slides/slide8.xml')).toContain('descr="季度支出走势"')
    for (const name of named(budget.parts, /\.rels$/u)) expect(xml(budget.parts, name), name).not.toContain('TargetMode="External"')
  })
  it('refuses a slide whose image was not provided', async () => {
    await expect(build(budgetDeck(IMAGE))).rejects.toThrow('Slide 8: its image was not provided')
  })
  it('reports text that does not fit even at the smallest size, by slide and region', async () => {
    const long = 'This sentence is long enough that eight of them overflow the body of a slide at sixteen points. '.repeat(3)
    const { issues } = await build(deck([
      { layout: 'bullets', title: '预算'.repeat(100), bullets: Array.from({ length: 8 }, () => long) },
      { layout: 'bullets', title: 'Fits', bullets: ['Short'] },
      { layout: 'two_column', title: 'Columns', left: { bullets: ['Short'] }, right: { heading: 'Long', bullets: Array.from({ length: 8 }, () => long) } },
      { layout: 'table', title: 'Table', rows: Array.from({ length: 12 }, () => [long.slice(0, 400)]) },
    ]))
    expect(issues).toEqual([
      { slide: 1, region: 'title', issue: 'overflow' },
      { slide: 1, region: 'bullets', issue: 'overflow' },
      { slide: 3, region: 'right', issue: 'overflow' },
      { slide: 4, region: 'rows', issue: 'overflow' },
    ])
  })
  it('starts bars at zero only when no value is negative, and shows shares on round charts', async () => {
    const { parts } = await build(deck([
      chart({ series: [{ name: 'S', values: [-1, 2] }] }),
      chart({ chart: 'line' }),
      chart({ chart: 'pie' }),
    ]))
    const charts = named(parts, /^ppt\/charts\/chart\d+\.xml$/u).map(name => xml(parts, name))
    expect(charts).toHaveLength(3)
    expect(charts.find(item => item.includes('<c:barChart>'))).not.toContain('<c:min val="0"/>')
    expect(charts.find(item => item.includes('<c:lineChart>'))).not.toContain('<c:min val="0"/>')
    const pie = charts.find(item => item.includes('<c:pieChart>'))!
    expect(pie).toContain('<c:showPercent val="1"/>')
    expect(pie).toContain('formatCode="0.0%"')
  })
})

describe('opening a presentation in the engine', () => {
  const renderer = new OfficeRenderer()
  afterAll(() => renderer.dispose())
  it('opens every slide, with Chinese text and no font the deck names but cannot find', async () => {
    const { bytes } = await build(budgetDeck(IMAGE), new Map([[IMAGE, await picture()]]))
    const check = await renderer.check(bytes, 'deck.pptx', signal)
    expect(check).toMatchObject({ opened: true, pages: 8 })
    expect(check.opened && check.missingFonts).not.toContain('Arial')
    const pdf = await renderer.pdf(bytes, 'deck.pptx', signal)
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-')
  }, ENGINE_TIME)
})
