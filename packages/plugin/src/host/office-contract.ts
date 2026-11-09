import type { AttachmentText, OfficePreview, SheetRange } from '../shared/types.ts'
import type { DocumentCheck, DocumentInput, ParagraphChange } from './documents.ts'
import type { PresentationInput, SlideImage, SlideIssue } from './presentations.ts'
import type { CellChange, ChartCheck, WorkbookChart, WorkbookCheck, WorkbookInput } from './workbooks.ts'
export interface OfficeEngine {
  extractText(bytes: Uint8Array, name: string, limit: number, signal: AbortSignal): AttachmentText
  renderDocument(input: DocumentInput, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly warnings: readonly string[] }>
  readSheet(bytes: Uint8Array, request: { readonly sheet?: string; readonly range?: string }, limit: number, budget: number, signal: AbortSignal): SheetRange
  /** @param render - false keeps the file away from the engine, as Temporary Chat must. */
  checkDocument(bytes: Uint8Array, name: string, render: boolean, signal: AbortSignal): Promise<DocumentCheck>
  editDocument(bytes: Uint8Array, changes: readonly ParagraphChange[], track: boolean, limit: number, signal: AbortSignal): Uint8Array
  fillTemplate(bytes: Uint8Array, values: Readonly<Record<string, string>>, limit: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly unfilled: readonly string[] }>
  /** @param images - the image each image slide names, by attachment id. */
  renderPresentation(input: PresentationInput, images: ReadonlyMap<string, SlideImage>, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly issues: readonly SlideIssue[] }>
  createWorkbook(input: WorkbookInput, signal: AbortSignal): Promise<Uint8Array>
  editWorkbook(bytes: Uint8Array, changes: readonly CellChange[], limit: number, signal: AbortSignal): Uint8Array
  /** @param calculate - false keeps the file away from the engine, as Temporary Chat must. */
  settleWorkbook(bytes: Uint8Array, limit: number, calculate: boolean, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly check: WorkbookCheck }>
  /** Add native charts to a settled workbook, so their saved data holds its calculated values. */
  addCharts(bytes: Uint8Array, charts: readonly WorkbookChart[], limit: number, signal: AbortSignal): { readonly bytes: Uint8Array; readonly charts: readonly ChartCheck[] }
  /** Rendering works on files, so callers never pass Temporary Chat bytes to these two. */
  previewFile(bytes: Uint8Array, name: string, sheet: string | undefined, limit: number, signal: AbortSignal): Promise<OfficePreview>
  exportPdf(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<Uint8Array>
}
declare module '@deepseek-ai/cordis' { interface Context { personalChatOffice: OfficeEngine } }
export const officeMediaTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export function officeFormat(name: string): string | undefined {
  const extension = name.split('.').at(-1)?.toLowerCase()
  return extension && Object.hasOwn(officeMediaTypes, extension) ? extension : undefined
}
