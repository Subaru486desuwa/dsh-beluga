import { z } from 'zod'
import { PersonalChatError } from './archive.ts'

const clean = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
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
export const workbookInput = z.object({ title: z.string().trim().min(1).max(200).refine(clean), sheets: z.array(sheet).min(1).max(32) }).strict()
export type WorkbookInput = z.infer<typeof workbookInput>
export function validateWorkbook(input: unknown): WorkbookInput {
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new PersonalChatError('document-limit', 'Workbook source exceeds 1 MiB')
  const value = workbookInput.parse(input)
  if (new Set(value.sheets.map(item => item.name.toLowerCase())).size !== value.sheets.length) throw new PersonalChatError('workbook-target', 'Sheet names must be unique')
  return value
}
export const cellChange = z.object({ sheet: z.string().min(1), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/u), value: workbookCell }).strict()
export type CellChange = z.infer<typeof cellChange>
export const workbookEdit = z.object({ attachmentId: z.string().uuid(), summary: z.string().trim().min(1).max(500), changes: z.array(cellChange).min(1).max(1000) }).strict()
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
}
