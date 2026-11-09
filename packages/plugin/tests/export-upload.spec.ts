import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { exportUpload } from '../src/client/export-upload.ts'
import { parseExport } from '../src/host/archive.ts'
import { currentExport } from './fixtures/chatgpt.ts'

const limits = { uploadBytes: 100000, archiveBytes: 100000, zipEntries: 10 }
const hostLimits = { maxUploadBytes: 100000, maxArchiveBytes: 100000, maxConversations: 10, maxNodes: 100, maxZipEntries: 10 }
const shard = (id: string) => strToU8(JSON.stringify([{ ...currentExport[0]!, id }]))
const upload = (data: Uint8Array<ArrayBuffer>, name = 'export.zip', overrides: Partial<typeof limits> = {}) => exportUpload(new File([data], name), { ...limits, ...overrides })
const sourceIds = (zip: Uint8Array) => parseExport(zip, 'export.zip', hostLimits).map(archive => archive.sourceId)
/** One stored member whose sizes and offset are only readable from Zip64 records. */
function zip64Archive(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  const put = (size: number, value: number | bigint) => { let rest = BigInt(value); for (let index = 0; index < size; index++) { out.push(Number(rest & 255n)); rest >>= 8n } }
  const bytes = (value: Uint8Array) => { for (const byte of value) out.push(byte) }
  const encoded = strToU8(name)
  const saturated = 0xffffffff
  put(4, 0x04034b50); put(2, 45); put(2, 0); put(2, 0); put(4, 0); put(4, 0); put(4, data.length); put(4, data.length); put(2, encoded.length); put(2, 0)
  bytes(encoded); bytes(data)
  const directory = out.length
  put(4, 0x02014b50); put(2, 45); put(2, 45); put(2, 0); put(2, 0); put(4, 0); put(4, 0); put(4, saturated); put(4, saturated); put(2, encoded.length); put(2, 28); put(2, 0); put(2, 0); put(2, 0); put(4, 0); put(4, saturated)
  bytes(encoded)
  put(2, 1); put(2, 24); put(8, data.length); put(8, data.length); put(8, 0)
  const record = out.length
  const directorySize = record - directory
  put(4, 0x06064b50); put(8, 44); put(2, 45); put(2, 45); put(4, 0); put(4, 0); put(8, 1); put(8, 1); put(8, directorySize); put(8, directory)
  put(4, 0x07064b50); put(4, 0); put(8, record); put(4, 1)
  put(4, 0x06054b50); put(2, 0); put(2, 0); put(2, 0xffff); put(2, 0xffff); put(4, saturated); put(4, saturated); put(2, 0)
  return Uint8Array.from(out)
}

describe('preparing an export for upload', () => {
  it('sends only conversation members, however large the ZIP is', async () => {
    const zip = zipSync({ 'conversations-001.json': shard('second'), 'file-media.dat': [new Uint8Array(300000).fill(7), { level: 0 }], 'chat.html': strToU8('<html></html>'), 'conversations-000.json': shard('first') })
    expect(zip.length).toBeGreaterThan(limits.uploadBytes)
    const slim = await upload(zip)
    expect(Object.keys(unzipSync(slim)).sort()).toEqual(['conversations-000.json', 'conversations-001.json'])
    expect(sourceIds(slim)).toEqual(['first', 'second'])
  })
  it('reads stored and deflated members alike, and nested paths by base name', async () => {
    const zip = zipSync({ 'export/conversations-000.json': [shard('stored'), { level: 0 }], 'export/conversations-001.json': [shard('deflated'), { level: 9 }] })
    expect(sourceIds(await upload(zip))).toEqual(['stored', 'deflated'])
  })
  it('keeps a lone conversations.json working', async () => {
    expect(sourceIds(await upload(zipSync({ 'conversations.json': shard('single') })))).toEqual(['single'])
  })
  it('reads sizes and offsets from Zip64 records', async () => {
    expect(sourceIds(await upload(zip64Archive('conversations-000.json', shard('zip64'))))).toEqual(['zip64'])
  })
  it('finds the directory behind an archive comment that looks like one', async () => {
    const zip = zipSync({ 'conversations.json': shard('commented') })
    const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3])
    const commented = new Uint8Array(zip.length + comment.length)
    commented.set(zip); commented.set(comment, zip.length)
    new DataView(commented.buffer).setUint16(zip.length - 2, comment.length, true)
    expect(sourceIds(await upload(commented))).toEqual(['commented'])
  })
  it('passes a JSON file through unchanged, within the upload limit', async () => {
    const data = shard('json')
    expect(await upload(data, 'conversations-000.json')).toEqual(data)
    await expect(upload(data, 'conversations-000.json', { uploadBytes: 10 })).rejects.toThrow('upload size limit')
  })
  it('refuses what the Host would refuse, before uploading anything', async () => {
    const shards = zipSync({ 'conversations-000.json': shard('a'), 'conversations-002.json': shard('c') })
    await expect(upload(shards)).rejects.toThrow('missing conversations-001.json')
    await expect(upload(zipSync({ 'file-media.dat': new Uint8Array(10) }))).rejects.toThrow('requires conversations.json')
    await expect(upload(zipSync({ '../conversations.json': shard('a') }))).rejects.toThrow('Unsafe ZIP')
    await expect(upload(zipSync({ 'conversations.json': shard('a') }), 'export.zip', { zipEntries: 0 })).rejects.toThrow('maxZipEntries')
    await expect(upload(zipSync({ 'conversations.json': shard('a') }), 'export.zip', { archiveBytes: 10 })).rejects.toThrow('maxArchiveBytes')
    await expect(upload(zipSync({ 'conversations.json': shard('a') }), 'export.zip', { uploadBytes: 10 })).rejects.toThrow('upload size limit')
    await expect(upload(strToU8('not a zip'))).rejects.toThrow('not a ZIP')
  })
  it('refuses a member that does not match its directory entry', async () => {
    const zip = zipSync({ 'conversations.json': shard('a') })
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const directory = view.getUint32(zip.length - 6, true)
    view.setUint32(directory + 24, view.getUint32(directory + 24, true) + 1, true)
    await expect(upload(zip as Uint8Array<ArrayBuffer>)).rejects.toThrow('corrupted')
  })
  it('asks for limits rather than guessing them', async () => {
    await expect(exportUpload(new File([shard('a')], 'a.json'), undefined)).rejects.toThrow('limits')
  })
})
