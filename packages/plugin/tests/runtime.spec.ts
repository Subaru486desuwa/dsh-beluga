import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import PersonalChatService from '../lib/index.js'
import OfficeExtension from '../../office/lib/index.js'
import { PersonalStore } from '../src/host/storage.ts'
import type { ConversationRecord } from '../src/host/records.ts'
import type { ConversationDetail, ConversationId } from '../src/shared/types.ts'
import { fixture } from './fixtures/chatgpt.ts'
import { pdf } from './fixtures/pdf.ts'

const route = { provider: 'fixture', model: 'echo' }
class ScriptedModel extends LlmAdapter {
  readonly requests: { sessionId: unknown; system?: string; messages: unknown; tools: readonly string[] }[] = []
  nextTool?: { name: string; arguments: object }
  catalogCalls = 0
  providerInfo(provider: string) { return { id: provider, name: 'Local fixture' } }
  async listModels(provider: string) { this.catalogCalls++; return [{ provider, id: 'echo', name: 'Scripted echo', inputModalities: ['text' as const] }] }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sessionId: options.sessionId, system: options.system, messages: structuredClone(options.messages), tools: options.tools?.map(tool => tool.name) ?? [] })
    const last = options.messages.at(-1)!
    const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (last.role === 'tool') {
      yield { type: 'text-delta', index: 0, text: 'Tool completed.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (text.startsWith('WAIT')) {
      yield { type: 'text-delta', index: 0, text: 'Partial answer' }
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped fixture stream' } } }
      return
    }
    if (text.startsWith('TRUNCATE')) {
      if (text.includes('tool')) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(randomUUID()), name: 'memory_recall', arguments: '{"query":' } }
      else yield { type: 'text-delta', index: 0, text: 'Cut off mid' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    const tool = this.nextTool ?? (text.startsWith('Remember:') ? { name: 'memory_propose', arguments: { text: 'I prefer concise answers', category: 'preference' } } : undefined)
    this.nextTool = undefined
    if (tool) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(randomUUID()), name: tool.name, arguments: JSON.stringify(tool.arguments) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'Echo: ' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
class BrokenCatalog extends LlmAdapter {
  catalogCalls = 0
  providerInfo(provider: string) { return { id: provider, name: 'Broken fixture' } }
  async listModels(): Promise<never> { this.catalogCalls++; throw new Error('Catalog offline') }
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('Never routed by these tests') }
}
const resources: { ctx: Context; path: string }[] = []
async function setup(path?: string, office = false, config: object = {}) {
  const directory = path ?? await mkdtemp(join(tmpdir(), 'personal-chat-runtime-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedModel()
  ctx.llm.registerAdapter(['fixture'], adapter)
  await ctx.plugin(PersonalChatService, { ...config, dataDir: directory })
  if (office) await ctx.plugin(OfficeExtension)
  resources.push({ ctx, path: directory })
  return { ctx, adapter, service: ctx.personalChat, path: directory }
}
async function send(service: PersonalChatService, detail: ConversationDetail, text: string, extra: object = {}) {
  return service.send({ conversationId: detail.conversation.id, requestId: randomUUID(), branchId: detail.conversation.selectedBranchId, text, model: route, ...extra })
}
async function settled(service: PersonalChatService, id: ConversationId): Promise<ConversationDetail> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    for await (const update of service.followConversation({ conversationId: id }, controller.signal)) {
      if (update.kind === 'failure') throw new Error(update.reason)
      if (update.kind === 'snapshot' && !update.detail.live) return update.detail
    }
    throw new Error('Turn did not settle')
  } finally { clearTimeout(timer); controller.abort() }
}
async function diskText(path: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    text += entry.isDirectory() ? await diskText(file) : (await readFile(file)).toString('utf8')
  }
  return text
}
afterEach(async () => {
  const owned = resources.splice(0).reverse()
  for (const item of owned) await item.ctx.fiber.dispose()
  for (const path of new Set(owned.map(item => item.path))) await rm(path, { recursive: true, force: true })
})

describe('plugin-owned conversations on the real LLM service', () => {
  it('streams without creating a Work Session and survives a plugin restart', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await app.service.updateProfile({ expectedRevision: 0, background: 'PROFILE_SENTINEL', instructions: 'Be concise.', autoSaveLowRisk: true, referenceChats: true })
    await send(app.service, chat, 'hello')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.messages.map(message => message.text)).toEqual(['hello', 'Echo: hello'])
    expect(done.error).toBeUndefined()
    expect(app.adapter.requests.every(request => request.sessionId === undefined)).toBe(true)
    expect(JSON.stringify(app.adapter.requests[0])).toContain('PROFILE_SENTINEL')
    expect(app.adapter.requests[0]?.system).toContain('User-approved personal instructions')
    expect(app.adapter.requests[0]?.system).toContain('Be concise.')
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    expect((await again.service.get({ conversationId: chat.conversation.id })).messages).toEqual(done.messages)
  })

  it('deduplicates a lost send response, refuses changed payloads, and stops a live stream', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const request = { conversationId: chat.conversation.id, requestId: randomUUID(), branchId: chat.conversation.selectedBranchId, text: 'WAIT original', model: route }
    await app.service.send(request)
    const control = new AbortController()
    for await (const event of app.service.followConversation({ conversationId: chat.conversation.id }, control.signal)) {
      if ((event.kind === 'delta' && event.text.includes('Partial')) || (event.kind === 'snapshot' && event.detail.live?.text.includes('Partial'))) break
    }
    control.abort()
    const duplicate = await app.service.send(request)
    expect(duplicate.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await expect(app.service.send({ ...request, text: 'different' })).rejects.toThrow('request id')
    await expect(app.service.send({ ...request, requestId: randomUUID() })).rejects.toThrow('Stop')
    const stopped = await app.service.stop({ conversationId: chat.conversation.id })
    expect(stopped.live).toBeUndefined()
    expect(stopped.error).toBe('stopped')
    expect(stopped.messages.at(-1)?.text).toBe('Partial answer')
    expect(app.adapter.requests).toHaveLength(1)
  })

  it('preserves edited and regenerated branches and truly removes history', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'first wording')
    const first = await settled(app.service, chat.conversation.id)
    const edit = { conversationId: chat.conversation.id, requestId: randomUUID(), branchId: first.conversation.selectedBranchId!, messageId: first.messages[0]!.id, action: 'edit' as const, text: 'edited wording', model: route }
    await app.service.branch(edit)
    const changed = await settled(app.service, chat.conversation.id)
    expect(changed.conversation.branches).toHaveLength(2)
    expect(changed.messages[0]?.text).toBe('edited wording')
    expect((await app.service.branch(edit)).conversation.branches).toHaveLength(2)
    await expect(app.service.branch({ ...edit, text: 'another payload' })).rejects.toThrow('different payload')
    const old = await app.service.selectBranch({ conversationId: chat.conversation.id, branchId: first.conversation.selectedBranchId! })
    expect(old.messages).toEqual(first.messages)
    await app.service.deleteConversation({ conversationId: chat.conversation.id })
    expect(await app.service.list({})).toEqual([])
    await expect(app.service.get({ conversationId: chat.conversation.id })).rejects.toThrow('unavailable')
    expect(await diskText(app.path)).not.toContain('first wording')
  })

  it('keeps temporary text, files and memory access out of durable state', async () => {
    const app = await setup()
    await app.service.updateProfile({ expectedRevision: 0, background: 'PRIVATE_PROFILE_MARKER', instructions: 'PRIVATE_INSTRUCTIONS_MARKER', autoSaveLowRisk: true, referenceChats: true })
    const chat = await app.service.create({ temporary: true })
    const file = await app.service.upload({ conversationId: chat.conversation.id, name: '../../private.txt', base64: Buffer.from('TEMPORARY_FILE_SENTINEL').toString('base64') })
    expect(file.name).toBe('private.txt')
    app.adapter.nextTool = { name: 'read_attachment', arguments: { attachmentId: file.id } }
    await send(app.service, chat, 'TEMPORARY_CHAT_SENTINEL', { attachmentIds: [file.id] })
    const result = await settled(app.service, chat.conversation.id)
    expect(result.messages.some(message => message.text.includes('TEMPORARY_FILE_SENTINEL'))).toBe(true)
    expect(JSON.stringify(app.adapter.requests)).not.toContain('PRIVATE_PROFILE_MARKER')
    expect(JSON.stringify(app.adapter.requests)).not.toContain('PRIVATE_INSTRUCTIONS_MARKER')
    expect(app.adapter.requests.every(request => !request.tools.includes('memory_propose'))).toBe(true)
    await expect(app.service.memoryState({ conversationId: chat.conversation.id })).rejects.toThrow('Temporary')
    await expect(app.service.proposeMemory({ conversationId: chat.conversation.id, text: 'I prefer tea', category: 'preference', source: { kind: 'manual' } })).rejects.toThrow('Temporary')
    expect(await app.service.list({})).toEqual([])
    await app.service.closeTemporary({ conversationId: chat.conversation.id })
    const files = await diskText(app.path)
    expect(files).not.toContain('TEMPORARY_CHAT_SENTINEL')
    expect(files).not.toContain('TEMPORARY_FILE_SENTINEL')
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
  })

  it('grounds automatic memory, reviews sensitive facts, and forgets old evidence', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Remember: I prefer concise answers')
    const done = await settled(app.service, chat.conversation.id)
    let memory = await app.service.memoryState({})
    expect(memory.memories).toHaveLength(1)
    const saved = memory.memories[0]!
    await app.service.forgetMemory({ memoryId: saved.id, expectedRevision: saved.revision })
    memory = await app.service.memoryState({})
    expect(memory.memories).toEqual([])
    const repeated = await app.service.proposeMemory({ conversationId: chat.conversation.id, text: 'I prefer concise answers', category: 'preference', source: { kind: 'chat', conversationId: chat.conversation.id, messageId: done.messages[0]!.id } })
    expect(repeated).toMatchObject({ state: 'pending', reason: 'suppressed' })
    const medical = await app.service.proposeMemory({ text: 'I have HIV', category: 'fact', source: { kind: 'manual' } })
    expect(medical).toMatchObject({ state: 'pending', reason: 'sensitive' })
    expect((await app.service.memoryState({})).memories).toEqual([])
  })

  it('checks attachment ownership and reads an actual PDF without filesystem tools', async () => {
    const app = await setup()
    const first = await app.service.create({ temporary: false })
    const other = await app.service.create({ temporary: false })
    const file = await app.service.upload({ conversationId: first.conversation.id, name: 'paper.pdf', base64: Buffer.from(pdf('PAPER_TEXT_SENTINEL')).toString('base64') })
    await expect(app.service.attachment({ conversationId: other.conversation.id, attachmentId: file.id })).rejects.toThrow('belong')
    app.adapter.nextTool = { name: 'read_attachment', arguments: { attachmentId: file.id } }
    await send(app.service, first, 'Read this paper', { attachmentIds: [file.id] })
    const done = await settled(app.service, first.conversation.id)
    expect(done.messages.find(message => message.role === 'tool')?.text).toContain('PAPER_TEXT_SENTINEL')
    await expect(app.service.removeAttachment({ conversationId: first.conversation.id, attachmentId: file.id })).rejects.toThrow('sent message')
    await app.service.deleteConversation({ conversationId: first.conversation.id })
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect((await app.service.list({})).map(chat => chat.id)).toEqual([other.conversation.id])
  })

  it('preserves imported revisions and continuation context through batch undo', async () => {
    const app = await setup()
    const upload = (value: unknown) => app.service.previewImport({ fileName: 'synthetic.json', base64: Buffer.from(JSON.stringify(value)).toString('base64') })
    const imported = await app.service.commitImport({ previewId: (await upload(fixture)).id })
    const id = imported.conversations[0]!
    expect((await app.service.get({ conversationId: id })).archive?.original).toEqual(fixture[0])
    const duplicate = await app.service.commitImport({ previewId: (await upload(fixture)).id })
    expect(duplicate.batch.skipped).toBe(1)
    await app.service.undoImport({ batchId: duplicate.batch.id })
    expect(await app.service.list({})).toHaveLength(1)
    const changed = structuredClone(fixture)
    changed[0]!.mapping.root.children.push('c')
    Object.assign(changed[0]!.mapping, { c: { id: 'c', parent: 'root', children: [], message: { author: { role: 'user' }, create_time: 50, content: { content_type: 'text', parts: ['NEW_SOURCE_BRANCH'] } } } })
    changed[0]!.current_node = 'c'
    const revised = await app.service.commitImport({ previewId: (await upload(changed)).id })
    expect(revised.conversations).toEqual([id])
    const revisionId = revised.batch.revisionIds[0]!
    await app.service.selectArchive({ conversationId: id, selection: { revisionId, nodeId: 'c' } })
    await app.service.send({ conversationId: id, requestId: randomUUID(), archive: { revisionId, nodeId: 'c' }, text: 'Continue', model: route })
    await settled(app.service, id)
    expect(JSON.stringify(app.adapter.requests.at(-1))).toContain('NEW_SOURCE_BRANCH')
    expect(JSON.stringify(app.adapter.requests.at(-1))).not.toContain('OTHER_BRANCH')
    const undo = await app.service.undoImport({ batchId: revised.batch.id })
    expect(undo.retainedContinuations).toEqual([id])
    expect((await app.service.get({ conversationId: id })).conversation.archiveWithdrawn).toBe(true)
    await app.service.undoImport({ batchId: imported.batch.id })
    expect((await app.service.get({ conversationId: id })).messages.at(-1)?.text).toBe('Echo: Continue')
    await app.service.deleteConversation({ conversationId: id })
    expect(await diskText(app.path)).not.toContain('NEW_SOURCE_BRANCH')
  })
  it('deletes during a live stream without resurrection after restart', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'WAIT DELETE_SENTINEL')
    await app.service.deleteConversation({ conversationId: chat.conversation.id })
    expect(await app.service.list({})).toEqual([])
    await expect(app.service.get({ conversationId: chat.conversation.id })).rejects.toThrow('unavailable')
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    expect(await again.service.list({})).toEqual([])
    expect(await diskText(app.path)).not.toContain('DELETE_SENTINEL')
  })

  it('enforces tool permissions even when a provider invents an unavailable tool', async () => {
    const app = await setup()
    const normal = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'web_fetch', arguments: { url: 'https://example.invalid/' } }
    await send(app.service, normal, 'Do not access web')
    const normalDone = await settled(app.service, normal.conversation.id)
    expect(normalDone.messages.find(message => message.role === 'tool')?.text).toContain('tool-forbidden')
    const temp = await app.service.create({ temporary: true })
    app.adapter.nextTool = { name: 'memory_recall', arguments: { query: '' } }
    await send(app.service, temp, 'Temporary memory probe')
    const tempDone = await settled(app.service, temp.conversation.id)
    expect(tempDone.messages.find(message => message.role === 'tool')?.text).toContain('memory-forbidden')
  })

  it('corrects a memory, rejects stale edits and forgets the full correction family', async () => {
    const app = await setup()
    const proposal = await app.service.proposeMemory({ text: 'Old profile sentence', category: 'fact', source: { kind: 'manual' } })
    await app.service.decideCandidate({ candidateId: proposal.id, expectedRevision: proposal.revision, decision: 'confirm' })
    const original = (await app.service.memoryState({})).memories[0]!
    const revised = await app.service.editMemory({ memoryId: original.id, expectedRevision: original.revision, text: 'New profile sentence' })
    await expect(app.service.editMemory({ memoryId: original.id, expectedRevision: original.revision, text: 'Stale replacement' })).rejects.toThrow('unavailable')
    expect((await app.service.memoryState({})).memories.map(item => item.text)).toEqual(['New profile sentence'])
    await app.service.forgetMemory({ memoryId: revised.id, expectedRevision: revised.revision })
    expect((await app.service.memoryState({})).memories).toEqual([])
    const disk = await diskText(app.path)
    expect(disk).not.toContain('Old profile sentence')
    expect(disk).not.toContain('New profile sentence')
  })

  it('recovers an import interrupted before its commit marker', async () => {
    const app = await setup()
    const preview = await app.service.previewImport({ fileName: 'synthetic.json', base64: Buffer.from(JSON.stringify(fixture)).toString('base64') })
    const imported = await app.service.commitImport({ previewId: preview.id })
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const store = await PersonalStore.open(app.path)
    await store.batches.put(imported.batch.id, { ...imported.batch, state: 'preparing' })
    await store.close()
    const recovered = await setup(app.path)
    expect(await recovered.service.list({})).toEqual([])
    expect(await recovered.service.listImports()).toMatchObject([{ id: imported.batch.id, state: 'withdrawn' }])
    await expect(recovered.service.get({ conversationId: imported.conversations[0]! })).rejects.toThrow('unavailable')
  })

})

describe('Office artifact publication', () => {
  it('publishes immutable editable versions with branch ownership and restart persistence', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const source = { title: '预算报告', blocks: [{ kind: 'heading', level: 1, text: '预算' }, { kind: 'paragraph', text: '230000' }] }
    app.adapter.nextTool = { name: 'create_document', arguments: source }
    await send(app.service, chat, 'Create a report')
    const first = await settled(app.service, chat.conversation.id)
    expect(first.error).toBeUndefined()
    expect(first.attachments, JSON.stringify(first.messages)).toHaveLength(1)
    const original = first.attachments[0]!
    expect(original.artifact).toMatchObject({ version: 1, rootId: original.id })
    expect(first.messages.find(message => message.role === 'tool')?.attachmentIds).toEqual([original.id])
    const originalBytes = await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: original.id, original: true })
    app.adapter.nextTool = { name: 'revise_document', arguments: { attachmentId: original.id, summary: 'Update actuals', changes: [{ index: 1, block: { kind: 'paragraph', text: '235000' } }] } }
    await send(app.service, first, 'Change the second block only')
    const second = await settled(app.service, chat.conversation.id)
    expect(second.attachments).toHaveLength(2)
    expect(second.attachments[1]?.artifact).toMatchObject({ version: 2, parentId: original.id, rootId: original.id })
    expect(await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: original.id, original: true })).toEqual(originalBytes)
    const other = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'inspect_document', arguments: { attachmentId: original.id } }
    await send(app.service, other, 'Read another chat')
    const denied = await settled(app.service, other.conversation.id)
    expect(denied.messages.find(message => message.role === 'tool')?.text).toContain('attachment-forbidden')
    await app.ctx.fiber.dispose()
    const restart = await setup(app.path, true)
    const loaded = await restart.service.get({ conversationId: chat.conversation.id })
    expect(loaded.attachments[1]?.artifact?.version).toBe(2)
    restart.adapter.nextTool = { name: 'inspect_document', arguments: { attachmentId: loaded.attachments[1]!.id } }
    await send(restart.service, loaded, 'Read revised source')
    expect((await settled(restart.service, chat.conversation.id)).messages.at(-2)?.text).toContain('235000')
  })
  it('keeps generated temporary documents in memory and publishes nothing on invalid input', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: true })
    app.adapter.nextTool = { name: 'create_document', arguments: { title: 'TEMP_DOC_SENTINEL', blocks: [{ kind: 'paragraph', text: 'TEMP_DOC_CONTENT' }] } }
    await send(app.service, chat, 'Make temporary document')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.attachments).toHaveLength(1)
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await diskText(app.path)).not.toContain('TEMP_DOC')
    app.adapter.nextTool = { name: 'revise_document', arguments: { attachmentId: done.attachments[0]!.id, summary: 'Invalid edit', changes: [{ index: 99, block: { kind: 'paragraph', text: 'bad' } }] } }
    await send(app.service, done, 'Invalid block')
    expect((await settled(app.service, chat.conversation.id)).attachments).toHaveLength(1)
    await app.service.closeTemporary({ conversationId: chat.conversation.id })
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await diskText(app.path)).not.toContain('TEMP_DOC')
  })
})


it('base Chat has no Office tools and refuses model-invented installation or document calls', async () => {
  const app = await setup()
  const chat = await app.service.create({ temporary: false })
  for (const name of ['create_document', 'install_office']) {
    app.adapter.nextTool = { name, arguments: { title: 'no consent', blocks: [{ kind: 'paragraph', text: 'no' }] } }
    await send(app.service, chat, 'Try forbidden office operation')
    const result = await settled(app.service, chat.conversation.id)
    expect(result.attachments).toHaveLength(0)
    expect(result.messages.filter(item => item.role === 'tool').at(-1)?.text).toContain(name === 'create_document' ? 'office-not-installed' : 'tool-forbidden')
  }
  expect(app.adapter.requests.every(request => !request.tools.some(name => /document|office|install/u.test(name)))).toBe(true)
})
it('removing Office disables tools without deleting prior artifacts or sources', async () => {
  const app = await setup()
  const fork = app.ctx.plugin(OfficeExtension)
  await fork
  const chat = await app.service.create({ temporary: false })
  app.adapter.nextTool = { name: 'create_document', arguments: { title: 'Retained', blocks: [{ kind: 'paragraph', text: 'Keep me' }] } }
  await send(app.service, chat, 'Create')
  const created = await settled(app.service, chat.conversation.id)
  const file = created.attachments[0]!
  expect(file).toBeDefined()
  await fork.dispose()
  app.adapter.nextTool = { name: 'inspect_document', arguments: { attachmentId: file.id } }
  await send(app.service, created, 'Inspect after disabling')
  const stopped = await settled(app.service, chat.conversation.id)
  expect(stopped.messages.filter(item => item.role === 'tool').at(-1)?.text).toContain('office-not-installed')
  expect((await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: file.id, original: true })).base64).toBeTruthy()
  await app.ctx.fiber.dispose()
  const base = await setup(app.path)
  expect((await base.service.get({ conversationId: chat.conversation.id })).attachments).toHaveLength(1)
})

describe('release-blocking limits and failure isolation', () => {
  it('accepts an attachment and an export above the former validation threshold', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const file = Buffer.alloc(6 * 1024 * 1024, 'synthetic line\n')
    const attachment = await app.service.upload({ conversationId: chat.conversation.id, name: 'large.txt', base64: file.toString('base64') })
    expect(attachment.bytes).toBe(file.length)
    const text = 'x'.repeat(2 * 1024 * 1024)
    const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: ['m0'], message: null } }
    for (let index = 0; index < 6; index++) mapping['m' + index] = { id: 'm' + index, parent: index ? 'm' + (index - 1) : 'root', children: index < 5 ? ['m' + (index + 1)] : [], message: { author: { role: 'user' }, create_time: index + 1, content: { content_type: 'text', parts: [text] } } }
    const preview = await app.service.previewImport({ fileName: 'large.json', base64: Buffer.from(JSON.stringify([{ id: 'large-source', title: 'Large', current_node: 'm5', mapping }])).toString('base64') })
    expect((await app.service.commitImport({ previewId: preview.id })).conversations).toHaveLength(1)
  })

  it('still refuses malformed uploads and imports', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await expect(app.service.upload({ conversationId: chat.conversation.id, name: 'bad.txt', base64: 'not base64!' })).rejects.toThrow('Invalid file encoding')
    await expect(app.service.previewImport({ fileName: 'bad.json', base64: 'not base64!' })).rejects.toThrow('Invalid base64')
    expect((await app.service.get({ conversationId: chat.conversation.id })).attachments).toHaveLength(0)
  })

  it('keeps Chat working when an unrelated provider catalog fails', async () => {
    const app = await setup()
    const broken = new BrokenCatalog()
    app.ctx.llm.registerAdapter(['broken'], broken)
    expect((await app.service.models()).map(model => model.provider)).toEqual(['fixture'])
    expect(broken.catalogCalls).toBe(1)
    app.adapter.catalogCalls = 0
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'hello')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.messages.map(message => message.text)).toEqual(['hello', 'Echo: hello'])
    expect(broken.catalogCalls).toBe(1)
    expect(app.adapter.catalogCalls).toBe(1)
  })

  it('checks the selected route on both send and branch without persisting a rejected turn', async () => {
    const app = await setup()
    app.ctx.llm.registerAdapter(['broken'], new BrokenCatalog())
    const chat = await app.service.create({ temporary: false })
    const id = chat.conversation.id
    await expect(app.service.send({ conversationId: id, requestId: randomUUID(), branchId: chat.conversation.selectedBranchId, text: 'hello', model: { provider: 'broken', model: 'echo' } })).rejects.toThrow('available')
    await expect(app.service.send({ conversationId: id, requestId: randomUUID(), branchId: chat.conversation.selectedBranchId, text: 'hello', model: { provider: 'fixture', model: 'missing' } })).rejects.toThrow('available')
    await send(app.service, chat, 'hello')
    const done = await settled(app.service, id)
    const branchId = done.conversation.selectedBranchId!
    await expect(app.service.branch({ requestId: randomUUID(), conversationId: id, branchId, messageId: done.messages.at(-1)!.id, action: 'regenerate', model: { provider: 'broken', model: 'echo' } })).rejects.toThrow('available')
    const after = await app.service.get({ conversationId: id })
    expect(after.conversation.branches).toHaveLength(done.conversation.branches.length)
    expect(after.messages).toEqual(done.messages)
  })

  it('reports a reply cut off by the output limit and clears it on the next turn', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'TRUNCATE this reply')
    const cut = await settled(app.service, chat.conversation.id)
    expect(cut.error).toBe('max-tokens')
    expect(cut.messages.at(-1)?.text).toBe('Cut off mid')
    await send(app.service, cut, 'continue')
    const next = await settled(app.service, chat.conversation.id)
    expect(next.error).toBeUndefined()
    expect(next.messages.at(-1)?.text).toBe('Echo: continue')
  })

  it('does not execute or retain a tool call truncated by the output limit', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'TRUNCATE a tool call')
    const cut = await settled(app.service, chat.conversation.id)
    expect(cut.error).toBe('max-tokens')
    expect(app.adapter.requests).toHaveLength(1)
    expect(cut.messages.map(message => message.role)).toEqual(['user'])
    await send(app.service, cut, 'continue')
    await settled(app.service, chat.conversation.id)
    expect(JSON.stringify(app.adapter.requests.at(-1)?.messages)).not.toContain('tool-call')
  })
})

describe('large import durability', () => {
  const bulk = (count: number) => Buffer.from(JSON.stringify(Array.from({ length: count }, (_, index) => ({ ...fixture[0], id: 'bulk-' + index, title: 'Bulk ' + index })))).toString('base64')

  it('commits and undoes a large import as one durable write', async () => {
    const app = await setup()
    const imported = await app.service.commitImport({ previewId: (await app.service.previewImport({ fileName: 'bulk.json', base64: bulk(300) })).id })
    expect(imported.conversations).toHaveLength(300)
    expect(await app.service.list({})).toHaveLength(300)
    await app.service.undoImport({ batchId: imported.batch.id })
    expect(await app.service.list({})).toEqual([])
    expect(await app.service.listImports()).toMatchObject([{ id: imported.batch.id, state: 'withdrawn' }])
  })

  it('leaves nothing behind when a commit fails, and the preview can be retried', async () => {
    const app = await setup()
    const preview = await app.service.previewImport({ fileName: 'bulk.json', base64: bulk(2) })
    const { chats } = app.service as unknown as { chats: { saveConversation(...args: unknown[]): Promise<void> } }
    const original = chats.saveConversation.bind(chats)
    const save = vi.spyOn(chats, 'saveConversation').mockImplementationOnce(original).mockRejectedValueOnce(new Error('disk full'))
    await expect(app.service.commitImport({ previewId: preview.id })).rejects.toThrow('disk full')
    expect(save).toHaveBeenCalledTimes(2)
    save.mockRestore()
    expect(await app.service.list({})).toEqual([])
    expect(await app.service.listImports()).toEqual([])
    expect((await app.service.commitImport({ previewId: preview.id })).conversations).toHaveLength(2)
    expect(await app.service.list({})).toHaveLength(2)
  })
})

describe('history catalog', () => {
  it('lists summaries without conversation bodies', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'A long enough first message')
    await settled(app.service, chat.conversation.id)
    const [item, ...others] = await app.service.list({})
    expect(others).toEqual([])
    expect(Object.keys(item!).sort()).toEqual(['id', 'pinned', 'title', 'updatedAt'])
    expect(item!.title).toBe('A long enough first message')
  })

  it('finds text on every branch and in imports, but never temporary or removed text', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Original wording 原始措辞')
    const done = await settled(app.service, chat.conversation.id)
    await app.service.branch({ conversationId: chat.conversation.id, requestId: randomUUID(), branchId: done.conversation.selectedBranchId!, messageId: done.messages[0]!.id, action: 'edit', text: 'Edited wording', model: route })
    await settled(app.service, chat.conversation.id)
    const hits = async (query: string, archived = false) => (await app.service.list({ query, archived })).map(item => item.id)
    expect(await hits('original wording')).toEqual([chat.conversation.id])
    expect(await hits('edited wording')).toEqual([chat.conversation.id])
    expect(await hits('措辞')).toEqual([chat.conversation.id])
    expect(await hits('echo: edited')).toEqual([chat.conversation.id])
    expect(await hits('no such text')).toEqual([])

    await app.service.setArchived({ conversationId: chat.conversation.id, archived: true })
    expect(await hits('original wording')).toEqual([])
    expect(await hits('original wording', true)).toEqual([chat.conversation.id])
    await app.service.setArchived({ conversationId: chat.conversation.id, archived: false })

    const imported = await app.service.commitImport({ previewId: (await app.service.previewImport({ fileName: 'synthetic.json', base64: Buffer.from(JSON.stringify(fixture)).toString('base64') })).id })
    expect(await hits('other_branch')).toEqual(imported.conversations)
    await app.service.undoImport({ batchId: imported.batch.id })
    expect(await hits('other_branch')).toEqual([])

    const temporary = await app.service.create({ temporary: true })
    await send(app.service, temporary, 'Temporary words')
    await settled(app.service, temporary.conversation.id)
    expect(await hits('temporary words')).toEqual([])

    await app.service.deleteConversation({ conversationId: chat.conversation.id })
    expect(await hits('original wording')).toEqual([])
  })
})

describe('stored turn context', () => {
  it('drops the oldest turns at a user boundary and remembers how many', async () => {
    const app = await setup(undefined, false, { maxContextBytes: 4096 })
    const chat = await app.service.create({ temporary: false })
    let detail = chat
    for (let index = 0; index < 6; index++) {
      await send(app.service, detail, 'Turn ' + index + ' ' + 'x'.repeat(800))
      detail = await settled(app.service, chat.conversation.id)
    }
    const sent = app.adapter.requests.at(-1)!.messages as readonly { role: string }[]
    expect(detail.error).toBeUndefined()
    expect(detail.omittedMessages).toBeGreaterThan(0)
    expect(sent[1]!.role).toBe('user')
    expect(sent.length - 1 + detail.omittedMessages).toBe(detail.messages.length - 1)
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path, false, { maxContextBytes: 4096 })
    expect((await again.service.get({ conversationId: chat.conversation.id })).omittedMessages).toBe(detail.omittedMessages)
  })

  it('keeps no copy of the context it sent once a memory is forgotten', async () => {
    const app = await setup()
    const proposal = await app.service.proposeMemory({ text: 'The favourite colour is FORGETSENTINEL', category: 'fact', source: { kind: 'manual' } })
    if (proposal.state === 'pending') await app.service.decideCandidate({ candidateId: proposal.id, expectedRevision: proposal.revision, decision: 'confirm' })
    const [memory] = (await app.service.memoryState({})).memories
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'What is my favourite colour?')
    await settled(app.service, chat.conversation.id)
    expect(JSON.stringify(app.adapter.requests[0])).toContain('FORGETSENTINEL')
    await app.service.forgetMemory({ memoryId: memory!.id, expectedRevision: memory!.revision })
    expect(await diskText(app.path)).not.toContain('FORGETSENTINEL')
  })
})

describe('turn end commit', () => {
  interface Writes {
    serial<T>(operation: () => Promise<T>): Promise<T>
    domain: { saveConversation(record: ConversationRecord): void }
  }
  const writes = (service: PersonalChatService) => (service as unknown as { chats: Writes }).chats
  /** Queue a write that holds everything behind it until released. */
  function hold(chats: Writes): () => void {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    void chats.serial(() => gate)
    return release
  }
  async function streaming(app: Awaited<ReturnType<typeof setup>>, detail: ConversationDetail): Promise<ConversationId> {
    const id = detail.conversation.id
    await send(app.service, detail, 'WAIT')
    await vi.waitFor(async () => { expect((await app.service.get({ conversationId: id })).live?.text).toBe('Partial answer') })
    return id
  }

  it.each([
    ['a complete reply', 'Hello', undefined, 'Echo: Hello'],
    ['a reply cut at the token limit', 'TRUNCATE', 'max-tokens', 'Cut off mid'],
  ])('stores %s and its end state in one commit', async (_, text, error, reply) => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const save = vi.spyOn(writes(app.service).domain, 'saveConversation')
    await send(app.service, chat, text)
    const detail = await settled(app.service, chat.conversation.id)
    expect(detail.messages.at(-1)!.text).toBe(reply)
    expect(detail.error).toBe(error)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]![0].running).toBe(true)
    expect(save.mock.calls[1]![0].running).toBe(false)
  })

  it('stores a stopped reply and its end state in one commit', async () => {
    const app = await setup()
    const id = await streaming(app, await app.service.create({ temporary: false }))
    const save = vi.spyOn(writes(app.service).domain, 'saveConversation')
    const stopped = await app.service.stop({ conversationId: id })
    expect(stopped.messages.map(message => message.text)).toEqual(['WAIT', 'Partial answer'])
    expect(stopped.error).toBe('stopped')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps a partial reply when the Host shuts down mid-turn', async () => {
    const app = await setup()
    const id = await streaming(app, await app.service.create({ temporary: false }))
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    const detail = await again.service.get({ conversationId: id })
    expect(detail.messages.map(message => message.text)).toEqual(['WAIT', 'Partial answer'])
    expect(detail.error).toBe('stopped')
  })

  it('stays busy and readable until the reply is stored', async () => {
    const app = await setup()
    const chats = writes(app.service)
    const detail = await app.service.create({ temporary: false })
    const id = await streaming(app, detail)
    const release = hold(chats)
    const serial = vi.spyOn(chats, 'serial')
    const next = send(app.service, detail, 'Next message').then(() => 'accepted', (error: { reason?: string }) => error.reason)
    const stopping = app.service.stop({ conversationId: id })
    await vi.waitFor(() => { expect(serial).toHaveBeenCalledTimes(2) })
    const finishing = await app.service.get({ conversationId: id })
    expect(finishing.live?.text).toBe('Partial answer')
    expect(finishing.error).toBeUndefined()
    release()
    expect(await next).toBe('busy')
    const stopped = await stopping
    expect(stopped.messages.map(message => message.text)).toEqual(['WAIT', 'Partial answer'])
    expect(stopped.error).toBe('stopped')
  })

  it('stores nothing for a chat deleted while its reply waits to be stored', async () => {
    const app = await setup()
    const chats = writes(app.service)
    const id = await streaming(app, await app.service.create({ temporary: false }))
    const release = hold(chats)
    const serial = vi.spyOn(chats, 'serial')
    const deleted = app.service.deleteConversation({ conversationId: id })
    await vi.waitFor(() => { expect(serial).toHaveBeenCalledTimes(1) })
    const save = vi.spyOn(chats.domain, 'saveConversation')
    release()
    await deleted
    expect(save.mock.calls.flatMap(([record]) => record.entries).filter(entry => entry.message.role === 'assistant')).toEqual([])
    expect(await diskText(app.path)).not.toContain('Partial answer')
    await expect(app.service.get({ conversationId: id })).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('reports a failed end commit and accepts the next message', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const id = chat.conversation.id
    const domain = writes(app.service).domain
    const original = domain.saveConversation.bind(domain)
    const save = vi.spyOn(domain, 'saveConversation').mockImplementationOnce(original).mockImplementationOnce(() => { throw new Error('disk full') })
    const followed: string[] = []
    const controller = new AbortController()
    const following = (async () => {
      for await (const update of app.service.followConversation({ conversationId: id }, controller.signal)) if (update.kind === 'failure') { followed.push(update.reason); return }
    })()
    await send(app.service, chat, 'Hello')
    await following
    controller.abort()
    const failed = await app.service.get({ conversationId: id })
    expect(followed).toEqual(['storage-error'])
    expect(failed.error).toBe('interrupted')
    expect(failed.messages.map(message => message.text)).toEqual(['Hello'])
    await send(app.service, failed, 'Again')
    const recovered = await settled(app.service, id)
    expect(recovered.error).toBeUndefined()
    expect(recovered.messages.map(message => message.text)).toEqual(['Hello', 'Again', 'Echo: Again'])
    expect(save).toHaveBeenCalledTimes(4)
  })
})

describe('pinned chats', () => {
  it('lists pinned chats first without counting the pin as activity', async () => {
    const app = await setup()
    const first = await app.service.create({ temporary: false })
    await send(app.service, first, 'First chat')
    await settled(app.service, first.conversation.id)
    const second = await app.service.create({ temporary: false })
    await send(app.service, second, 'Second chat')
    await settled(app.service, second.conversation.id)
    const before = (await app.service.get({ conversationId: first.conversation.id })).conversation.updatedAt
    const pinned = await app.service.setPinned({ conversationId: first.conversation.id, pinned: true })
    expect(pinned.pinned).toBe(true)
    expect(pinned.updatedAt).toBe(before)
    expect((await app.service.list({})).map(item => [item.id, item.pinned])).toEqual([[first.conversation.id, true], [second.conversation.id, false]])
    await app.service.setPinned({ conversationId: first.conversation.id, pinned: false })
    expect((await app.service.list({})).map(item => item.id)).toEqual([second.conversation.id, first.conversation.id])
  })

  it('keeps a pin across a restart and refuses Temporary Chat', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Keep this')
    await settled(app.service, chat.conversation.id)
    await app.service.setPinned({ conversationId: chat.conversation.id, pinned: true })
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    expect((await again.service.list({}))[0]!.pinned).toBe(true)
    const temporary = await again.service.create({ temporary: true })
    await expect(again.service.setPinned({ conversationId: temporary.conversation.id, pinned: true })).rejects.toMatchObject({ reason: 'temporary-operation' })
  })
})

describe('web sources', () => {
  const search = (sources: readonly object[]) => ({ search: async () => ({ sources, truncated: false }), fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 200, body: { kind: 'text', text: 'Page' }, truncated: false }) })

  it('lists the sources a reply consulted, once each, and drops unusable addresses', async () => {
    const app = await setup()
    app.ctx.provide('web', search([{ url: 'https://example.com/a', title: 'Article' }, { url: 'https://example.com/a', title: 'Again' }, { url: 'https://example.com/b' }, { url: 'javascript:alert(1)', title: 'Script' }, { url: 'not a url' }]))
    const chat = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'web_search', arguments: { query: 'beluga' } }
    await send(app.service, chat, 'Look this up', { web: true })
    const detail = await settled(app.service, chat.conversation.id)
    expect(detail.messages.at(-1)!.sources).toEqual([{ url: 'https://example.com/a', title: 'Article' }, { url: 'https://example.com/b' }])
    expect(detail.messages.filter(message => message.sources)).toHaveLength(1)
  })

  it('credits a fetched page and keeps sources after a restart', async () => {
    const app = await setup()
    app.ctx.provide('web', search([]))
    const chat = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'web_fetch', arguments: { url: 'https://example.com/page' } }
    await send(app.service, chat, 'Read this page', { web: true })
    await settled(app.service, chat.conversation.id)
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    expect((await again.service.get({ conversationId: chat.conversation.id })).messages.at(-1)!.sources).toEqual([{ url: 'https://example.com/page' }])
  })
})

describe('reference chat history', () => {
  async function history(app: Awaited<ReturnType<typeof setup>>) {
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'My whale project is called BELUGASENTINEL and ships in spring')
    await settled(app.service, chat.conversation.id)
    return chat
  }
  const toolText = (app: Awaited<ReturnType<typeof setup>>) => JSON.stringify((app.adapter.requests.at(-1)!.messages as readonly { role: string }[]).filter(message => message.role === 'tool'))

  it('finds excerpts from other chats for the model', async () => {
    const app = await setup()
    const source = await history(app)
    const current = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'BelugaSentinel' } }
    await send(app.service, current, 'What did I call that project?')
    await settled(app.service, current.conversation.id)
    expect(app.adapter.requests[1]!.tools).toContain('search_chats')
    const result = toolText(app)
    expect(result).toContain('belugasentinel and ships in spring')
    expect(result).toContain(source.conversation.id)
  })

  it('leaves out the current chat, archived chats and deleted chats', async () => {
    const app = await setup()
    const archived = await history(app)
    await app.service.setArchived({ conversationId: archived.conversation.id, archived: true })
    const deleted = await history(app)
    await app.service.deleteConversation({ conversationId: deleted.conversation.id })
    const current = await history(app)
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'belugasentinel' } }
    await send(app.service, await app.service.get({ conversationId: current.conversation.id }), 'Search')
    await settled(app.service, current.conversation.id)
    expect(toolText(app)).toContain('excerpts')
    expect(toolText(app)).not.toContain('spring')
  })

  it('is unavailable when turned off, and in Temporary Chat', async () => {
    const app = await setup()
    await history(app)
    const { profile } = await app.service.memoryState({})
    await app.service.updateProfile({ expectedRevision: profile.revision, background: '', instructions: '', autoSaveLowRisk: true, referenceChats: false })
    const off = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'belugasentinel' } }
    await send(app.service, off, 'Search')
    await settled(app.service, off.conversation.id)
    expect(app.adapter.requests.at(-2)!.tools).not.toContain('search_chats')
    expect(toolText(app)).not.toContain('spring')
    await app.service.updateProfile({ expectedRevision: profile.revision + 1, background: '', instructions: '', autoSaveLowRisk: true, referenceChats: true })
    const temporary = await app.service.create({ temporary: true })
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'belugasentinel' } }
    await send(app.service, temporary, 'Search')
    await settled(app.service, temporary.conversation.id)
    expect(app.adapter.requests.at(-2)!.tools).not.toContain('search_chats')
    expect(toolText(app)).not.toContain('spring')
  })
})
