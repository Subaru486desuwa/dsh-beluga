import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ChatAttachment, ConversationId, AttachmentText, OfficePreview } from '../shared/types.ts'
import { PersonalChatError } from './archive.ts'
import { extractPdfText } from './pdf.ts'
import { convertedOfficeName, legacyOfficeFormat, legacyOfficeMediaTypes, officeFormat, officeMediaTypes, officeReadFormat, type OfficeEngine } from './office-contract.ts'
import type { Config } from './config.ts'
import type { InlineImage } from './model-bridge.ts'
import type { SlideImage } from './presentations.ts'

/** Binary files are owned by plugin conversation ids, never arbitrary host paths. */
export class AssetRepository {
  private readonly memory = new Map<string, Uint8Array>()
  constructor(private readonly directory: string, private readonly config: Config, private readonly office: () => OfficeEngine | undefined = () => undefined) {}
  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }) }
  /** @param update - `id` already holds a file, which the data replaces in one step. */
  async save(id: string, conversationId: ConversationId, temporary: boolean, rawName: string, data: Uint8Array, update = false): Promise<ChatAttachment> {
    if (!data.length || data.length > this.config.maxAttachmentBytes) throw new PersonalChatError('attachment-limit', 'File size is outside the configured upload limit')
    const name = rawName.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f]/gu, '').slice(0, 200) || 'attachment'
    let mediaType = /\.pdf$/iu.test(name) ? 'application/pdf' : 'application/octet-stream'
    const format = officeFormat(name)
    if (format) mediaType = officeMediaTypes[format]!
    const legacy = legacyOfficeFormat(name)
    if (legacy) mediaType = legacyOfficeMediaTypes[legacy]!
    let image = false
    if (/\.(png|jpe?g|webp|gif)$/iu.test(name)) {
      try {
        const metadata = await sharp(data, { limitInputPixels: 16_777_216, animated: false }).metadata()
        const formats: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
        const detected = metadata.format && formats[metadata.format]
        if (!detected) throw new Error('unsupported image')
        await sharp(data, { limitInputPixels: 16_777_216, animated: false }).stats()
        mediaType = detected
        image = true
      } catch { throw new PersonalChatError('invalid-image', 'Image decoding failed or the image exceeds 16 megapixels') }
    }
    if (temporary) this.memory.set(id, data)
    else if (update) {
      const draft = this.path(id) + '.new'
      await writeFile(draft, data, { mode: 0o600 })
      await rename(draft, this.path(id))
    } else await writeFile(this.path(id), data, { flag: 'wx', mode: 0o600 })
    return { id, conversationId, name, mediaType, bytes: data.length, image }
  }
  private path(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(id)) throw new PersonalChatError('attachment-forbidden', 'Invalid attachment identifier')
    return join(this.directory, id + '.bin')
  }
  async read(attachment: ChatAttachment, temporary: boolean): Promise<Uint8Array> {
    const data = temporary ? this.memory.get(attachment.id) : await readFile(this.path(attachment.id))
    if (!data || data.length !== attachment.bytes) throw new PersonalChatError('attachment-unavailable', 'The attachment is unavailable or incomplete')
    return data
  }
  async remove(attachment: ChatAttachment, temporary: boolean): Promise<void> {
    if (temporary) this.memory.delete(attachment.id)
    else await rm(this.path(attachment.id), { force: true })
  }
  clearTemporary(): void { this.memory.clear() }
  async image(attachment: ChatAttachment, temporary: boolean, signal: AbortSignal): Promise<InlineImage> {
    signal.throwIfAborted()
    const source = await this.read(attachment, temporary)
    const data = await sharp(source, { limitInputPixels: 16_777_216, animated: false }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).removeAlpha().toColourspace('srgb').jpeg({ quality: 90 }).toBuffer()
    signal.throwIfAborted()
    return { mediaType: 'image/jpeg', base64: data.toString('base64') }
  }
  /** A PNG or JPEG as a slide shows it: turned upright, at most 2400 pixels a side, in its own format so transparency stays. */
  async picture(attachment: ChatAttachment, temporary: boolean, signal: AbortSignal): Promise<SlideImage> {
    signal.throwIfAborted()
    const source = await this.read(attachment, temporary)
    const png = attachment.mediaType === 'image/png'
    const image = sharp(source, { limitInputPixels: 16_777_216, animated: false }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    const { data, info } = await (png ? image.png() : image.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true })
    signal.throwIfAborted()
    return { data: new Uint8Array(data), mediaType: png ? 'image/png' : 'image/jpeg', width: info.width, height: info.height }
  }
  /** The engine for a saved Office file. Temporary Chat stays in memory, and rendering needs files on disk. */
  private renderer(attachment: ChatAttachment, temporary: boolean): OfficeEngine {
    if (temporary) throw new PersonalChatError('temporary-operation', 'Temporary Chat keeps files in memory, so it has no preview or PDF export')
    const office = this.office()
    if (!office) throw new PersonalChatError('office-not-installed', 'Install and enable the optional Office extension explicitly first')
    if (!officeReadFormat(attachment.name)) throw new PersonalChatError('attachment-format', 'Only Word, Excel and PowerPoint files can be rendered')
    return office
  }
  /**
   * An Office file as the engine's readers take it. An Office 97–2003 file is converted to its current format and named for it; the upload itself stays as it is.
   * @throws PersonalChatError for an Office 97–2003 file in Temporary Chat, which keeps files away from the engine.
   */
  async officeSource(attachment: ChatAttachment, temporary: boolean, signal: AbortSignal): Promise<{ readonly name: string; readonly bytes: Uint8Array }> {
    const bytes = await this.read(attachment, temporary)
    if (!legacyOfficeFormat(attachment.name)) return { name: attachment.name, bytes }
    if (temporary) throw new PersonalChatError('temporary-operation', legacyInTemporary(attachment.name))
    const office = this.office()
    if (!office) throw new PersonalChatError('office-not-installed', 'Install and enable the optional Office extension explicitly first')
    return { name: convertedOfficeName(attachment.name), bytes: await office.convertLegacy(bytes, attachment.name, signal) }
  }
  async preview(attachment: ChatAttachment, temporary: boolean, sheet: string | undefined, signal: AbortSignal): Promise<OfficePreview> {
    const office = this.renderer(attachment, temporary)
    const source = await this.officeSource(attachment, false, signal)
    return office.previewFile(source.bytes, source.name, sheet, this.config.maxAttachmentBytes, signal)
  }
  async pdf(attachment: ChatAttachment, temporary: boolean, signal: AbortSignal): Promise<Uint8Array> {
    const office = this.renderer(attachment, temporary)
    const source = await this.officeSource(attachment, false, signal)
    const pdf = await office.exportPdf(source.bytes, source.name, signal)
    if (pdf.length > this.config.maxAttachmentBytes) throw new PersonalChatError('attachment-limit', 'The exported PDF exceeds the file limit')
    return pdf
  }
  async text(attachment: ChatAttachment, temporary: boolean, offset: number, signal: AbortSignal): Promise<AttachmentText & { nextOffset?: number; totalCharacters: number }> {
    signal.throwIfAborted()
    if (attachment.image) return { name: attachment.name, status: 'unsupported', text: '', truncated: false, totalCharacters: 0, reason: 'Select an inline-image model to understand this image.' }
    let extracted: AttachmentText
    if (/\.pdf$/iu.test(attachment.name)) extracted = await extractPdfText(await this.read(attachment, temporary), attachment.name, this.config.maxAttachmentBytes, this.config.maxPdfPages, signal)
    else if (officeReadFormat(attachment.name)) {
      const office = this.office()
      if (!office) extracted = { name: attachment.name, status: 'unsupported', text: '', truncated: false, reason: 'Office extension is not installed or enabled. Ask the user to install dsh-beluga-office explicitly; never install it automatically.' }
      else if (temporary && legacyOfficeFormat(attachment.name)) extracted = { name: attachment.name, status: 'unsupported', text: '', truncated: false, reason: legacyInTemporary(attachment.name) }
      else {
        const source = await this.officeSource(attachment, temporary, signal)
        extracted = { ...office.extractText(source.bytes, source.name, this.config.maxAttachmentBytes, signal), name: attachment.name }
      }
    }
    else {
      const bytes = await this.read(attachment, temporary)
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        extracted = text.includes('\0') ? { name: attachment.name, status: 'unsupported', text: '', truncated: false, reason: 'This binary document needs conversion to PDF or UTF-8 text.' } : { name: attachment.name, status: 'text', text, truncated: false }
      } catch { extracted = { name: attachment.name, status: 'unsupported', text: '', truncated: false, reason: 'This document is not valid UTF-8 text. Convert Office documents to PDF first.' } }
    }
    const totalCharacters = extracted.text.length
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalCharacters) throw new PersonalChatError('attachment-offset', 'Use zero or a nextOffset returned by the previous read')
    let end = Math.min(totalCharacters, offset + this.config.maxAttachmentTextBytes)
    const result = () => ({ ...extracted, text: extracted.text.slice(offset, end), truncated: extracted.truncated || end < totalCharacters, totalCharacters, ...(end < totalCharacters ? { nextOffset: end } : {}) })
    while (Buffer.byteLength(JSON.stringify(result())) > this.config.maxAttachmentTextBytes && end > offset) end = offset + Math.floor((end - offset) * 0.8)
    if (end > offset && /[\uD800-\uDBFF]/u.test(extracted.text[end - 1]!)) end--
    if (end === offset && offset < totalCharacters) throw new PersonalChatError('attachment-limit', 'Attachment metadata exceeds the output budget')
    return result()
  }
}
/** Converting an Office 97–2003 file needs the engine, which works on files on disk. */
function legacyInTemporary(name: string): string {
  return 'Temporary Chat keeps files in memory, so this Office 97–2003 file cannot be converted for reading. Ask the user to save it as ' + officeReadFormat(name)!.toUpperCase() + ' and attach it again, or to use a regular chat.'
}
