import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ChatAttachment, ConversationId, AttachmentText } from '../shared/types.ts'
import { PersonalChatError } from './archive.ts'
import { extractPdfText } from './pdf.ts'
import { officeFormat, officeMediaTypes, type OfficeEngine } from './office-contract.ts'
import type { Config } from './config.ts'
import type { InlineImage } from './model-bridge.ts'

/** Binary files are owned by plugin conversation ids, never arbitrary host paths. */
export class AssetRepository {
  private readonly memory = new Map<string, Uint8Array>()
  constructor(private readonly directory: string, private readonly config: Config, private readonly office: () => OfficeEngine | undefined = () => undefined) {}
  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }) }
  async save(id: string, conversationId: ConversationId, temporary: boolean, rawName: string, data: Uint8Array): Promise<ChatAttachment> {
    if (!data.length || data.length > this.config.maxAttachmentBytes) throw new PersonalChatError('attachment-limit', 'File size is outside the configured upload limit')
    const name = rawName.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f]/gu, '').slice(0, 200) || 'attachment'
    let mediaType = /\.pdf$/iu.test(name) ? 'application/pdf' : 'application/octet-stream'
    const format = officeFormat(name)
    if (format) mediaType = officeMediaTypes[format]!
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
    else await writeFile(this.path(id), data, { flag: 'wx', mode: 0o600 })
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
  async text(attachment: ChatAttachment, temporary: boolean, offset: number, signal: AbortSignal): Promise<AttachmentText & { nextOffset?: number; totalCharacters: number }> {
    signal.throwIfAborted()
    if (attachment.image) return { name: attachment.name, status: 'unsupported', text: '', truncated: false, totalCharacters: 0, reason: 'Select an inline-image model to understand this image.' }
    const bytes = await this.read(attachment, temporary)
    let extracted: AttachmentText
    if (/\.pdf$/iu.test(attachment.name)) extracted = await extractPdfText(bytes, attachment.name, this.config.maxAttachmentBytes, this.config.maxPdfPages, signal)
    else if (officeFormat(attachment.name)) {
      const office = this.office()
      extracted = office ? office.extractText(bytes, attachment.name, this.config.maxAttachmentBytes, signal)
        : { name: attachment.name, status: 'unsupported', text: '', truncated: false, reason: 'Office extension is not installed or enabled. Ask the user to install dsh-beluga-office explicitly; never install it automatically.' }
    }
    else {
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
