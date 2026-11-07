import { z } from 'zod'
import { PersonalChatError } from './archive.ts'

const clean = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
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
const change = z.object({
  part: z.string().max(100).optional(),
  location: z.string().min(1).max(500),
  expected: z.string().max(100000),
  action: z.enum(['replace', 'insert_after', 'delete']),
  text: text.optional(),
}).strict().refine(value => value.action === 'delete' || value.text !== undefined, 'replace and insert_after need text')
export type ParagraphChange = z.infer<typeof change>
export const documentEdit = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), track: z.boolean().optional(), changes: z.array(change).min(1).max(200) }).strict()
/** What opening a file showed, so a reply can stand behind it. */
export type DocumentCheck =
  | { readonly opened: true; readonly pages: number; readonly missingFonts: readonly string[] }
  | { readonly opened: false; readonly reason: string }
export const templateFill = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), values: z.record(z.string().min(1).max(200), text) }).strict()
