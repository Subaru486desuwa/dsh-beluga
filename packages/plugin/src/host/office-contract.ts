import type { AttachmentText, OfficePreview, SheetRange } from '../shared/types.ts'
import type { ChangedParagraph, DocumentCheck, DocumentInput, ParagraphChange } from './documents.ts'
import type { PresentationInput, SlideImage, SlideIssue } from './presentations.ts'
import type { ChartCheck, StructureChange, StructureReport, TouchedRange, WorkbookChanges, WorkbookChart, WorkbookCheck, WorkbookInput } from './workbooks.ts'
export interface OfficeEngine {
  extractText(bytes: Uint8Array, name: string, limit: number, signal: AbortSignal): AttachmentText
  renderDocument(input: DocumentInput, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly warnings: readonly string[] }>
  readSheet(bytes: Uint8Array, request: { readonly sheet?: string; readonly range?: string }, limit: number, budget: number, signal: AbortSignal): SheetRange
  /** @param render - false keeps the file away from the engine, as Temporary Chat must. */
  checkDocument(bytes: Uint8Array, name: string, render: boolean, signal: AbortSignal): Promise<DocumentCheck>
  editDocument(bytes: Uint8Array, changes: readonly ParagraphChange[], track: boolean, limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly changed: readonly ChangedParagraph[] }
  fillTemplate(bytes: Uint8Array, values: Readonly<Record<string, string>>, limit: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly unfilled: readonly string[] }>
  /** @param images - the image each image slide names, by attachment id. */
  renderPresentation(input: PresentationInput, images: ReadonlyMap<string, SlideImage>, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly issues: readonly SlideIssue[] }>
  createWorkbook(input: WorkbookInput, signal: AbortSignal): Promise<Uint8Array>
  /** @returns the workbook, and the rectangle written on each sheet. */
  editWorkbook(bytes: Uint8Array, edit: Omit<WorkbookChanges, 'structure'>, limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly touched: readonly TouchedRange[] }
  /**
   * Insert or delete whole rows or columns, with every reference following the cells.
   * @param verify - false keeps the file away from the engine, as Temporary Chat must; an insertion is then not compared before and after.
   * @throws PersonalChatError when the sheet holds something that cannot follow, or an insertion would change the value of an existing cell.
   */
  restructureWorkbook(bytes: Uint8Array, change: StructureChange, limit: number, verify: boolean, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly touched: readonly TouchedRange[]; readonly structure: StructureReport }>
  /** @param calculate - false keeps the file away from the engine, as Temporary Chat must. */
  settleWorkbook(bytes: Uint8Array, limit: number, calculate: boolean, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly check: WorkbookCheck }>
  /** Add native charts to a settled workbook, so their saved data holds its calculated values. */
  addCharts(bytes: Uint8Array, charts: readonly WorkbookChart[], limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly charts: readonly ChartCheck[] }
  /** Rendering works on files, so callers never pass Temporary Chat bytes to these two. */
  previewFile(bytes: Uint8Array, name: string, sheet: string | undefined, limit: number, signal: AbortSignal): Promise<OfficePreview>
  exportPdf(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<Uint8Array>
  /**
   * Save an Office 97–2003 file in the current format it maps to, as LibreOffice reads it. Works on files, so callers never pass Temporary Chat bytes.
   * @throws PersonalChatError when the name is not DOC, XLS or PPT, or the engine cannot open the file.
   */
  convertLegacy(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<Uint8Array>
}
declare module '@deepseek-ai/cordis' { interface Context { personalChatOffice: OfficeEngine } }
export const officeMediaTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
/** Office 97–2003 binary formats, by the current format the engine converts each to before anything reads or renders it. */
export const legacyOfficeFormats: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }
export const legacyOfficeMediaTypes: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' }
const extension = (name: string, formats: Record<string, string>): string | undefined => {
  const found = name.split('.').at(-1)?.toLowerCase()
  return found && Object.hasOwn(formats, found) ? found : undefined
}
/** @returns the current Office format the name has, or undefined for any other file, Office 97–2003 ones included. */
export function officeFormat(name: string): string | undefined { return extension(name, officeMediaTypes) }
/** @returns the Office 97–2003 format the name has. */
export function legacyOfficeFormat(name: string): string | undefined { return extension(name, legacyOfficeFormats) }
/** @returns the current format the Office readers see the file as: its own, or the one an Office 97–2003 file is converted to. */
export function officeReadFormat(name: string): string | undefined {
  const legacy = legacyOfficeFormat(name)
  return legacy ? legacyOfficeFormats[legacy] : officeFormat(name)
}
/** @returns the name a converted Office 97–2003 file takes: the same name with its current format's extension. */
export function convertedOfficeName(name: string): string {
  const legacy = legacyOfficeFormat(name)
  return legacy ? name.slice(0, -legacy.length) + legacyOfficeFormats[legacy] : name
}
