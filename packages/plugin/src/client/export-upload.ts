/**
 * Reduce an official export to the conversation JSON the Host reads. Exports routinely
 * run to gigabytes of media, so the ZIP is read by byte range from its central directory:
 * streaming it through fflate's Unzip would hold every skipped entry in memory.
 */
import { inflateSync, zipSync } from 'fflate'
import { isConversationMember, isZipName, orderConversationMembers, zipMemberName } from '../shared/export-members.ts'
import type { UploadLimits } from '../shared/types.ts'

const END_OF_DIRECTORY = 0x06054b50
const ZIP64_END_OF_DIRECTORY = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_ENTRY = 0x04034b50
const END_BYTES = 22
const ENTRY_BYTES = 46
const LOCAL_BYTES = 30
const MAX_COMMENT_BYTES = 0xffff
const MAX_ENTRIES = 0xffff
const MAX_32_BITS = 0xffffffff
const ZIP64_EXTRA = 1
const STORED = 0
const DEFLATED = 8
/** Re-compression runs on the page; beyond this level it costs twice the time to save one MiB in ten. */
const SLIM_LEVEL = 1

type ExportLimits = Pick<UploadLimits, 'uploadBytes' | 'archiveBytes' | 'zipEntries'>
interface ZipRange { readonly start: number; readonly end: number; readonly count: number }
interface MemberLocation { readonly compressedSize: number; readonly size: number; readonly offset: number }
interface ZipMember extends MemberLocation { readonly name: string; readonly method: number }

function fail(message: string): never { throw new Error(message) }
async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> { return new Uint8Array(await file.slice(start, end).arrayBuffer()) }
function viewOf(bytes: Uint8Array<ArrayBuffer>): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }

/** @returns where the central directory lies, from the classic record or its Zip64 successor. */
async function directoryRange(file: Blob): Promise<ZipRange> {
  const tail = viewOf(await bytesAt(file, Math.max(0, file.size - END_BYTES - MAX_COMMENT_BYTES), file.size))
  let end = tail.byteLength - END_BYTES
  while (end >= 0 && !(tail.getUint32(end, true) === END_OF_DIRECTORY && end + END_BYTES + tail.getUint16(end + 20, true) === tail.byteLength)) end--
  if (end < 0) fail('The selected file is not a ZIP archive')
  const count = tail.getUint16(end + 10, true)
  const size = tail.getUint32(end + 12, true)
  const start = tail.getUint32(end + 16, true)
  if (count !== MAX_ENTRIES && size !== MAX_32_BITS && start !== MAX_32_BITS) return { start, end: start + size, count }
  const locator = end - 20
  if (locator < 0 || tail.getUint32(locator, true) !== ZIP64_LOCATOR) fail('ZIP64 locator is missing')
  const recordAt = Number(tail.getBigUint64(locator + 8, true))
  const record = viewOf(await bytesAt(file, recordAt, recordAt + 56))
  if (record.byteLength < 56 || record.getUint32(0, true) !== ZIP64_END_OF_DIRECTORY) fail('ZIP64 directory record is malformed')
  const zip64Start = Number(record.getBigUint64(48, true))
  return { start: zip64Start, end: zip64Start + Number(record.getBigUint64(40, true)), count: Number(record.getBigUint64(32, true)) }
}

/** Saturated 32-bit fields continue in the Zip64 extra field, in the order the format fixes. */
function memberLocation(directory: DataView, entry: number, extra: number, extraBytes: number): MemberLocation {
  let compressedSize = directory.getUint32(entry + 20, true)
  let size = directory.getUint32(entry + 24, true)
  let offset = directory.getUint32(entry + 42, true)
  for (let field = extra; field + 4 <= extra + extraBytes; field += 4 + directory.getUint16(field + 2, true)) {
    if (directory.getUint16(field, true) !== ZIP64_EXTRA) continue
    let value = field + 4
    const next = () => { const result = Number(directory.getBigUint64(value, true)); value += 8; return result }
    if (size === MAX_32_BITS) size = next()
    if (compressedSize === MAX_32_BITS) compressedSize = next()
    if (offset === MAX_32_BITS) offset = next()
  }
  return { compressedSize, size, offset }
}

async function conversationMembers(file: Blob, maxEntries: number): Promise<ZipMember[]> {
  const { start, end, count } = await directoryRange(file)
  if (count > maxEntries) fail('ZIP exceeds maxZipEntries')
  if (end > file.size) fail('ZIP directory is truncated')
  const bytes = await bytesAt(file, start, end)
  const directory = viewOf(bytes)
  const names = new TextDecoder()
  const members: ZipMember[] = []
  let entry = 0
  for (let index = 0; index < count; index++) {
    if (entry + ENTRY_BYTES > bytes.length || directory.getUint32(entry, true) !== DIRECTORY_ENTRY) fail('ZIP directory is malformed')
    const nameBytes = directory.getUint16(entry + 28, true)
    const extraBytes = directory.getUint16(entry + 30, true)
    const commentBytes = directory.getUint16(entry + 32, true)
    const extra = entry + ENTRY_BYTES + nameBytes
    const name = zipMemberName(names.decode(bytes.subarray(entry + ENTRY_BYTES, extra)), fail)
    if (isConversationMember(name)) members.push({ name, method: directory.getUint16(entry + 10, true), ...memberLocation(directory, entry, extra, extraBytes) })
    entry = extra + extraBytes + commentBytes
  }
  return members
}

async function memberData(file: Blob, member: ZipMember): Promise<Uint8Array<ArrayBuffer>> {
  const header = await bytesAt(file, member.offset, member.offset + LOCAL_BYTES)
  const local = viewOf(header)
  if (header.length < LOCAL_BYTES || local.getUint32(0, true) !== LOCAL_ENTRY) fail(`ZIP member ${member.name} is malformed`)
  const start = member.offset + LOCAL_BYTES + local.getUint16(26, true) + local.getUint16(28, true)
  const compressed = await bytesAt(file, start, start + member.compressedSize)
  if (compressed.length !== member.compressedSize) fail(`ZIP member ${member.name} is truncated`)
  if (member.method !== STORED && member.method !== DEFLATED) fail(`ZIP member ${member.name} uses unsupported compression`)
  const data = member.method === STORED ? compressed : inflateSync(compressed, { out: new Uint8Array(member.size) }) as Uint8Array<ArrayBuffer>
  if (data.length !== member.size) fail(`ZIP member ${member.name} is corrupted`)
  return data
}

/**
 * Choose the bytes to send for one selected export. Media stays on this device, and the
 * Host still receives an ordinary ZIP or JSON that it validates in full.
 * @param file - the export the user selected.
 * @param limits - the Host's published limits, once loaded.
 * @returns the bytes to upload.
 */
export async function exportUpload(file: File, limits: ExportLimits | undefined): Promise<Uint8Array> {
  if (!limits) fail('Upload limits are not available yet')
  if (!isZipName(file.name)) {
    if (file.size > limits.uploadBytes) fail('File exceeds the upload size limit')
    return new Uint8Array(await file.arrayBuffer())
  }
  const members = orderConversationMembers(await conversationMembers(file, limits.zipEntries), fail)
  if (members.reduce((sum, member) => sum + member.size, 0) > limits.archiveBytes) fail('Conversation JSON exceeds maxArchiveBytes: ' + limits.archiveBytes)
  const files: Record<string, Uint8Array> = {}
  for (const member of members) files[member.name] = await memberData(file, member)
  const slim = zipSync(files, { level: SLIM_LEVEL })
  if (slim.length > limits.uploadBytes) fail('Conversation data exceeds the upload size limit')
  return slim
}
