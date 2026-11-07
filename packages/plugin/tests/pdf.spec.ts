import { describe, expect, it } from 'vitest'
import { extractPdfText } from '../src/host/pdf.ts'
import { pdf } from './fixtures/pdf.ts'
describe('PDF attachment extraction', () => {
  it('extracts text from bytes without a filesystem path', async () => {
    const result = await extractPdfText(pdf('PDF_ATTACHMENT_SENTINEL'), 'paper.pdf', 24000, 10, new AbortController().signal)
    expect(result).toMatchObject({ status: 'text', pages: 1, pagesRead: 1, truncated: false })
    expect(result.text).toContain('PDF_ATTACHMENT_SENTINEL')
  })
  it('reports textless scanned documents and malformed inputs explicitly', async () => {
    expect(await extractPdfText(pdf(''), 'scan.pdf', 24000, 10, new AbortController().signal)).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('OCR') })
    expect(await extractPdfText(Buffer.from('not a PDF'), 'bad.pdf', 24000, 10, new AbortController().signal)).toMatchObject({ status: 'unsupported' })
  })
  it('respects cancellation and configured page limits', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(extractPdfText(pdf('text'), 'paper.pdf', 24000, 10, controller.signal)).rejects.toThrow()
    await expect(extractPdfText(pdf('text'), 'paper.pdf', 24000, 0, new AbortController().signal)).rejects.toThrow('maxPdfPages')
  })
})
