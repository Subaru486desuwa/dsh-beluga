import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PersonalModel } from '../src/client/model.ts'
import type { PersonalChatOperations, ConversationDetail, ConversationId, ArchiveRevisionId, BranchId, MemoryState, ChatUpdate, PersonalChange } from '../src/shared/types.ts'

const route = { provider: 'fixture', model: 'echo', name: 'Fixture', images: false }
const id = brandString<ConversationId>('11111111-1111-4111-8111-111111111111')
const revisionId = brandString<ArchiveRevisionId>('22222222-2222-4222-8222-222222222222')
const branchId = brandString<BranchId>('33333333-3333-4333-8333-333333333333')
const initial: ConversationDetail = { conversation: { id, title: 'Imported', temporary: false, archived: false, createdAt: 1, updatedAt: 1, branches: [], archiveRevisions: [revisionId], selectedArchive: { revisionId, nodeId: 'source-node' }, archiveWithdrawn: false }, messages: [], attachments: [] }
const memory: MemoryState = { profile: { revision: 0, background: '', instructions: '', autoSaveLowRisk: true, referenceChats: true, updatedAt: 0 }, memories: [], candidates: [] }
async function wait(signal: AbortSignal): Promise<void> { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) }
const models: PersonalModel[] = []
afterEach(async () => { for (const model of models.splice(0)) await model.dispose() })
describe('client delivery recovery', () => {
  it('reuses the original submission id and archive target after a lost response', async () => {
    let detail = initial
    const sends: Parameters<PersonalChatOperations['send']>[0][] = []
    const api = {
      limits: async () => ({ uploadBytes: 1000, attachmentBytes: 1000, profileBytes: 1000 }),
      models: async () => [route],
      list: async () => [detail.conversation],
      get: async () => detail,
      memoryState: async () => memory,
      async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> { yield { kind: 'baseline' }; await wait(signal) },
      async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> { yield { kind: 'snapshot', detail }; await wait(signal) },
      send: async (request: Parameters<PersonalChatOperations['send']>[0]) => {
        sends.push(request)
        detail = { ...initial, conversation: { ...initial.conversation, branches: [{ id: branchId, messageIds: [], createdAt: 2, archive: initial.conversation.selectedArchive }], selectedBranchId: branchId } }
        if (sends.length === 1) throw new Error('Response connection lost')
        return detail
      },
    } as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.start(); await model.open(id)
    expect(await model.run(() => model.send('continue', []))).toBe(false)
    await model.open(id)
    expect(await model.run(() => model.send('continue', []))).toBe(true)
    expect(sends[0]!.requestId).toBe(sends[1]!.requestId)
    expect(sends[1]!.archive).toEqual(initial.conversation.selectedArchive)
    expect(sends[1]!.branchId).toBeUndefined()
  })
  it('does not rewind streamed text when an older unary send receipt arrives later', async () => {
    const branch = { id: branchId, messageIds: ['new-user'], createdAt: 2 }
    const message = { id: 'new-user', role: 'user' as const, text: 'hello', time: 2, attachmentIds: [], toolNames: [] }
    const receipt: ConversationDetail = { ...initial, conversation: { ...initial.conversation, branches: [branch], selectedBranchId: branchId }, messages: [message], live: { id: 'turn', branchId, text: '', reasoning: '', stepElapsedMs: 0 } }
    let deliver!: () => void
    const ready = new Promise<void>(resolve => { deliver = resolve })
    const api = {
      limits: async () => ({ uploadBytes: 1000, attachmentBytes: 1000, profileBytes: 1000 }),
      models: async () => [route], list: async () => [initial.conversation], get: async () => initial, memoryState: async () => memory,
      async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> { await wait(signal) },
      async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> {
        yield { kind: 'snapshot', detail: initial }; await ready
        yield { kind: 'snapshot', detail: receipt }
        yield { kind: 'delta', turnId: 'turn', text: 'Already streamed prefix', reasoning: false }
        await wait(signal)
      },
      send: async () => { deliver(); await sleep(5); return receipt },
    } as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.start(); await model.open(id); await model.send('hello', [])
    expect(model.state.getSnapshot().detail?.live?.text).toBe('Already streamed prefix')
  })

  describe.each([
    ['pinning', (model: PersonalModel) => model.pin(true), { pinned: true }],
    ['renaming', (model: PersonalModel) => model.rename('New title'), { title: 'New title' }],
  ] as const)('%s while a reply finishes', (_name, act, expected) => {
    const reply = { id: 'reply', role: 'assistant' as const, text: 'Finished reply', time: 3, attachmentIds: [], toolNames: [] }
    const finished: ConversationDetail = { ...initial, messages: [reply] }
    function harness() {
      let deliver!: () => void
      const ready = new Promise<void>(resolve => { deliver = resolve })
      const changed = async () => { deliver(); await sleep(5); return { ...initial.conversation, ...expected } }
      const api = {
        limits: async () => ({ uploadBytes: 1000, attachmentBytes: 1000, profileBytes: 1000 }),
        models: async () => [route], list: async () => [initial.conversation], get: async () => initial, memoryState: async () => memory,
        async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> { await wait(signal) },
        async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> {
          yield { kind: 'snapshot', detail: initial }; await ready
          yield { kind: 'snapshot', detail: finished }
          await wait(signal)
        },
        setPinned: changed, rename: changed,
      } as unknown as PersonalChatOperations
      return new PersonalModel(api)
    }
    it('keeps the reply and shows the change', async () => {
      const model = harness(); models.push(model)
      await model.start(); await model.open(id)
      await act(model)
      const detail = model.state.getSnapshot().detail!
      expect(detail.messages).toEqual([reply])
      expect(detail.conversation).toMatchObject(expected)
    })
  })
  it('announces a proposed memory as pending rather than saved', async () => {
    const api = { proposeMemory: async () => ({ state: 'pending' }), memoryState: async () => memory } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.proposeMemory('Reviewed text', 'fact', { kind: 'manual' })
    expect(model.state.getSnapshot().notice?.key).toBe('candidatePending')
  })

  it('offers Undo in a notice only for a memory another chat saved on its own', async () => {
    const other = brandString<ConversationId>('44444444-4444-4444-8444-444444444444')
    const open: ConversationDetail = { ...initial, conversation: { ...initial.conversation, archiveRevisions: [], archiveWithdrawn: false } }
    const savedBy = (conversationId: ConversationId, n: number) => ({ ...memory, memories: [{ id: 'm' + n, state: 'active', text: 'Fact ' + n }], candidates: [{ id: 'k' + n, state: 'saved', memoryId: 'm' + n, reason: 'low-risk', source: { kind: 'chat', conversationId, messageId: 'u' } }] }) as unknown as MemoryState
    let state = memory
    const api = { get: async () => open, memoryState: async () => state, async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> { yield { kind: 'snapshot', detail: open }; await wait(signal) } } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.open(id)
    state = savedBy(id, 1)
    await model.refreshMemory(true)
    expect(model.state.getSnapshot().notice).toBeUndefined()
    state = savedBy(other, 2)
    await model.refreshMemory(true)
    expect(model.state.getSnapshot().notice).toMatchObject({ key: 'memoryUpdated', undo: { id: 'm2' } })
  })

  it('reads the catalog once for a burst of typing', async () => {
    const reads: { query?: string; archived?: boolean }[] = []
    const api = { list: async (request: { query?: string; archived?: boolean }) => { reads.push(request); return [] } } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    const typing = ['a', 'ab', 'abc'].map(query => model.search(query))
    expect(model.state.getSnapshot().query).toBe('abc')
    expect(reads).toEqual([])
    await Promise.all(typing)
    expect(reads).toEqual([{ query: 'abc' }])
  })

  it('shows a Settings page at once, loads Data controls, and keeps the archived list current', async () => {
    const archived = { id: 'old' as ConversationId, title: 'Old', updatedAt: 1, pinned: false, archived: true, activity: 'idle' as const }
    let stored = [archived]
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const api = {
      listImports: async () => { await gate; return [] },
      list: async (request: { archived?: boolean }) => request.archived ? stored : [],
      setArchived: async (request: { conversationId: ConversationId; archived: boolean }) => { calls.push(`archive:${request.conversationId}:${request.archived}`); stored = [] },
      deleteConversation: async (request: { conversationId: ConversationId }) => { calls.push(`delete:${request.conversationId}`) },
    } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    const opening = model.openSettings('data')
    expect(model.state.getSnapshot()).toMatchObject({ settings: 'data', archivedChats: undefined })
    release()
    await opening
    expect(model.state.getSnapshot().archivedChats).toEqual([archived])
    await model.setArchived(archived.id, false)
    expect(model.state.getSnapshot().archivedChats).toEqual([])
    await model.remove(archived.id)
    expect(calls).toEqual(['archive:old:false', 'delete:old'])
    model.closeSettings()
    expect(model.state.getSnapshot().settings).toBeUndefined()
  })

  it('leaves memory and data unloaded when Settings opens during a Temporary Chat', async () => {
    const temporary = { ...initial, conversation: { ...initial.conversation, temporary: true } }
    const read = vi.fn(async () => [])
    const api = { get: async () => temporary, async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> { await wait(signal) }, memoryState: read, listImports: read, list: read } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.open(id)
    await model.openSettings('personalization')
    await model.openSettings('data')
    expect(model.state.getSnapshot().settings).toBe('data')
    expect(read).not.toHaveBeenCalled()
  })

  it('folds a burst of changes into one trailing catalog read', async () => {
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const api = {
      limits: async () => ({ uploadBytes: 1000, attachmentBytes: 1000, profileBytes: 1000 }), models: async () => [route],
      list: async () => { reads++; if (reads === 2) await gate; return [] },
      async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> {
        yield { kind: 'baseline' }
        for (let index = 0; index < 20; index++) yield { kind: 'catalog' }
        release()
        await wait(signal)
      },
    } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    await model.start()
    await sleep(50)
    expect(reads).toBe(3)
    expect(model.state.getSnapshot().status).toBe('ready')
  })

  it('shows the actionable message from a Remote failure object', async () => {
    const model = new PersonalModel({} as PersonalChatOperations); models.push(model)
    expect(await model.run(async () => { throw { code: 'personal-chat/failed', message: 'Select the inline image model before sending images', details: { reason: 'image-route-required' } } })).toBe(false)
    expect(model.state.getSnapshot().notice?.detail).toBe('Select the inline image model before sending images')
  })

})

describe('starting a chat and choosing a route', () => {
  const reasoning = { provider: 'fixture', model: 'think', name: 'Think', images: false, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high', effort: 'low', lastUsed: true as const }
  const setup = () => {
    const creates: { temporary: boolean }[] = []
    const sends: Parameters<PersonalChatOperations['send']>[0][] = []
    const created = (temporary: boolean): ConversationDetail => ({ ...initial, conversation: { ...initial.conversation, temporary, archiveRevisions: [], selectedArchive: undefined as never, branches: [{ id: branchId, messageIds: [], createdAt: 1 }], selectedBranchId: branchId } })
    let current = created(false)
    const api = {
      limits: async () => ({ uploadBytes: 1000, attachmentBytes: 1000, profileBytes: 1000 }),
      models: async () => [route, reasoning], list: async () => [], get: async () => current, memoryState: async () => memory,
      async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> { await wait(signal) },
      async *followConversation(_request: unknown, signal: AbortSignal): AsyncIterable<ChatUpdate> { await wait(signal) },
      create: async (request: { temporary: boolean }) => { creates.push(request); current = created(request.temporary); return current },
      send: async (request: Parameters<PersonalChatOperations['send']>[0]) => { sends.push(request); return current },
      closeTemporary: async () => {},
    } as unknown as PersonalChatOperations
    const model = new PersonalModel(api); models.push(model)
    return { model, creates, sends }
  }
  it('saves nothing until the first message, then sends with the route and effort last used', async () => {
    const { model, creates, sends } = setup()
    await model.start()
    expect(model.state.getSnapshot().selectedModel).toEqual({ provider: 'fixture', model: 'think', effort: 'low' })
    await model.run(() => model.create(false))
    expect(creates).toEqual([])
    expect(model.state.getSnapshot().detail).toBeUndefined()
    expect(await model.run(() => model.send('hello', []))).toBe(true)
    expect(creates).toEqual([{ temporary: false }])
    expect(sends[0]!.model).toEqual({ provider: 'fixture', model: 'think', effort: 'low' })
  })
  it('keeps each route’s own effort while switching between routes', async () => {
    const { model } = setup()
    await model.start()
    model.chooseEffort('high')
    model.chooseModel(route)
    expect(model.state.getSnapshot().selectedModel).toEqual({ provider: 'fixture', model: 'echo' })
    model.chooseModel(reasoning)
    expect(model.state.getSnapshot().selectedModel).toEqual({ provider: 'fixture', model: 'think', effort: 'high' })
  })
  it('starts a temporary chat on its first message, and does not make it the next default', async () => {
    const { model, creates } = setup()
    await model.start()
    await model.run(() => model.create(true))
    model.chooseModel(route)
    expect(await model.run(() => model.send('secret', []))).toBe(true)
    expect(creates).toEqual([{ temporary: true }])
    await model.run(() => model.create(false))
    expect(model.state.getSnapshot().selectedModel).toEqual({ provider: 'fixture', model: 'think', effort: 'low' })
  })
})
