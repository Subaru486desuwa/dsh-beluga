import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssetRepository } from '../src/host/assets.ts'
import { Config } from '../src/host/config.ts'
import type { ConversationId } from '../src/shared/types.ts'
const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
describe('owned image assets', () => {
  it('validates and normalizes temporary images without writing their bytes', async () => {
    const path = await mkdtemp(join(tmpdir(), 'personal-chat-images-')); paths.push(path)
    const repository = new AssetRepository(path, Config({ dataDir: path }))
    await repository.initialize()
    const data = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#224488' } }).png().toBuffer()
    const attachment = await repository.save(randomUUID(), brandString<ConversationId>(randomUUID()), true, 'sample.png', data)
    expect(attachment.image).toBe(true)
    const inline = await repository.image(attachment, true, new AbortController().signal)
    expect(await sharp(Buffer.from(inline.base64, 'base64')).metadata()).toMatchObject({ format: 'jpeg', width: 4, height: 3 })
    expect(await repository.read(attachment, true)).toEqual(data)
    expect(await readdir(path)).toEqual([])
    await expect(repository.save(randomUUID(), attachment.conversationId, true, 'fake.png', Buffer.from('not an image'))).rejects.toThrow('Image decoding failed')
    repository.clearTemporary()
    await expect(repository.read(attachment, true)).rejects.toThrow('unavailable')
  })
})

it('base-only Office upload is retained but never parsed or implicitly installed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'personal-chat-base-office-')); paths.push(path)
  const repository = new AssetRepository(path, Config({ dataDir: path }))
  await repository.initialize()
  const bytes = Buffer.from('Do not treat this Office content as plain text')
  const file = await repository.save(randomUUID(), brandString<ConversationId>(randomUUID()), true, 'report.docx', bytes)
  const result = await repository.text(file, true, 0, new AbortController().signal)
  expect(result.status).toBe('unsupported')
  expect(result.text).toBe('')
  expect(result.reason).toContain('not installed')
  expect(await repository.read(file, true)).toEqual(bytes)
  expect(await readdir(path)).toEqual([])
})
