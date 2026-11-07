import type { AttachmentText } from '../shared/types.ts'
import { PersonalChatError } from './archive.ts'

/** Extract only text from attachment bytes; never enable PDF scripting or resource URLs. */
export async function extractPdfText(data: Uint8Array, name: string, maxBytes: number, maxPages: number, signal: AbortSignal): Promise<AttachmentText> {
  signal.throwIfAborted()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(data), enableXfa: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 0 })
  let destruction: Promise<void> | undefined
  const destroy = () => destruction ??= task.destroy()
  const onAbort = () => { void destroy().catch(() => { /* The awaited finally reports destruction failure. */ }) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const pdf = await task.promise
    if (pdf.numPages > maxPages) throw new PersonalChatError('pdf-page-limit', 'PDF exceeds maxPdfPages; split it into smaller documents')
    let text = ''
    let pagesRead = 0
    let truncated = false
    outer: for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal.throwIfAborted()
      const page = await pdf.getPage(pageNumber)
      const reader = page.streamTextContent().getReader()
      try {
        text += `\n[Page ${pageNumber}]\n`
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          signal.throwIfAborted()
          for (const item of chunk.value.items) {
            if (!('str' in item)) continue
            const addition = item.str + (item.hasEOL ? '\n' : ' ')
            if (Buffer.byteLength(JSON.stringify({ name, status: 'text', text: text + addition, truncated: true, pages: pdf.numPages, pagesRead: pageNumber })) > maxBytes) {
              truncated = true
              pagesRead = pageNumber
              break outer
            }
            text += addition
          }
        }
        pagesRead = pageNumber
      } finally { await reader.cancel(); page.cleanup() }
    }
    if (!text.replace(/\[Page \d+\]/gu, '').trim() && !truncated) return { name, status: 'unsupported', text: '', truncated: false, pages: pdf.numPages, pagesRead, reason: 'This PDF has no extractable text. Scanned pages need OCR, which is not available here.' }
    return { name, status: 'text', text, truncated, pages: pdf.numPages, pagesRead }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PersonalChatError) throw error
    return { name, status: 'unsupported', text: '', truncated: false, reason: 'PDF text could not be extracted. The file may be encrypted, damaged, or use unsupported text encoding.' }
  } finally { signal.removeEventListener('abort', onAbort); await destroy() }
}
