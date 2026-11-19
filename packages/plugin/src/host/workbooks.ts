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
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/u, 'Give a colour as six hex digits, for example #C00000')
const cellFormat = z.object({
  font: z.string().trim().min(1).max(100).refine(clean, 'XML control characters are not allowed').optional(),
  /** Points. */
  size: z.number().min(1).max(409).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: hex.optional(),
  fill: z.union([hex, z.literal('none')]).optional(),
  numberFormat: z.string().min(1).max(200).refine(clean, 'XML control characters are not allowed').optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  wrap: z.boolean().optional(),
  border: z.enum(['all', 'none']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'A format needs at least one property')
/** The look a change gives every cell of a range. A property left out stays as it is. */
export type CellFormat = z.infer<typeof cellFormat>
const columns = z.string().regex(/^[A-Z]{1,3}(?::[A-Z]{1,3})?$/u, 'Use a column or span such as B or B:D')
const rowSpan = z.string().regex(/^[1-9]\d{0,6}(?::[1-9]\d{0,6})?$/u, 'Use a row or span such as 3 or 3:8')
/** A sheet a file already has may carry a name Excel would refuse today. */
const sheetRef = z.string().min(1).max(255)
const count = z.number().int().min(1).max(1000)
/** One insertion or deletion of whole rows or columns. Everything that refers to the cells it moves is rewritten to follow them. */
const structureChange = z.discriminatedUnion('action', [
  z.object({ sheet: sheetRef, action: z.literal('insert_rows'), before: z.number().int().min(1).max(1048576), count }).strict(),
  z.object({ sheet: sheetRef, action: z.literal('delete_rows'), first: z.number().int().min(1).max(1048576), count }).strict(),
  z.object({ sheet: sheetRef, action: z.literal('insert_columns'), before: z.string().regex(/^[A-Z]{1,3}$/u), count: count.max(200) }).strict(),
  z.object({ sheet: sheetRef, action: z.literal('delete_columns'), first: z.string().regex(/^[A-Z]{1,3}$/u), count: count.max(200) }).strict(),
])
export type StructureChange = z.infer<typeof structureChange>
const workbookChanges = z.object({
  /** Empty sheets to add after the existing ones. */
  sheets: z.array(z.object({ name: sheetName }).strict()).max(16).optional(),
  changes: z.array(cellChange).max(1000).default([]),
  /** Rows of values written below the last row of a sheet that holds data. */
  append: z.array(z.object({ sheet: sheetRef, rows: z.array(z.array(workbookCell).min(1).max(200)).min(1).max(1000) }).strict()).max(16).optional(),
  formats: z.array(z.object({ sheet: sheetRef, range, format: cellFormat }).strict()).max(200).optional(),
  merges: z.array(z.object({ sheet: sheetRef, range, merge: z.boolean() }).strict()).max(200).optional(),
  columnWidths: z.array(z.object({ sheet: sheetRef, columns, width: z.number().min(0.5).max(255) }).strict()).max(200).optional(),
  rowHeights: z.array(z.object({ sheet: sheetRef, rows: rowSpan, height: z.number().min(1).max(409) }).strict()).max(200).optional(),
  structure: structureChange.optional(),
}).strict()
/** Everything one call changes in a workbook, apart from charts. */
export type WorkbookChanges = z.infer<typeof workbookChanges>
const OTHER_THAN_STRUCTURE = ['sheets', 'append', 'formats', 'merges', 'columnWidths', 'rowHeights'] as const
export const workbookEdit = workbookChanges.extend({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), charts }).strict()
  .refine(value => value.changes.length > 0 || !!value.charts?.length || !!value.structure || OTHER_THAN_STRUCTURE.some(key => !!value[key]?.length), 'Give at least one change')
  .refine(value => !value.structure || (value.changes.length === 0 && !value.charts?.length && OTHER_THAN_STRUCTURE.every(key => !value[key]?.length)), 'Inserting or deleting rows or columns moves cells, so it goes in a call of its own; make the other changes in the next call, with the cells as they are then')
/** The cells a call wrote on one sheet, as one rectangle around them. */
export interface TouchedRange { readonly sheet: string; readonly range: string }
/** What inserting or deleting rows or columns did to the rest of the workbook. */
export interface StructureReport {
  /** Formulas that referred to deleted cells and now give `#REF!`, first ones only. */
  readonly brokenReferences: readonly { readonly sheet: string; readonly cell: string }[]
  readonly brokenCount: number
  /** Whether every cell outside the change still calculates to the value it had; absent when the workbook could not be calculated here. */
  readonly verified?: boolean
  readonly reason?: string
}
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
