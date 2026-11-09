/** What create_presentation accepts: slides in fixed layouts, so the engine, not the model, places and sizes everything. */
import { z } from 'zod'
import { PersonalChatError } from './archive.ts'
import { clean } from './documents.ts'

const MAX_BULLETS = 8
const line = (max: number) => z.string().trim().min(1).max(max).refine(clean, 'XML control characters are not allowed')
const title = line(200)
const bullet = z.union([line(1000), z.object({ text: line(1000), level: z.union([z.literal(1), z.literal(2)]) }).strict()])
const bullets = z.array(bullet).min(1).max(MAX_BULLETS, `A slide holds at most ${MAX_BULLETS} bullets; split them across slides`)
const notes = z.string().max(4000).refine(clean, 'XML control characters are not allowed').optional()
const column = z.object({ heading: line(200).optional(), bullets }).strict()
const cell = z.string().max(500).refine(clean, 'XML control characters are not allowed')
const slide = z.discriminatedUnion('layout', [
  z.object({ layout: z.literal('title'), title, subtitle: line(300).optional(), notes }).strict(),
  z.object({ layout: z.literal('section'), title, notes }).strict(),
  z.object({ layout: z.literal('bullets'), title, bullets, notes }).strict(),
  z.object({ layout: z.literal('two_column'), title, left: column, right: column, notes }).strict(),
  z.object({
    layout: z.literal('chart'), title, chart: z.enum(['column', 'bar', 'line', 'pie', 'doughnut']),
    categories: z.array(line(100)).min(1).max(24, 'A chart holds at most 24 categories; split it across slides'),
    series: z.array(z.object({ name: line(100), values: z.array(z.number().finite()).min(1).max(24) }).strict()).min(1).max(6, 'A chart holds at most 6 series'),
    unit: line(20).optional(), notes,
  }).strict(),
  z.object({
    layout: z.literal('table'), title,
    rows: z.array(z.array(cell).min(1).max(8, 'A table slide holds at most 8 columns; split it across slides')).min(2, 'Give a header row and at least one row').max(12, 'A table slide holds at most 12 rows, the header included; split it across slides'),
    notes,
  }).strict(),
  z.object({ layout: z.literal('metrics'), title, metrics: z.array(z.object({ value: line(24), label: line(100) }).strict()).min(1).max(4, 'A metrics slide holds at most 4 metrics'), notes }).strict(),
  z.object({ layout: z.literal('image'), title, image: z.string().uuid(), bullets: bullets.optional(), notes }).strict(),
])
export const presentationInput = z.object({ title, slides: z.array(slide).min(1).max(40, 'A presentation holds at most 40 slides') }).strict()
export type PresentationInput = z.infer<typeof presentationInput>
export type Slide = PresentationInput['slides'][number]
export function validatePresentation(input: unknown): PresentationInput {
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new PersonalChatError('presentation-limit', 'Presentation source exceeds 256 KiB')
  const value = presentationInput.parse(input)
  value.slides.forEach((item, index) => {
    const at = 'Slide ' + (index + 1) + ': '
    if (item.layout === 'table' && item.rows.some(row => row.length !== item.rows[0]!.length)) throw new PersonalChatError('presentation-table', at + 'all table rows need the same number of cells')
    if (item.layout !== 'chart') return
    if (item.series.some(series => series.values.length !== item.categories.length)) throw new PersonalChatError('presentation-chart', at + 'each series needs one value per category')
    if ((item.chart === 'pie' || item.chart === 'doughnut') && (item.series.length > 1 || item.categories.length > 8)) throw new PersonalChatError('presentation-chart', at + 'a ' + item.chart + ' chart takes one series of at most 8 slices')
  })
  return value
}
/** Text that does not fit its region even at the smallest size; `region` names the field it came from. */
export interface SlideIssue { readonly slide: number; readonly region: string; readonly issue: 'overflow' }
/** An image a slide shows: the bytes of a PNG or JPEG attached to the chat, never a path or URL. */
export interface SlideImage { readonly data: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg'; readonly width: number; readonly height: number }
/** What opening the deck showed, with the text the layout estimate could not fit. Temporary Chat skips the opening. */
export type PresentationCheck = (
  | { readonly opened: true; readonly slides: number; readonly missingFonts: readonly string[] }
  | { readonly opened: false; readonly reason: string }
) & { readonly issues: readonly SlideIssue[] }
