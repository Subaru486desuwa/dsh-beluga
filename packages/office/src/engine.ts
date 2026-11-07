/** Render and recalculate through the official LibreOffice Kit. It works on files, so each call owns a private directory. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversionError, createConverter, type Converter, type RenderImagesRequest, type RenderImagesResult } from '@deepseek-ai/libreoffice-kit'
import { PersonalChatError, officeFormat } from 'dsh-beluga'
import type { DocumentCheck, OfficePreview } from 'dsh-beluga'
import { OfficePackage } from './package.ts'
import { cellRef, findSheet, openBook, outlineSheet } from './workbook.ts'

const TIMEOUT_MS = 60000
/** Sharp on a laptop screen without bloating the page images; 96 blurs small text. */
const PREVIEW_DPI = 120
/** The check keeps no image, so it spends as little as it can on one. */
const CHECK_DPI = 36
const PREVIEW_PAGES = 20
/** A sheet preview is a look at the start of the data, not the whole workbook. */
const PREVIEW_ROWS = 60
const PREVIEW_COLUMNS = 26

export class OfficeRenderer {
  private converter?: Promise<Converter>
  private engine(): Promise<Converter> {
    this.converter ??= createConverter({ timeoutMs: TIMEOUT_MS }).catch((error: unknown) => { delete this.converter; throw error })
    return this.converter
  }
  /** Abort anything running. The next call starts a new converter. */
  async dispose(): Promise<void> {
    const converter = this.converter
    delete this.converter
    await (await converter?.catch(() => undefined))?.dispose()
  }
  private async inFiles<T>(bytes: Uint8Array, format: string, run: (engine: Converter, input: string, directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'beluga-office-'))
    try {
      const input = join(directory, 'source.' + format)
      await writeFile(input, bytes, { mode: 0o600 })
      return await run(await this.engine(), input, directory)
    } catch (error) {
      if (error instanceof ConversionError) throw new PersonalChatError('office-render', 'The Office engine could not process this file: ' + error.code)
      throw error
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  /**
   * Show a saved file as page images: a document's first pages, or the start of one worksheet.
   * @param sheet - the worksheet to show; defaults to the first visible one.
   * @param limit - bound on the inflated package.
   */
  async preview(bytes: Uint8Array, name: string, sheet: string | undefined, limit: number, signal: AbortSignal): Promise<OfficePreview> {
    const format = officeFormat(name)
    if (!format) throw new PersonalChatError('attachment-format', 'Only DOCX, XLSX and PPTX files have a preview')
    const selection = format === 'xlsx' ? sheetSelection(bytes, sheet, limit, signal) : undefined
    return this.inFiles(bytes, format, async (engine, inputPath, directory) => {
      const request: RenderImagesRequest = { inputPath, outputDir: join(directory, 'pages'), dpi: PREVIEW_DPI, maxPages: PREVIEW_PAGES, ...(selection && { sheet: selection.sheet, range: selection.range }) }
      const result = await engine.renderImages(request, signal).catch((error: unknown) => {
        // The page count is only known after a render, and pages past the end are an error.
        if (selection || !(error instanceof ConversionError) || error.code !== 'output-too-large') throw error
        return engine.renderImages({ ...request, pages: Array.from({ length: PREVIEW_PAGES }, (_, index) => index + 1) }, signal)
      })
      return { pages: await pageImages(result), pageCount: selection ? result.images.length : result.pageCount, missingFonts: result.missingFonts, ...selection }
    })
  }
  /** Open a file as a reader would. The page count exists only once it is laid out. */
  async check(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<DocumentCheck> {
    const format = officeFormat(name)
    if (!format) throw new PersonalChatError('attachment-format', 'Only DOCX, XLSX and PPTX files can be checked')
    try {
      return await this.inFiles(bytes, format, async (engine, inputPath, directory) => {
        const { pageCount, missingFonts } = await engine.renderImages({ inputPath, outputDir: join(directory, 'pages'), pages: [1], dpi: CHECK_DPI }, signal)
        return { opened: true, pages: pageCount, missingFonts }
      })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof PersonalChatError && error.reason === 'office-render') return { opened: false, reason: error.message }
      throw error
    }
  }
  /** @returns the file as a complete PDF. */
  async pdf(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<Uint8Array> {
    const format = officeFormat(name)
    if (!format) throw new PersonalChatError('attachment-format', 'Only DOCX, XLSX and PPTX files can be exported to PDF')
    return this.inFiles(bytes, format, async (engine, inputPath, directory) => {
      const outputPath = join(directory, 'output.pdf')
      await engine.render({ inputPath, outputPath }, signal)
      return readFile(outputPath)
    })
  }
  /** @returns the workbook as LibreOffice saves it after calculating every formula. Read its values; do not hand it over. */
  async recalculate(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return this.inFiles(bytes, 'xlsx', async (engine, inputPath, directory) => {
      const outputPath = join(directory, 'output.xlsx')
      await engine.recalculate({ inputPath, outputPath }, signal)
      return readFile(outputPath)
    })
  }
}
function sheetSelection(bytes: Uint8Array, name: string | undefined, limit: number, signal: AbortSignal) {
  const book = openBook(OfficePackage.open(bytes, limit, signal))
  const chosen = findSheet(book, name)
  const { extent } = outlineSheet(book, chosen)
  const last = { row: Math.min(extent.row, PREVIEW_ROWS), column: Math.min(extent.column, PREVIEW_COLUMNS) }
  return {
    sheet: chosen.name, range: 'A1:' + cellRef(last), sheets: book.sheets.filter(sheet => sheet.state === 'visible').map(sheet => sheet.name),
    ...(last.row < extent.row || last.column < extent.column ? { clipped: true } : {}),
  }
}
async function pageImages(result: RenderImagesResult): Promise<OfficePreview['pages']> {
  return Promise.all(result.images.map(async image => ({ width: image.width, height: image.height, base64: (await readFile(image.path)).toString('base64') })))
}
