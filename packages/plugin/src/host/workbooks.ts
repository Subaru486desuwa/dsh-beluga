import { z } from 'zod'
import { PersonalChatError } from './archive.ts'
import { clean } from './documents.ts'

const text = z.string().max(32767).refine(clean, 'XML control characters are not allowed')
/** Functions that fetch a URL or start a program when a workbook opens. Files store newer ones with a `_xlfn.` prefix. */
const REACHING_FUNCTION = /(?<![\p{L}\p{N}_])(?:WEBSERVICE|IMAGE|RTD|DDE|CALL|REGISTER(?:\.ID)?)\s*\(/iu
/** A reference to another workbook, as `[1]Sheet!A1` or `'https://host/[book.xlsx]Sheet'!A1`. A table column is `Table[2024]`. */
const OTHER_WORKBOOK = /(?<![\p{L}\p{N}_])\[\d+\]|'[^']*\[[^']*\][^']*'!/u
/** @returns whether a formula could send data out or run something, judged outside its quoted text. */
export function reachesOutside(formula: string): boolean {
  const unquoted = formula.replace(/"(?:[^"]|"")*"/gu, '""')
  const code = unquoted.replace(/'(?:[^']|'')*'/gu, "''")
  return OTHER_WORKBOOK.test(unquoted) || REACHING_FUNCTION.test(code) || /[\p{L}\p{N}_]\|/u.test(code)
}
const formula = z.string().trim().min(1).max(8192).refine(clean, 'XML control characters are not allowed').transform(value => value.replace(/^=/u, '')).refine(value => !reachesOutside(value), 'Formulas cannot reach the network or other programs')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u).refine(value => !Number.isNaN(Date.parse(value.replace(' ', 'T') + (value.length > 10 ? 'Z' : ''))), 'Invalid date')
/** Text stays text even when it starts with `=`; only `{ formula }` makes a formula. */
export const workbookCell = z.union([text, z.number().finite(), z.boolean(), z.null(), z.object({ formula }).strict(), z.object({ date }).strict()])
export type WorkbookCell = z.infer<typeof workbookCell>
const sheetName = z.string().min(1).max(31).refine(value => !/[\\/?*[\]:]/u.test(value) && !/^'|'$/u.test(value), 'Sheet names cannot contain \\ / ? * [ ] : or start or end with an apostrophe')
const sheet = z.object({
  name: sheetName,
  rows: z.array(z.array(workbookCell).max(200)).min(1).max(10000),
  header: z.boolean().optional(),
  filter: z.boolean().optional(),
  freeze: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/u).optional(),
  widths: z.record(z.string().regex(/^[A-Z]{1,3}$/u), z.number().min(1).max(120)).optional(),
  formats: z.record(z.string().regex(/^[A-Z]{1,3}$/u), z.string().min(1).max(100)).optional(),
}).strict()
const range = z.string().regex(/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/u, 'Use a range such as B2:B13')
const label = z.string().trim().min(1).max(200).refine(clean, 'XML control characters are not allowed')
/** A native chart of cells on one sheet. Its series read the cells, so it follows the data. */
export const workbookChart = z.object({
  sheet: z.string().min(1).max(31),
  chart: z.enum(['column', 'bar', 'line', 'pie']),
  title: label.optional(),
  categories: range,
  series: z.array(z.object({ values: range, name: label.optional() }).strict()).min(1).max(12),
}).strict().refine(value => value.chart !== 'pie' || value.series.length === 1, 'A pie chart takes one series')
export type WorkbookChart = z.infer<typeof workbookChart>
const charts = z.array(workbookChart).max(16).optional()
export const workbookInput = z.object({ title: z.string().trim().min(1).max(200).refine(clean), sheets: z.array(sheet).min(1).max(32), charts }).strict()
export type WorkbookInput = z.infer<typeof workbookInput>
export function validateWorkbook(input: unknown): WorkbookInput {
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new PersonalChatError('document-limit', 'Workbook source exceeds 1 MiB')
  const value = workbookInput.parse(input)
  if (new Set(value.sheets.map(item => item.name.toLowerCase())).size !== value.sheets.length) throw new PersonalChatError('workbook-target', 'Sheet names must be unique')
  const names = value.sheets.map(item => item.name)
  for (const chart of value.charts ?? []) if (!names.includes(chart.sheet)) throw new PersonalChatError('workbook-target', 'A chart names sheet ' + JSON.stringify(chart.sheet) + '; the sheets are ' + names.join(', '))
  return value
}
export const cellChange = z.object({ sheet: z.string().min(1), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/u), value: workbookCell }).strict()
export type CellChange = z.infer<typeof cellChange>
export const workbookEdit = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), changes: z.array(cellChange).max(1000).default([]), charts })
  .strict().refine(value => value.changes.length > 0 || !!value.charts?.length, 'Give changes, charts or both')
/** Where a new chart went, and what in its data it cannot draw. */
export interface ChartCheck {
  readonly sheet: string
  readonly title?: string
  /** The cells the chart covers. */
  readonly at: string
  /** Value cells holding text, a boolean or an error, which the chart leaves out; first ones only. */
  readonly notNumbers: readonly string[]
}
/** What opening a finished workbook will show, so a reply can stand behind its numbers. */
export interface WorkbookCheck {
  readonly recalculated: boolean
  /** Why formulas were not calculated here; Excel still calculates them when the file opens. */
  readonly reason?: string
  readonly formulas: number
  /** Cells whose formula gives an error such as `#REF!`, first ones only. */
  readonly errors: readonly { readonly sheet: string; readonly cell: string; readonly value: string }[]
  readonly errorCount: number
  /** Cells using a function the engine lacks; they keep their saved value. */
  readonly unverified: readonly { readonly sheet: string; readonly cell: string }[]
  /** Charts this call added. */
  readonly charts?: readonly ChartCheck[]
}
