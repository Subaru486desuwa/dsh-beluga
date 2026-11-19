import { z } from 'zod'
import { PersonalChatError } from './archive.ts'

/** Whether text can go into XML: it holds no control character other than tab and line breaks. */
export const clean = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
const text = z.string().max(20000).refine(clean, 'XML control characters are not allowed')
const chartText = text.pipe(z.string().min(1).max(200))
const documentBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), text }).strict(),
  z.object({ kind: z.literal('heading'), text, level: z.number().int().min(1).max(3) }).strict(),
  z.object({ kind: z.literal('table'), rows: z.array(z.array(text).min(1).max(12)).min(1).max(200) }).strict(),
  z.object({ kind: z.literal('html'), html: z.string().min(1).max(200000).refine(clean, 'XML control characters are not allowed') }).strict(),
  z.object({ kind: z.literal('chart'), chart: z.enum(['column', 'bar', 'line', 'pie']), title: chartText.optional(), categories: z.array(chartText).min(1).max(100), series: z.array(z.object({ name: chartText, values: z.array(z.number().finite()).min(1).max(100) }).strict()).min(1).max(12) }).strict(),
  z.object({ kind: z.literal('toc') }).strict(),
  z.object({ kind: z.literal('pageBreak') }).strict(),
])
export const documentInput = z.object({ title: text, blocks: z.array(documentBlock).min(1).max(500), header: text.optional(), pageNumbers: z.boolean().optional() }).strict()
export type DocumentInput = z.infer<typeof documentInput>
export function validateDocument(input: unknown): DocumentInput {
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new PersonalChatError('document-limit', 'Document source exceeds 256 KiB')
  const value = documentInput.parse(input)
  for (const block of value.blocks) {
    if (block.kind === 'table' && block.rows.some(row => row.length !== block.rows[0]!.length)) throw new PersonalChatError('document-table', 'All table rows must have equal column counts')
    if (block.kind === 'chart' && block.series.some(series => series.values.length !== block.categories.length)) throw new PersonalChatError('document-table', 'Each chart series needs one value per category')
  }
  return value
}
const paragraphFormat = z.object({
  font: z.string().trim().min(1).max(100).refine(clean, 'XML control characters are not allowed').optional(),
  /** Points. */
  size: z.number().min(1).max(400).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/u, 'Give a colour as six hex digits, for example #C00000').optional(),
  highlight: z.enum(['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black', 'none']).optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'A format needs at least one property')
/** The look a change gives a whole paragraph. A property left out stays as it is. */
export type ParagraphFormat = z.infer<typeof paragraphFormat>
const change = z.object({
  part: z.string().max(100).optional(),
  location: z.string().min(1).max(500),
  /** Left out only for `set_cell`, which writes a cell whatever it holds. */
  expected: z.string().max(100000).optional(),
  action: z.enum(['replace', 'set_cell', 'insert_after', 'delete', 'format', 'insert_row_after', 'delete_row']),
  text: text.optional(),
  format: paragraphFormat.optional(),
  cells: z.array(text).max(63).optional(),
}).strict()
  .refine(value => !['replace', 'set_cell', 'insert_after'].includes(value.action) || value.text !== undefined, 'replace, set_cell and insert_after need text')
  .refine(value => value.action === 'set_cell' || value.expected !== undefined, 'Every action but set_cell needs expected')
  .refine(value => value.action !== 'format' || value.format !== undefined, 'format needs format')
  .refine(value => value.cells === undefined || value.action === 'insert_row_after', 'cells belong to insert_row_after')
  .refine(value => value.format === undefined || !['delete', 'delete_row'].includes(value.action), 'A deleted paragraph or row takes no format')
export type ParagraphChange = z.infer<typeof change>
/** A paragraph an edit wrote, as a read of the new file lists it. */
export interface ChangedParagraph { readonly part: string; readonly location: string; readonly text: string; /** Length of the text without line breaks, for a limit the document sets on it. */ readonly characters: number; /** Set for a table cell written whole: how many paragraphs it now holds, one per line of `text`. */ readonly paragraphs?: number }
export const documentEdit = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), track: z.boolean().optional(), changes: z.array(change).min(1).max(200) }).strict()
/** What opening a file showed, so a reply can stand behind it. */
export type DocumentCheck =
  | { readonly opened: true; readonly pages: number; readonly missingFonts: readonly string[] }
  | { readonly opened: false; readonly reason: string }
export const templateFill = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), values: z.record(z.string().min(1).max(200), text) }).strict()
