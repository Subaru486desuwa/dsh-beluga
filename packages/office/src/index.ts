import { Context, Service } from '@deepseek-ai/cordis'
import type { DocumentCheck, OfficeEngine, StructureChange } from 'dsh-beluga'
import { OfficeRenderer } from './engine.ts'
import { extractOfficeText } from './office.ts'
import { OfficePackage } from './package.ts'
import { readRange } from './workbook.ts'
import { createWorkbook, settleWorkbook } from './workbook-write.ts'
import { editWorkbook } from './workbook-edit.ts'
import { restructureVerified } from './workbook-structure.ts'
import { addCharts } from './workbook-charts.ts'
import { renderDocument } from './documents.ts'
import { renderPresentation } from './presentations.ts'
import { editDocument, fillTemplate } from './document-edit.ts'
export default class PersonalChatOffice extends Service implements OfficeEngine {
  static inject = ['personalChat']
  private readonly renderer = new OfficeRenderer()
  constructor(ctx: Context) {
    super(ctx, 'personalChatOffice')
    ctx.effect(() => () => this.renderer.dispose())
  }
  extractText = extractOfficeText
  renderDocument = renderDocument
  renderPresentation = renderPresentation
  readSheet(bytes: Uint8Array, request: { readonly sheet?: string; readonly range?: string }, limit: number, budget: number, signal: AbortSignal) {
    return readRange(OfficePackage.open(bytes, limit, signal), request, budget)
  }
  checkDocument(bytes: Uint8Array, name: string, render: boolean, signal: AbortSignal): Promise<DocumentCheck> {
    return render ? this.renderer.check(bytes, name, signal) : Promise.resolve({ opened: false, reason: 'Temporary Chat keeps files in memory, so the layout was not checked' })
  }
  editDocument = editDocument
  fillTemplate = fillTemplate
  createWorkbook = createWorkbook
  editWorkbook = editWorkbook
  restructureWorkbook(bytes: Uint8Array, change: StructureChange, limit: number, verify: boolean, signal: AbortSignal) {
    return restructureVerified(bytes, change, limit, verify ? data => this.renderer.recalculate(data, signal) : undefined, signal)
  }
  settleWorkbook(bytes: Uint8Array, limit: number, calculate: boolean, signal: AbortSignal) {
    return settleWorkbook(bytes, limit, calculate ? data => this.renderer.recalculate(data, signal) : undefined, signal)
  }
  addCharts = addCharts
  previewFile(bytes: Uint8Array, name: string, sheet: string | undefined, limit: number, signal: AbortSignal) { return this.renderer.preview(bytes, name, sheet, limit, signal) }
  exportPdf(bytes: Uint8Array, name: string, signal: AbortSignal) { return this.renderer.pdf(bytes, name, signal) }
  convertLegacy(bytes: Uint8Array, name: string, signal: AbortSignal) { return this.renderer.convertLegacy(bytes, name, signal) }
}
