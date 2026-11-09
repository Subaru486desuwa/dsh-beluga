import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import PersonalChatService from '../lib/index.js'
import OfficeExtension from '../../office/lib/index.js'
import { PersonalStore } from '../src/host/storage.ts'
import type { ConversationRecord } from '../src/host/records.ts'
import type { ConversationDetail, ConversationId, MemorySummaryView } from '../src/shared/types.ts'
import type { MemorySummaries } from '../src/host/memory-summary.ts'
import { zipSync } from 'fflate'
import { currentExport, fixture } from './fixtures/chatgpt.ts'
import { pdf } from './fixtures/pdf.ts'
import { wordDocument, workbook } from './office-fixtures.ts'

const route = { provider: 'fixture', model: 'echo' }
/** Long enough for the Office engine to start and open a file. */
const ENGINE_TIME = 60000
class ScriptedModel extends LlmAdapter {
  readonly requests: { sessionId: unknown; system?: string; messages: unknown; tools: readonly string[]; effort?: string }[] = []
  nextTool?: { name: string; arguments: object }
  /** Picks each next call from the last tool result, or from nothing on the first step; undefined answers. */
  follow?: (result: string | undefined) => { name: string; arguments: object } | undefined
  /** Tool calls made one per step, after a tool result too, before the model answers. */
  readonly script: { name: string; arguments: object }[] = []
  /** Whether the model keeps calling tools after it is told its tool budget is spent. */
  ignoresBudget = false
  /** Whether a request to condense a long chat fails. */
  failsCondensing = false
  /** Title requests wait for this before answering. */
  titleGate?: Promise<void>
  /** The context window the route discloses, in tokens; undefined discloses none. */
  contextWindow?: number
  catalogCalls = 0
  providerInfo(provider: string) { return { id: provider, name: 'Local fixture' } }
  async listModels(provider: string) { this.catalogCalls++; return [{ provider, id: 'echo', name: 'Scripted echo', inputModalities: ['text' as const] }] }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: 'Scripted echo', inputModalities: ['text'], reasoning: { efforts: [{ id: brandString<ReasoningEffortId>('off'), name: 'Off' }, { id: brandString<ReasoningEffortId>('high'), name: 'High' }], defaultEffort: brandString<ReasoningEffortId>('high') }, ...(this.contextWindow ? { context: { contextWindow: this.contextWindow } } : {}) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sessionId: options.sessionId, system: options.system, messages: structuredClone(options.messages), tools: options.tools?.map(tool => tool.name) ?? [], ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}) })
    const last = options.messages.at(-1)!
    const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    // Condensing names the turns it read, after what was condensed before.
    if (options.system?.startsWith('You condense')) {
      if (this.failsCondensing) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'Condensing refused' } } }; return }
      const turns = [...text.matchAll(/^User: (Turn \S+)/gmu)].map(match => match[1]).join('; ')
      const previous = /<condensed_so_far>\n([\s\S]*?)\n<\/condensed_so_far>/u.exec(text)?.[1] ?? ''
      yield { type: 'text-delta', index: 0, text: `<condensed>\nCONDENSED: ${turns}${previous.startsWith('(nothing') ? '' : '\n' + previous}\n</condensed>` }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.system?.startsWith('You title chats')) {
      await this.titleGate
      yield { type: 'text-delta', index: 0, text: '"Titled: ' + (/<user>\n(.*)/u.exec(text)?.[1] ?? '') + '."' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.system?.startsWith('You maintain a memory summary')) {
      if (options.system.includes('typed a message')) {
        const message = /<message>\n([\s\S]*)\n<\/message>/u.exec(text)?.[1] ?? ''
        yield { type: 'text-delta', index: 0, text: message.startsWith('QUESTION') ? '<reply>Answered from the summary.</reply>' + (message.includes('with suggestions') ? '\n<suggestions>\nUnasked\n</suggestions>' : '') : `<reply>Changed.</reply>\n<overview>\nEDITED: ${message}\n</overview>\n<suggestions>\nOne\nTwo\nThree\n</suggestions>` }
      } else {
        // An update rewrites the overview and moves the previous overview into "Earlier"; other sections are left out.
        const told = [...text.matchAll(/^User: (.*)$/gmu)].map(match => match[1]).join('; ')
        const previous = /<current_summary>\n([\s\S]*?)\n<\/current_summary>/u.exec(text)?.[1] ?? ''
        const earlier = previous.startsWith('(empty') ? '' : previous.split('\n## ')[0]!
        yield { type: 'text-delta', index: 0, text: `<overview>\nYou told me: ${told}.\n</overview>\n${earlier ? `<sections>\n## Earlier\n${earlier}\n</sections>\n` : ''}<suggestions>\n- Ask about ${told}\n- Second\n- Third\n</suggestions>` }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!this.ignoresBudget && options.system?.includes('used its tool budget')) {
      yield { type: 'text-delta', index: 0, text: 'Answered from what I found.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const followed = this.follow?.(last.role === 'tool' ? text : undefined)
    if (followed) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(randomUUID()), name: followed.name, arguments: JSON.stringify(followed.arguments) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (last.role === 'tool' && !this.script.length) {
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
    if (text.startsWith('THINK')) {
      yield { type: 'reasoning-delta', index: 0, text: 'Weighing it' }
      await new Promise(resolve => setTimeout(resolve, 40))
      yield { type: 'reasoning-delta', index: 0, text: ' up.' }
      yield { type: 'text-delta', index: 1, text: 'Thought it through.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const tool = this.nextTool ?? this.script.shift() ?? (text.startsWith('Remember:') ? { name: 'memory_propose', arguments: { text: 'I prefer concise answers', category: 'preference' } } : undefined)
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
  // A title is one more background request after a first reply; tests that count requests leave titles off.
  await ctx.plugin(PersonalChatService, { autoTitles: false, ...config, dataDir: directory })
  if (office) await ctx.plugin(OfficeExtension)
  resources.push({ ctx, path: directory })
  return { ctx, adapter, service: ctx.personalChat, path: directory }
}
async function send(service: PersonalChatService, detail: ConversationDetail, text: string, extra: object = {}) {
  return service.send({ conversationId: detail.conversation.id, requestId: randomUUID(), branchId: detail.conversation.selectedBranchId, text, model: route, ...extra })
}
async function settled(service: PersonalChatService, id: ConversationId, wait = 10000): Promise<ConversationDetail> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), wait)
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
    const other = await app.service.create({ temporary: false })
    await send(app.service, other, 'hello')
    await settled(app.service, other.conversation.id)
    const first = await app.service.create({ temporary: false })
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

  it('imports a sharded export without children and keeps its reasoning from the model', async () => {
    const app = await setup()
    const shard = (id: string) => Buffer.from(JSON.stringify([{ ...currentExport[0], id }]))
    const zip = zipSync({ 'conversations-000.json': shard('first'), 'conversations-001.json': shard('second') })
    const preview = await app.service.previewImport({ fileName: 'export.zip', base64: Buffer.from(zip).toString('base64') })
    expect(preview.items.map(item => [item.sourceId, item.nodes, item.branches, item.warnings.length])).toEqual([['first', 6, 2, 1], ['second', 6, 2, 1]])
    const imported = await app.service.commitImport({ previewId: preview.id })
    const id = imported.conversations[0]!
    const detail = await app.service.get({ conversationId: id })
    expect(detail.archive?.original).toEqual({ ...currentExport[0], id: 'first' })
    expect(detail.archive?.branchNodes.filter(node => node.reasoning).map(node => node.id)).toEqual(['thought', 'recap'])
    await app.service.send({ conversationId: id, requestId: randomUUID(), archive: { revisionId: imported.batch.revisionIds[0]!, nodeId: 'answer' }, text: 'Continue', model: route })
    await settled(app.service, id)
    const request = JSON.stringify(app.adapter.requests.at(-1))
    expect(request).toContain('LOOK_AT_THIS')
    expect(request).toContain('FINAL_ANSWER')
    expect(request).not.toContain('RETRIED_ANSWER')
    expect(request).not.toContain('PRIVATE_REASONING')
    const repeated = await app.service.commitImport({ previewId: (await app.service.previewImport({ fileName: 'export.zip', base64: Buffer.from(zip).toString('base64') })).id })
    expect(repeated.batch.skipped).toBe(2)
    await app.service.undoImport({ batchId: imported.batch.id })
    expect((await app.service.list({})).map(chat => chat.id)).toEqual([id])
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
    await app.service.updateApps({ webAuto: false })
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
  const paragraphAt = (text: string, needle: string) => JSON.parse(text.split('\n').find(line => line.includes(needle))!) as { part: string; location: string; text: string }
  const read = async (app: Awaited<ReturnType<typeof setup>>, chat: ConversationDetail, attachmentId: string) => {
    app.adapter.nextTool = { name: 'read_attachment', arguments: { attachmentId } }
    await send(app.service, chat, 'Read it')
    const done = await settled(app.service, chat.conversation.id)
    return { done, text: (JSON.parse(done.messages.at(-2)!.text) as { text: string }).text }
  }
  it('publishes immutable editable versions with branch ownership and restart persistence', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const source = { title: '预算报告', blocks: [{ kind: 'heading', level: 1, text: '预算' }, { kind: 'paragraph', text: '230000' }] }
    app.adapter.nextTool = { name: 'create_document', arguments: source }
    await send(app.service, chat, 'Create a report')
    const first = await settled(app.service, chat.conversation.id, ENGINE_TIME)
    expect(first.error).toBeUndefined()
    expect(first.attachments, JSON.stringify(first.messages)).toHaveLength(1)
    const original = first.attachments[0]!
    expect(original.artifact).toMatchObject({ version: 1, rootId: original.id })
    expect(first.messages.find(message => message.role === 'tool')?.attachmentIds).toEqual([original.id])
    const originalBytes = await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: original.id, original: true })
    const { done: readDone, text } = await read(app, first, original.id)
    const target = paragraphAt(text, '230000')
    app.adapter.nextTool = { name: 'edit_document', arguments: { attachmentId: original.id, summary: 'Update actuals', changes: [{ location: target.location, expected: target.text, action: 'replace', text: '235000' }] } }
    await send(app.service, readDone, 'Change the second block only')
    const second = await settled(app.service, chat.conversation.id, ENGINE_TIME)
    expect(second.messages.at(-2)?.text).toContain('"opened":true')
    expect(second.attachments).toHaveLength(2)
    expect(second.attachments[1]?.artifact).toMatchObject({ version: 2, parentId: original.id, rootId: original.id })
    expect(await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: original.id, original: true })).toEqual(originalBytes)
    const other = await app.service.create({ temporary: false })
    app.adapter.nextTool = { name: 'read_attachment', arguments: { attachmentId: original.id } }
    await send(app.service, other, 'Read another chat')
    const denied = await settled(app.service, other.conversation.id)
    expect(denied.messages.find(message => message.role === 'tool')?.text).toContain('attachment-forbidden')
    await app.ctx.fiber.dispose()
    const restart = await setup(app.path, true)
    const loaded = await restart.service.get({ conversationId: chat.conversation.id })
    expect(loaded.attachments[1]?.artifact?.version).toBe(2)
    expect((await read(restart, loaded, loaded.attachments[1]!.id)).text).toContain('235000')
  }, ENGINE_TIME)
  it('keeps generated temporary documents in memory and publishes nothing on invalid input', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: true })
    app.adapter.nextTool = { name: 'create_document', arguments: { title: 'TEMP_DOC_SENTINEL', blocks: [{ kind: 'paragraph', text: 'TEMP_DOC_CONTENT' }] } }
    await send(app.service, chat, 'Make temporary document')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.attachments).toHaveLength(1)
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await diskText(app.path)).not.toContain('TEMP_DOC')
    app.adapter.nextTool = { name: 'edit_document', arguments: { attachmentId: done.attachments[0]!.id, summary: 'Invalid edit', changes: [{ location: '/document[1]/body[1]/paragraph[99]', expected: 'x', action: 'replace', text: 'bad' }] } }
    await send(app.service, done, 'Invalid block')
    expect((await settled(app.service, chat.conversation.id)).attachments).toHaveLength(1)
    await app.service.closeTemporary({ conversationId: chat.conversation.id })
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await diskText(app.path)).not.toContain('TEMP_DOC')
  })
})

describe('Office files in Chat', () => {
  async function turn(app: Awaited<ReturnType<typeof setup>>, chat: ConversationDetail, tool: string, args: object, wait = ENGINE_TIME) {
    app.adapter.nextTool = { name: tool, arguments: args }
    await send(app.service, chat, 'Use the tool')
    const done = await settled(app.service, chat.conversation.id, wait)
    return { done, result: done.messages.filter(item => item.role === 'tool').at(-1)!.text }
  }
  const upload = (app: Awaited<ReturnType<typeof setup>>, chat: ConversationDetail, name: string, bytes: Uint8Array) => app.service.upload({ conversationId: chat.conversation.id, name, base64: Buffer.from(bytes).toString('base64') })
  const budget = () => workbook({ 预算: '<row r="1"><c r="A1" s="1"><v>100</v></c><c r="B1"><f>A1*2</f><v>200</v></c></row>' })

  it('creates a workbook, reports its formulas, and previews it', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const { done, result } = await turn(app, chat, 'create_workbook', { title: '预算', sheets: [{ name: '预算', rows: [['金额', 1200], ['合计', { formula: 'B1*2' }], ['坏', { formula: '1/0' }]] }] })
    expect(result).toContain('"recalculated":true')
    expect(result).toContain('#DIV/0!')
    const file = done.attachments[0]!
    expect(file).toMatchObject({ name: '预算.xlsx', artifact: { version: 1 } })
    const preview = await app.service.previewFile({ conversationId: chat.conversation.id, attachmentId: file.id })
    expect(preview.sheet).toBe('预算')
    expect(preview.pages).toHaveLength(1)
    const pdf = await app.service.exportPdf({ conversationId: chat.conversation.id, attachmentId: file.id })
    expect(Buffer.from(pdf.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
    expect(app.adapter.requests.at(-1)?.tools).toEqual(expect.arrayContaining(['create_workbook', 'edit_workbook', 'read_sheet']))
  }, ENGINE_TIME)
  it('edits an uploaded workbook into a new version and leaves the upload alone', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const source = budget()
    const attachment = await upload(app, chat, '预算.xlsx', source)
    await send(app.service, await app.service.get({ conversationId: chat.conversation.id }), 'Attached', { attachmentIds: [attachment.id] })
    const attached = await settled(app.service, chat.conversation.id)
    const { done, result } = await turn(app, attached, 'edit_workbook', { attachmentId: attachment.id, summary: 'Raise the budget', changes: [{ sheet: '预算', cell: 'A1', value: 300 }] })
    expect(result).toContain('"recalculated":true')
    const file = done.attachments.at(-1)!
    expect(file.name).toBe('预算.xlsx')
    expect(file.artifact).toMatchObject({ version: 2, parentId: attachment.id, rootId: attachment.id, summary: 'Raise the budget' })
    expect(Buffer.from((await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: attachment.id, original: true })).base64, 'base64')).toEqual(Buffer.from(source))
    const { result: read } = await turn(app, done, 'read_sheet', { attachmentId: file.id, range: 'A1:B1' })
    expect(read).toContain('[[300,600]]')
    const leak = await turn(app, done, 'edit_workbook', { attachmentId: file.id, summary: 'Leak', changes: [{ sheet: '预算', cell: 'A1', value: { formula: 'WEBSERVICE("https://example.com")' } }] })
    expect(leak.done.attachments).toHaveLength(2)
    expect(leak.result).toContain('invalid-tool-arguments')
    expect(leak.result).toContain('Formulas cannot reach the network')
  }, ENGINE_TIME)
  it('keeps Temporary Chat workbooks off the disk and away from the engine', async () => {
    const app = await setup(undefined, true)
    // A private directory makes any file the engine would have written visible here.
    const scratch = await mkdtemp(join(tmpdir(), 'temporary-office-'))
    process.env.TMPDIR = scratch
    onTestFinished(async () => { delete process.env.TMPDIR; await rm(scratch, { recursive: true, force: true }) })
    const chat = await app.service.create({ temporary: true })
    const { done, result } = await turn(app, chat, 'create_workbook', { title: 'TEMP_BOOK_SENTINEL', sheets: [{ name: 'S', rows: [[1, { formula: 'A1*2' }]] }] })
    expect(result).toContain('"recalculated":false')
    const file = done.attachments[0]!
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await diskText(app.path)).not.toContain('TEMP_BOOK')
    await expect(app.service.previewFile({ conversationId: chat.conversation.id, attachmentId: file.id })).rejects.toThrow('Temporary Chat')
    await expect(app.service.exportPdf({ conversationId: chat.conversation.id, attachmentId: file.id })).rejects.toThrow('Temporary Chat')
    const { done: edited, result: second } = await turn(app, done, 'edit_workbook', { attachmentId: file.id, summary: 'Change', changes: [{ sheet: 'S', cell: 'A1', value: 2 }] })
    expect(second).toContain('"recalculated":false')
    expect(edited.attachments[1]?.artifact?.version).toBe(2)
    expect(await readdir(join(app.path, 'attachments'))).toEqual([])
    expect(await readdir(scratch)).toEqual([])
  }, ENGINE_TIME)
  it('edits an uploaded document with tracked changes and fills a template', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
    const attachment = await upload(app, chat, '合同.docx', wordDocument(paragraph('金额 100 元') + paragraph('客户 {{客户}}')))
    await send(app.service, await app.service.get({ conversationId: chat.conversation.id }), 'Attached', { attachmentIds: [attachment.id] })
    const attached = await settled(app.service, chat.conversation.id)
    const first = await turn(app, attached, 'edit_document', { attachmentId: attachment.id, summary: 'Raise', track: true, changes: [{ location: '/document[1]/body[1]/paragraph[1]', expected: '金额 100 元', action: 'replace', text: '金额 200 元' }] })
    expect(first.result).toContain('"opened":true')
    const edited = first.done.attachments.at(-1)!
    expect(edited.artifact).toMatchObject({ version: 2, parentId: attachment.id })
    expect(Buffer.from((await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: edited.id, original: true })).base64, 'base64').includes('Beluga')).toBe(false)
    const second = await turn(app, first.done, 'fill_template', { attachmentId: edited.id, summary: 'Fill', values: { 客户: '甲公司' } })
    expect(second.result).toContain('"unfilled":[]')
    expect(second.done.attachments.at(-1)!.artifact).toMatchObject({ version: 3, parentId: edited.id, rootId: attachment.id })
    const read = await turn(app, second.done, 'read_attachment', { attachmentId: second.done.attachments.at(-1)!.id })
    expect(read.result).toContain('客户 甲公司')
    expect(read.result).toContain('金额 200 元')
    const stale = await turn(app, second.done, 'edit_document', { attachmentId: attachment.id, summary: 'Stale', changes: [{ location: '/document[1]/body[1]/paragraph[1]', expected: '不是这样', action: 'delete' }] })
    expect(stale.result).toContain('document-target')
    expect(stale.result).toContain('金额 100 元')
    expect(app.adapter.requests.at(-1)?.tools).toEqual(expect.arrayContaining(['edit_document', 'fill_template']))
    expect(app.adapter.requests.at(-1)?.tools).not.toContain('revise_document')
  }, ENGINE_TIME)
  it('keeps files to their own chat and branch', async () => {
    const app = await setup(undefined, true)
    const chat = await app.service.create({ temporary: false })
    const { done } = await turn(app, chat, 'create_workbook', { title: 'Mine', sheets: [{ name: 'S', rows: [[1]] }] })
    const other = await app.service.create({ temporary: false })
    const file = done.attachments[0]!.id
    for (const [tool, args] of [['read_sheet', {}], ['edit_workbook', { summary: 'x', changes: [{ sheet: 'S', cell: 'A1', value: 2 }] }]] as const) {
      expect((await turn(app, other, tool, { attachmentId: file, ...args })).result).toContain('attachment-forbidden')
    }
    await expect(app.service.previewFile({ conversationId: other.conversation.id, attachmentId: file })).rejects.toThrow()
    await expect(app.service.exportPdf({ conversationId: other.conversation.id, attachmentId: file })).rejects.toThrow()
  }, ENGINE_TIME)
  it('says when the Office extension is missing', async () => {
    const app = await setup()
    expect((await app.service.limits()).office).toBe(false)
    const chat = await app.service.create({ temporary: false })
    const attachment = await upload(app, chat, 'book.xlsx', budget())
    await expect(app.service.previewFile({ conversationId: chat.conversation.id, attachmentId: attachment.id })).rejects.toThrow('Office')
    await expect(app.service.exportPdf({ conversationId: chat.conversation.id, attachmentId: attachment.id })).rejects.toThrow('Office')
    await expect((await setup(undefined, true)).service.limits()).resolves.toMatchObject({ office: true })
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
  const created = await settled(app.service, chat.conversation.id, ENGINE_TIME)
  const file = created.attachments[0]!
  expect(file).toBeDefined()
  await fork.dispose()
  app.adapter.nextTool = { name: 'edit_document', arguments: { attachmentId: file.id, summary: 'Off', changes: [{ location: '/document[1]/body[1]/paragraph[1]', expected: 'Keep me', action: 'delete' }] } }
  await send(app.service, created, 'Edit after disabling')
  const stopped = await settled(app.service, chat.conversation.id)
  expect(stopped.messages.filter(item => item.role === 'tool').at(-1)?.text).toContain('office-not-installed')
  expect((await app.service.attachment({ conversationId: chat.conversation.id, attachmentId: file.id, original: true })).base64).toBeTruthy()
  await app.ctx.fiber.dispose()
  const base = await setup(app.path)
  expect((await base.service.get({ conversationId: chat.conversation.id })).attachments).toHaveLength(1)
}, ENGINE_TIME)

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
    expect(Object.keys(item!).sort()).toEqual(['activity', 'archived', 'id', 'pinned', 'title', 'updatedAt'])
    expect(item!.title).toBe('A long enough first message')
  })

  it('marks a chat running, then replied when it finished unwatched, until someone opens it', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const id = chat.conversation.id
    await send(app.service, chat, 'WAIT')
    await vi.waitFor(async () => { expect((await app.service.get({ conversationId: id })).live?.text).toBe('Partial answer') })
    expect((await app.service.list({}))[0]!.activity).toBe('running')
    await app.service.stop({ conversationId: id })
    expect((await app.service.list({}))[0]!.activity).toBe('replied')
    const watching = new AbortController()
    const updates = app.service.followConversation({ conversationId: id }, watching.signal)[Symbol.asyncIterator]()
    await updates.next()
    expect((await app.service.list({}))[0]!.activity).toBe('idle')
    await send(app.service, await app.service.get({ conversationId: id }), 'Watched while it answers')
    await settled(app.service, id)
    expect((await app.service.list({}))[0]!.activity).toBe('idle')
    watching.abort()
    await updates.return?.()
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
    expect(await hits('')).not.toContain(chat.conversation.id)
    expect(await app.service.list({ query: 'original wording' })).toMatchObject([{ id: chat.conversation.id, archived: true }])
    expect(await hits('', true)).toEqual([chat.conversation.id])
    await app.service.setArchived({ conversationId: chat.conversation.id, archived: false })
    expect(await hits('', true)).toEqual([])

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

describe('a long chat', () => {
  const condensing = (adapter: ScriptedModel) => adapter.requests.filter(request => request.system?.startsWith('You condense'))
  const bytes = (request: ScriptedModel['requests'][number]) => Buffer.byteLength(request.system ?? '') + Buffer.byteLength(JSON.stringify(request.messages))
  /** The condensed texts stored with a chat, read from disk. */
  function stored(path: string, id: ConversationId): readonly { readonly text: string }[] {
    const db = new DatabaseSync(join(path, 'personal-chat.sqlite3'), { readOnly: true })
    try { return (JSON.parse(String((db.prepare('SELECT value FROM personal_chat_conversations WHERE id = ?').get(id) as { value: string }).value)) as { condensed?: { text: string }[] }).condensed ?? [] }
    finally { db.close() }
  }
  async function chatter(app: Awaited<ReturnType<typeof setup>>, turns: number, size = 1200): Promise<ConversationDetail> {
    let detail = await app.service.create({ temporary: false })
    for (let index = 0; index < turns; index++) {
      await send(app.service, detail, 'Turn ' + index + ' ' + 'x'.repeat(size))
      detail = await settled(app.service, detail.conversation.id)
    }
    return detail
  }
  /** Each earlier turn reaches the model, as it was or in the condensed text the request carries. */
  function nothingLost(request: string, turns: number): void {
    for (let index = 0; index < turns; index++) expect(request).toContain('Turn ' + index)
  }

  it('leaves a chat that fits as it is', async () => {
    const app = await setup()
    await chatter(app, 3)
    expect(condensing(app.adapter)).toHaveLength(0)
    const sent = JSON.stringify(chatRequests(app.adapter).at(-1)!.messages)
    for (let index = 0; index < 2; index++) expect(sent).toContain('Turn ' + index + ' xxx')
  })
  it('condenses its oldest turns after a reply, so later requests carry them instead of leaving them out', async () => {
    const limit = 16 * 1024
    const app = await setup(undefined, false, { maxContextBytes: limit })
    const detail = await chatter(app, 6)
    await vi.waitFor(() => expect(stored(app.path, detail.conversation.id)).not.toHaveLength(0))
    await send(app.service, detail, 'Turn last')
    const done = await settled(app.service, detail.conversation.id)
    expect(done.error).toBeUndefined()
    expect(done).not.toHaveProperty('omittedMessages')
    expect(done.messages.filter(message => message.role === 'user')).toHaveLength(7)
    const sent = JSON.stringify(chatRequests(app.adapter).at(-1)!.messages)
    expect(sent).toContain('CONDENSED: Turn 0')
    expect(sent).not.toContain('Turn 0 xxx')
    nothingLost(sent, 6)
    for (const request of chatRequests(app.adapter)) expect(bytes(request)).toBeLessThanOrEqual(limit)
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path, false, { maxContextBytes: limit })
    await send(again.service, done, 'Turn after restart')
    await settled(again.service, detail.conversation.id)
    expect(JSON.stringify(chatRequests(again.adapter)[0]!.messages)).toContain('CONDENSED: Turn 0')
  })
  it('waits for condensing when a request would otherwise leave turns out', async () => {
    const app = await setup(undefined, false, { maxContextBytes: 16 * 1024 })
    // Under half the budget without tool results, so nothing condenses after these replies; the next message overruns it.
    const detail = await chatter(app, 3, 1150)
    expect(condensing(app.adapter)).toHaveLength(0)
    await send(app.service, detail, 'Turn big ' + 'y'.repeat(8150))
    const done = await settled(app.service, detail.conversation.id)
    expect(done.error).toBeUndefined()
    expect(app.adapter.requests.at(-2)!.system).toMatch(/^You condense/u)
    const sent = JSON.stringify(chatRequests(app.adapter).at(-1)!.messages)
    expect(sent).toContain('Turn big')
    nothingLost(sent, 3)
  })
  it('goes on without condensed text when condensing fails, and the reply still completes', async () => {
    const app = await setup(undefined, false, { maxContextBytes: 16 * 1024 })
    app.adapter.failsCondensing = true
    // Under half the budget without tool results, so nothing condenses after these replies; the next message overruns it.
    const detail = await chatter(app, 3, 1150)
    await send(app.service, detail, 'Turn big ' + 'y'.repeat(8150))
    const done = await settled(app.service, detail.conversation.id)
    expect(done.error).toBeUndefined()
    expect(condensing(app.adapter)).toHaveLength(1)
    const sent = JSON.stringify(chatRequests(app.adapter).at(-1)!.messages)
    expect(sent).toContain('Turn big')
    expect(sent).not.toContain('Turn 0 ')
  })
  it('holds the budget to what the route\'s context window leaves after the reply', async () => {
    const app = await setup()
    app.adapter.contextWindow = 8192 + 4096
    await chatter(app, 5, 1000)
    for (const request of chatRequests(app.adapter)) expect(bytes(request)).toBeLessThanOrEqual(8192)
    expect(condensing(app.adapter).length).toBeGreaterThan(0)
  })
})

describe('stored turn context', () => {
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

  it('tells how long the running step has taken, by the Host clock', async () => {
    const app = await setup()
    const id = await streaming(app, await app.service.create({ temporary: false }))
    const first = (await app.service.get({ conversationId: id })).live!.stepElapsedMs
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await app.service.get({ conversationId: id })).live!.stepElapsedMs).toBeGreaterThanOrEqual(first + 20)
    await app.service.stop({ conversationId: id })
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

  it('leaves out the current chat and deleted chats, and finds archived ones', async () => {
    const app = await setup()
    const archived = await history(app)
    await app.service.setArchived({ conversationId: archived.conversation.id, archived: true })
    const deleted = await history(app)
    await app.service.deleteConversation({ conversationId: deleted.conversation.id })
    const current = await history(app)
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'belugasentinel' } }
    await send(app.service, await app.service.get({ conversationId: current.conversation.id }), 'Search')
    await settled(app.service, current.conversation.id)
    const result = toolText(app)
    expect(result).toContain(archived.conversation.id)
    expect(result).not.toContain(deleted.conversation.id)
    expect(result).not.toContain(current.conversation.id)
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

describe('turn controls', () => {
  it('offers reasoning efforts, sends the chosen one and starts the next chat from it', async () => {
    const app = await setup()
    const offered = (await app.service.models()).find(choice => choice.model === 'echo')!
    expect(offered).toMatchObject({ efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' })
    expect(offered.lastUsed).toBeUndefined()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'hello', { model: { ...route, effort: 'off' } })
    await settled(app.service, chat.conversation.id)
    expect(app.adapter.requests.at(-1)?.effort).toBe('off')
    expect((await app.service.get({ conversationId: chat.conversation.id })).model).toEqual({ ...route, effort: 'off' })
    expect((await app.service.models()).find(choice => choice.model === 'echo')).toMatchObject({ lastUsed: true, effort: 'off' })
    await expect(send(app.service, chat, 'again', { model: { ...route, effort: 'max' } })).rejects.toThrow('reasoning effort')
  })

  it('remembers nothing from Temporary Chat', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: true })
    await send(app.service, chat, 'hello', { model: { ...route, effort: 'off' } })
    await settled(app.service, chat.conversation.id)
    expect((await app.service.models()).find(choice => choice.model === 'echo')).not.toHaveProperty('lastUsed')
  })

  it('keeps the to-do list out of the tool budget and shows the latest valid list', async () => {
    const app = await setup(undefined, false, { maxToolSteps: 2 })
    const plan = (first: string, second: string) => ({ name: 'todo_write', arguments: { todos: [{ content: 'Recall', status: first }, { content: 'Answer', status: second }] } })
    app.adapter.script.push(plan('in_progress', 'pending'), { name: 'memory_recall', arguments: { query: '' } }, { name: 'todo_write', arguments: { todos: [{ content: 'Recall', status: 'in_progress' }, { content: 'Answer', status: 'in_progress' }] } }, plan('completed', 'in_progress'))
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'plan this')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.error).toBeUndefined()
    expect(done.messages.at(-1)?.text).toBe('Tool completed.')
    const lists = done.messages.filter(message => message.todos).map(message => message.todos!.map(todo => todo.status))
    expect(lists).toEqual([['in_progress', 'pending'], ['completed', 'in_progress']])
    expect(done.messages.filter(message => message.role === 'tool').map(message => message.text)).toEqual(expect.arrayContaining([expect.stringContaining('"message":"Keep at most one todo in_progress"')]))
  })

  it('records how long the model reasoned before answering', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'THINK about it')
    const reply = (await settled(app.service, chat.conversation.id)).messages.at(-1)!
    expect(reply).toMatchObject({ role: 'assistant', text: 'Thought it through.', reasoning: 'Weighing it up.' })
    expect(reply.thinkingMs).toBeGreaterThanOrEqual(30)
    expect((await send(app.service, chat, 'hello').then(() => settled(app.service, chat.conversation.id))).messages.at(-1)).not.toHaveProperty('thinkingMs')
  })

  it('lists a chat once it holds a message and discards drafts left behind', async () => {
    const app = await setup()
    const left = await app.service.create({ temporary: false })
    const file = await app.service.upload({ conversationId: left.conversation.id, name: 'note.txt', base64: Buffer.from('DRAFT_FILE').toString('base64') })
    expect(await app.service.list({})).toEqual([])
    const next = await app.service.create({ temporary: false })
    await expect(app.service.get({ conversationId: left.conversation.id })).rejects.toThrow()
    expect(await diskText(app.path)).not.toContain('DRAFT_FILE')
    expect(file.id).toBeTruthy()
    await send(app.service, next, 'hello')
    await settled(app.service, next.conversation.id)
    expect((await app.service.list({})).map(item => item.id)).toEqual([next.conversation.id])
  })

  it('keeps a draft a page still shows', async () => {
    const app = await setup()
    const shown = await app.service.create({ temporary: false })
    const control = new AbortController()
    const watching = (async () => { for await (const _ of app.service.followConversation({ conversationId: shown.conversation.id }, control.signal)) { /* held open */ } })().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    await app.service.create({ temporary: false })
    expect((await app.service.get({ conversationId: shown.conversation.id })).conversation.id).toBe(shown.conversation.id)
    control.abort()
    await watching
  })
})

describe('memory summary', () => {
  /** Wait until no summary update is queued or running. */
  async function idle(service: PersonalChatService): Promise<MemorySummaryView> {
    for (let attempt = 0; attempt < 250; attempt++) {
      const { summary } = await service.memoryState({})
      if (!summary.updating) return summary
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('The summary update did not finish')
  }
  async function said(app: Awaited<ReturnType<typeof setup>>, detail: ConversationDetail, text: string): Promise<ConversationDetail> {
    await send(app.service, detail, text)
    return settled(app.service, detail.conversation.id)
  }
  const lastRequest = (app: Awaited<ReturnType<typeof setup>>) => JSON.stringify(app.adapter.requests.at(-1))

  it('is written from normal chats only and given to later normal chats', async () => {
    const app = await setup()
    let chat = await said(app, await app.service.create({ temporary: false }), 'I am building SUMMARY_FACT')
    const temporary = await said(app, await app.service.create({ temporary: true }), 'TEMP_ONLY')
    expect((await app.service.memoryState({})).summary).toMatchObject({ revision: 0, text: '', suggestions: [], updatedAt: 0, updating: false, sensitive: false, canUndo: false })
    expect((await app.service.refreshSummary({})).updating).toBe(true)
    const summary = await idle(app.service)
    expect(summary.text).toBe('You told me: I am building SUMMARY_FACT.')
    expect(summary.suggestions).toEqual(['Ask about I am building SUMMARY_FACT', 'Second', 'Third'])
    expect(summary.updatedAt).toBeGreaterThan(0)
    expect(summary.error).toBeUndefined()
    const request = app.adapter.requests.at(-1)!
    expect(request.system).toContain('You maintain a memory summary')
    expect(request.sessionId).toBeUndefined()
    expect(request.effort).toBe('high')
    expect(request.tools).toEqual([])
    const requests = app.adapter.requests.length
    await app.service.refreshSummary({})
    await idle(app.service)
    expect(app.adapter.requests).toHaveLength(requests)
    chat = await said(app, chat, 'next question')
    expect(lastRequest(app)).toContain('Memory summary, written from earlier chats')
    expect(lastRequest(app)).toContain('SUMMARY_FACT')
    await said(app, temporary, 'temporary question')
    expect(lastRequest(app)).not.toContain('SUMMARY_FACT')
    await expect(app.service.refreshSummary({ conversationId: temporary.conversation.id })).rejects.toThrow('Temporary Chat')
    await app.service.refreshSummary({})
    expect((await idle(app.service)).text).toBe('You told me: next question.\n\n## Earlier\nYou told me: I am building SUMMARY_FACT.')
  })

  it('saves typed text as written, keeps sections an update leaves out, and still removes credentials', async () => {
    const app = await setup()
    const chat = await said(app, await app.service.create({ temporary: false }), 'first fact')
    await app.service.refreshSummary({})
    const first = await idle(app.service)
    const typed = 'Pasted from elsewhere.\n\n## Notes\nMy own   wording, kept *exactly*.'
    const requests = app.adapter.requests.length
    const edited = await app.service.editSummary({ expectedRevision: first.revision, text: typed + '\n' })
    expect(edited).toMatchObject({ text: typed, revision: first.revision + 1, suggestions: first.suggestions, canUndo: true })
    expect(app.adapter.requests).toHaveLength(requests)
    await expect(app.service.editSummary({ expectedRevision: first.revision, text: 'stale' })).rejects.toThrow('The summary changed')
    const temporary = await said(app, await app.service.create({ temporary: true }), 'TEMP_ONLY')
    await expect(app.service.editSummary({ conversationId: temporary.conversation.id, expectedRevision: edited.revision, text: 'x' })).rejects.toThrow('Temporary Chat')
    await said(app, chat, 'second fact')
    await app.service.refreshSummary({})
    const updated = await idle(app.service)
    expect(updated.text).toBe('You told me: second fact.\n\n## Notes\nMy own   wording, kept *exactly*.\n\n## Earlier\nPasted from elsewhere.')
    const scrubbed = await app.service.editSummary({ expectedRevision: updated.revision, text: 'API key: sk-live-1\nCall 13800138000.' })
    expect(scrubbed.text).toBe('Call •••.')
    await expect(app.service.editSummary({ expectedRevision: scrubbed.revision, text: 'x'.repeat(16_001) })).rejects.toThrow('maxSummaryBytes')
    expect((await app.service.undoSummary({ expectedRevision: scrubbed.revision })).text).toBe(updated.text)
  })

  it('answers, corrects, undoes and clears on request, and survives a restart', async () => {
    const app = await setup()
    await said(app, await app.service.create({ temporary: false }), 'I like tea')
    await app.service.refreshSummary({})
    const summary = await idle(app.service)
    const asked = await app.service.askSummary({ text: 'QUESTION what do I like?' })
    expect(asked.reply).toBe('Answered from the summary.')
    expect(asked.summary.revision).toBe(summary.revision)
    const suggested = await app.service.askSummary({ text: 'QUESTION with suggestions' })
    expect(suggested.reply).toBe('Answered from the summary.')
    expect(suggested.summary).toMatchObject({ revision: summary.revision, suggestions: summary.suggestions })
    const changed = await app.service.askSummary({ text: 'Forget the tea' })
    expect(app.adapter.requests.at(-1)?.system).toContain('typed a message')
    expect(changed).toMatchObject({ reply: 'Changed.', summary: { text: 'EDITED: Forget the tea', suggestions: ['One', 'Two', 'Three'], canUndo: true } })
    const undone = await app.service.undoSummary({ expectedRevision: changed.summary.revision })
    expect(undone).toMatchObject({ text: summary.text, canUndo: false })
    await expect(app.service.undoSummary({ expectedRevision: changed.summary.revision })).rejects.toThrow('The summary changed')
    const cleared = await app.service.clearSummary({ expectedRevision: undone.revision })
    expect(cleared).toMatchObject({ text: '', suggestions: [], canUndo: true })
    const restored = await app.service.undoSummary({ expectedRevision: cleared.revision })
    expect(restored.text).toBe(summary.text)
    await app.ctx.fiber.dispose()
    resources.splice(resources.findIndex(item => item.ctx === app.ctx), 1)
    const again = await setup(app.path)
    expect((await again.service.memoryState({})).summary).toMatchObject({ text: summary.text, revision: restored.revision })
    await again.service.refreshSummary({})
    await idle(again.service)
    expect(again.adapter.requests).toHaveLength(0)
  })

  it('follows its options, and stays out of chats while referring to earlier chats is off', async () => {
    const app = await setup()
    const chat = await said(app, await app.service.create({ temporary: false }), 'I keep a diary')
    expect(await app.service.summaryOptions({ model: route, sensitive: true })).toMatchObject({ model: route, sensitive: true })
    await expect(app.service.summaryOptions({ model: { provider: 'fixture', model: 'missing' }, sensitive: false })).rejects.toThrow('not available')
    await app.service.refreshSummary({})
    expect((await idle(app.service)).text).toContain('diary')
    expect(app.adapter.requests.at(-1)?.system).toContain('may be kept')
    expect((await app.service.summaryOptions({ sensitive: false }))).not.toHaveProperty('model')
    const { profile } = await app.service.memoryState({})
    await app.service.updateProfile({ expectedRevision: profile.revision, background: '', instructions: '', autoSaveLowRisk: true, referenceChats: false })
    await expect(app.service.refreshSummary({})).rejects.toThrow('Turn on referencing')
    await expect(app.service.askSummary({ text: 'QUESTION' })).rejects.toThrow('Turn on referencing')
    await said(app, chat, 'another thing')
    expect(lastRequest(app)).not.toContain('Memory summary, written')
  })

  it('updates on its own once chats are quiet, at most every six hours', async () => {
    const app = await setup()
    const chat = await said(app, await app.service.create({ temporary: false }), 'first fact')
    const summaries = Reflect.get(app.service, 'summaries') as MemorySummaries
    const minutes = (count: number) => Date.now() + count * 60 * 1000
    summaries.tick(minutes(10))
    expect((await app.service.memoryState({})).summary.updating).toBe(false)
    summaries.tick(minutes(31))
    expect((await idle(app.service)).text).toBe('You told me: first fact.')
    await said(app, chat, 'second fact')
    const requests = app.adapter.requests.length
    summaries.tick(minutes(31))
    expect((await idle(app.service)).text).not.toContain('second fact')
    expect(app.adapter.requests).toHaveLength(requests)
    summaries.tick(minutes(7 * 60))
    expect((await idle(app.service)).text).toContain('second fact')
  })

  it('waits for a model instead of failing when no chat has picked one', async () => {
    const app = await setup()
    await said(app, await app.service.create({ temporary: false }), 'old fact')
    // Chats sent before the last route was remembered leave nothing to follow.
    const { chats } = app.service as unknown as { chats: { domain: { preferences: { set(value: { efforts: Record<string, never> }): Promise<void> } } } }
    await chats.domain.preferences.set({ efforts: {} })
    const summaries = Reflect.get(app.service, 'summaries') as MemorySummaries
    const later = () => Date.now() + 31 * 60 * 1000
    const requests = app.adapter.requests.length
    summaries.tick(later())
    expect((await idle(app.service)).error).toBeUndefined()
    expect(app.adapter.requests).toHaveLength(requests)
    await app.service.summaryOptions({ model: route, sensitive: false })
    summaries.tick(later())
    expect((await idle(app.service)).text).toBe('You told me: old fact.')
  })
})

/** Model requests for replies, without the Memory Summary's own. */
const chatRequests = (adapter: ScriptedModel) => adapter.requests.filter(request => !request.system?.startsWith('You maintain') && !request.system?.startsWith('You condense'))

describe('web search on demand', () => {
  const web = { search: async () => ({ sources: [], truncated: false }), fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 200, body: { kind: 'text', text: 'Page' }, truncated: false }) }
  it('is there for the model unasked, and only for picked messages once automatic use is off', async () => {
    const app = await setup()
    app.ctx.provide('web', web)
    let chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Hello')
    chat = await settled(app.service, chat.conversation.id)
    expect(chatRequests(app.adapter).at(-1)!.tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    expect((await app.service.updateApps({ webAuto: false })).web).toEqual({ available: true, auto: false })
    await send(app.service, chat, 'Again')
    chat = await settled(app.service, chat.conversation.id)
    expect(chatRequests(app.adapter).at(-1)!.tools).not.toContain('web_search')
    await send(app.service, chat, 'Search this', { web: true })
    chat = await settled(app.service, chat.conversation.id)
    const last = chatRequests(app.adapter).at(-1)!
    expect(last.tools).toContain('web_search')
    expect(JSON.stringify(last.messages)).toContain('[The user turned on web search for this message')
    expect(chat.messages.filter(message => message.role === 'user').at(-1)!.text).toBe('Search this')
  })
})

describe('a long tool chain', () => {
  const research = (adapter: ScriptedModel) => { adapter.follow = () => ({ name: 'memory_recall', arguments: { query: 'step ' + adapter.requests.length } }) }
  it('answers from what it gathered once the tool budget is spent', async () => {
    const app = await setup(undefined, false, { maxToolSteps: 3 })
    research(app.adapter)
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Research this thoroughly')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.error).toBeUndefined()
    expect(done.messages.filter(message => message.role === 'tool')).toHaveLength(3)
    expect(done.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Answered from what I found.' })
    const last = chatRequests(app.adapter).at(-1)!
    expect(last.system).toContain('used its tool budget')
    expect(last.tools).toContain('memory_recall')
  })
  it('runs nothing the model calls after its budget is spent, and keeps the history valid', async () => {
    const app = await setup(undefined, false, { maxToolSteps: 3 })
    research(app.adapter)
    app.adapter.ignoresBudget = true
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Research this thoroughly')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.error).toBe('tool-limit')
    expect(done.messages.filter(message => message.role === 'tool')).toHaveLength(3)
    expect(done.messages.at(-1)!.role).toBe('tool')
    expect(chatRequests(app.adapter)).toHaveLength(4)
  })
  it('clears the oldest results of a long reply to fit the context, instead of failing', async () => {
    const limit = 24 * 1024
    const app = await setup(undefined, false, { maxContextBytes: limit, maxAttachmentTextBytes: 6000 })
    app.ctx.provide('web', { search: async () => ({ sources: [], truncated: false }), fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 200, body: { kind: 'text', text: 'PAGE ' + request.url + ' ' + 'x'.repeat(5000) }, truncated: false }) })
    for (let page = 1; page <= 6; page++) app.adapter.script.push({ name: 'web_fetch', arguments: { url: 'https://example.com/' + page } })
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Read these pages')
    const done = await settled(app.service, chat.conversation.id)
    expect(done.error).toBeUndefined()
    expect(done.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Tool completed.' })
    const requests = chatRequests(app.adapter)
    for (const request of requests) expect(Buffer.byteLength(request.system ?? '') + Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThanOrEqual(limit)
    const sent = JSON.stringify(requests.at(-1)!.messages)
    expect(sent).toContain('PAGE https://example.com/6')
    expect(sent).not.toContain('PAGE https://example.com/1')
    expect(sent).toContain('cleared to fit')
    expect(done.messages.filter(message => message.role === 'tool').map(message => message.text).join()).toContain('PAGE https://example.com/1')
  })
})

describe('notes under a reply', () => {
  it('notes the memory a reply proposed, and the list marks the chat waiting until the person decides', async () => {
    const app = await setup()
    const chat = await app.service.create({ temporary: false })
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const changes: string[] = []
    void (async () => { for await (const change of app.service.follow(controller.signal)) changes.push(change.kind) })().catch(() => { /* Following ends when the test aborts it. */ })
    app.adapter.nextTool = { name: 'memory_propose', arguments: { text: 'I live in Paris', category: 'fact' } }
    await send(app.service, chat, 'Hello there')
    const done = await settled(app.service, chat.conversation.id)
    const candidate = (await app.service.memoryState({})).candidates.find(item => item.state === 'pending')!
    expect(done.messages.find(message => message.role === 'tool')!.proposed).toEqual([candidate.id])
    const row = async () => (await app.service.list({})).find(item => item.id === chat.conversation.id)!
    expect((await row()).activity).toBe('waiting')
    const before = changes.filter(kind => kind === 'catalog').length
    await app.service.decideCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision, decision: 'reject' })
    expect((await row()).activity).not.toBe('waiting')
    await vi.waitFor(() => expect(changes.filter(kind => kind === 'catalog').length).toBeGreaterThan(before))
  })

  it('notes Saved Memories given as context or looked up, and the chats a search found by their current titles', async () => {
    const app = await setup()
    const first = await app.service.create({ temporary: false })
    await send(app.service, first, 'Remember: I prefer concise answers')
    await settled(app.service, first.conversation.id)
    const saved = (await app.service.memoryState({})).memories[0]!
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Keep answers concise')
    let done = await settled(app.service, chat.conversation.id)
    expect(done.messages.at(-1)!.recalled).toEqual([saved.id])
    const lastTool = () => done.messages.filter(message => message.role === 'tool').at(-1)!
    app.adapter.nextTool = { name: 'memory_recall', arguments: { query: 'concise' } }
    await send(app.service, done, 'What do you know about me?')
    done = await settled(app.service, chat.conversation.id)
    expect(lastTool().recalled).toEqual([saved.id])
    await app.service.rename({ conversationId: first.conversation.id, title: 'Style notes' })
    app.adapter.nextTool = { name: 'search_chats', arguments: { query: 'concise answers' } }
    await send(app.service, done, 'Search')
    done = await settled(app.service, chat.conversation.id)
    expect(lastTool().referenced).toEqual([{ conversationId: first.conversation.id, title: 'Style notes' }])
    await app.service.deleteConversation({ conversationId: first.conversation.id })
    done = await app.service.get({ conversationId: chat.conversation.id })
    expect(lastTool().referenced).toEqual([])
  })
})

describe('automatic titles', () => {
  const titleRequests = (app: Awaited<ReturnType<typeof setup>>) => app.adapter.requests.filter(request => request.system?.startsWith('You title chats'))
  const conversation = async (app: Awaited<ReturnType<typeof setup>>, id: ConversationId) => (await app.service.get({ conversationId: id })).conversation

  it('titles a new chat once, from its first exchange, at the route’s least effort', async () => {
    const app = await setup(undefined, false, { autoTitles: true })
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Plan a weekend in Kyoto')
    const done = await settled(app.service, chat.conversation.id)
    await vi.waitFor(async () => expect(await conversation(app, chat.conversation.id)).toMatchObject({ title: 'Titled: Plan a weekend in Kyoto', titleSource: 'generated' }))
    expect(titleRequests(app)[0]!.effort).toBe('high')
    await send(app.service, await app.service.get({ conversationId: done.conversation.id }), 'And Osaka?')
    await settled(app.service, chat.conversation.id)
    expect(titleRequests(app)).toHaveLength(1)
  })

  it('keeps a rename made while the title is being written', async () => {
    const app = await setup(undefined, false, { autoTitles: true })
    let release!: () => void
    app.adapter.titleGate = new Promise(resolve => { release = resolve })
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'Plan a weekend in Kyoto')
    await settled(app.service, chat.conversation.id)
    await vi.waitFor(() => expect(titleRequests(app)).toHaveLength(1))
    await app.service.rename({ conversationId: chat.conversation.id, title: 'Kyoto' })
    release()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await conversation(app, chat.conversation.id)).toMatchObject({ title: 'Kyoto', titleSource: 'renamed' })
  })

  it('leaves alone a chat whose first reply did not finish, and Temporary Chat', async () => {
    const app = await setup(undefined, false, { autoTitles: true })
    const chat = await app.service.create({ temporary: false })
    await send(app.service, chat, 'WAIT for it')
    await app.service.stop({ conversationId: chat.conversation.id })
    await send(app.service, await app.service.get({ conversationId: chat.conversation.id }), 'Plan a weekend in Kyoto')
    await settled(app.service, chat.conversation.id)
    const temporary = await app.service.create({ temporary: true })
    await send(app.service, temporary, 'Plan a weekend in Kyoto')
    await settled(app.service, temporary.conversation.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(titleRequests(app)).toEqual([])
    expect((await conversation(app, chat.conversation.id)).title).toBe('WAIT for it')
  })
})
