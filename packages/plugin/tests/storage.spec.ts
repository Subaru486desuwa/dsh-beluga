import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PersonalStore } from '../src/host/storage.ts'
import type { ChatEntry, ConversationRecord } from '../src/host/records.ts'
import type { ArchiveRevisionId, BranchId, ConversationId, ImportBatch, ImportBatchId } from '../src/shared/types.ts'

const owned: { store: PersonalStore; path: string }[] = []
afterEach(async () => { for (const { store, path } of owned.splice(0)) { await store.close(); await rm(path, { recursive: true, force: true }) } })
async function open(path?: string) {
  const directory = path ?? await mkdtemp(join(tmpdir(), 'personal-chat-storage-'))
  const store = await PersonalStore.open(directory)
  owned.push({ store, path: directory })
  return store
}
const pathOf = (store: PersonalStore) => owned.find(item => item.store === store)!.path
function batch(): ImportBatch {
  return { id: randomUUID() as ImportBatchId, fileName: 'synthetic.json', createdAt: 1, state: 'committed', revisionIds: [], skipped: 0 }
}
function entry(text: string): ChatEntry {
  const id = randomUUID()
  return { id, time: 1, attachmentIds: [], message: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } as ChatEntry
}
function chat(entries: readonly ChatEntry[] = [], title = 'Chat', overrides: Partial<ConversationRecord['conversation']> = {}): ConversationRecord {
  const branch = randomUUID() as BranchId
  return { entries, attachments: [], conversation: { id: randomUUID() as ConversationId, title, temporary: false, archived: false, createdAt: 1, updatedAt: 1, branches: [{ id: branch, messageIds: entries.map(item => item.id), createdAt: 1 }], selectedBranchId: branch, archiveRevisions: [], archiveWithdrawn: false, ...overrides } }
}
function appended(record: ConversationRecord, ...added: readonly ChatEntry[]): ConversationRecord {
  const [branch] = record.conversation.branches
  return { ...record, entries: [...record.entries, ...added], conversation: { ...record.conversation, branches: [{ ...branch!, messageIds: [...branch!.messageIds, ...added.map(item => item.id)] }] } }
}
async function diskBytes(path: string): Promise<Buffer> {
  const parts: Buffer[] = []
  for (const item of await readdir(path, { withFileTypes: true })) if (item.isFile()) parts.push(await readFile(join(path, item.name)))
  return Buffer.concat(parts)
}

describe('multi-row transactions', () => {
  it('commits every row together and returns the operation result', async () => {
    const store = await open()
    const [first, second] = [batch(), batch()]
    const result = await store.transaction(async () => {
      await store.batches.put(first.id, first)
      await store.batches.put(second.id, second)
      return 'done'
    })
    expect(result).toBe('done')
    expect(store.batches.get(first.id)).toEqual(first)
    expect(store.batches.get(second.id)).toEqual(second)
  })
  it('rolls every row back, keeps the failure, and leaves the store writable', async () => {
    const store = await open()
    const [failed, next] = [batch(), batch()]
    await expect(store.transaction(async () => {
      await store.batches.put(failed.id, failed)
      throw new Error('disk full')
    })).rejects.toThrow('disk full')
    expect(store.batches.get(failed.id)).toBeUndefined()
    await store.transaction(() => store.batches.put(next.id, next))
    expect(store.batches.get(next.id)).toEqual(next)
  })
})

describe('conversation rows', () => {
  it('keeps the conversation row small as its history grows', async () => {
    const store = await open()
    let record = chat([entry('x'.repeat(4096))])
    store.saveConversation(record)
    for (let index = 0; index < 50; index++) { record = appended(record, entry('x'.repeat(4096))); store.saveConversation(record) }
    const db = new DatabaseSync(join(pathOf(store), 'personal-chat.sqlite3'), { readOnly: true })
    const row = db.prepare('SELECT length(value) AS bytes FROM personal_chat_conversations').get()!
    const entries = db.prepare('SELECT count(*) AS rows FROM personal_chat_entries').get()!
    db.close()
    expect(entries.rows).toBe(51)
    expect(Number(row.bytes)).toBeLessThan(8192)
  })
  it('reads the same record back from disk', async () => {
    const store = await open()
    const first = entry('first')
    const record: ConversationRecord = { ...appended(chat([first]), entry('second')), omittedMessages: 3, documents: { [randomUUID()]: { title: 'Plan', blocks: [{ kind: 'paragraph', text: 'Body' }] } } }
    store.saveConversation(record)
    await store.close()
    const again = (await open(pathOf(store))).conversation(record.conversation.id)
    expect(again?.entries.map(item => item.id)).toEqual(record.entries.map(item => item.id))
    expect(again?.omittedMessages).toBe(3)
    expect(again?.documents).toEqual(record.documents)
    expect(again?.conversation).toEqual(record.conversation)
  })
  it('refuses a write that would lose stored entries', async () => {
    const store = await open()
    const record = chat([entry('kept')])
    store.saveConversation(record)
    const stale = appended(chat([], 'Chat', { id: record.conversation.id }), entry('other'))
    expect(() => store.saveConversation(stale)).toThrow('history')
    expect(() => store.saveConversation({ ...record, entries: [], conversation: { ...record.conversation, branches: [] } })).toThrow('history')
    expect(store.conversation(record.conversation.id)?.entries).toHaveLength(1)
  })
  it('rejects references the record does not own and never stores a temporary chat', async () => {
    const store = await open()
    const record = chat([entry('kept')])
    const [branch] = record.conversation.branches
    expect(() => store.saveConversation({ ...record, conversation: { ...record.conversation, branches: [{ ...branch!, messageIds: ['missing'] }] } })).toThrow()
    expect(() => store.saveConversation({ ...record, conversation: { ...record.conversation, temporary: true } })).toThrow()
    expect(store.conversation(record.conversation.id)).toBeUndefined()
  })
  it('serves the committed state after a rollback', async () => {
    const store = await open()
    const record = chat([entry('committed')])
    store.saveConversation(record)
    await expect(store.transaction(async () => {
      store.saveConversation(appended(record, entry('rolled back')))
      store.saveConversation(chat([entry('rolled back too')]))
      throw new Error('disk full')
    })).rejects.toThrow('disk full')
    expect(store.conversation(record.conversation.id)?.entries).toHaveLength(1)
    expect(await store.catalog({ query: 'rolled', archived: false })).toEqual([])
    store.saveConversation(appended(record, entry('after')))
    expect(store.conversation(record.conversation.id)?.entries).toHaveLength(2)
  })
  it('finds conversations left mid-turn or mid-delete', async () => {
    const store = await open()
    const [idle, running, deleting] = [chat(), { ...chat(), running: true }, { ...chat(), deleting: true }]
    for (const record of [idle, running, deleting]) store.saveConversation(record)
    expect(store.interrupted().sort()).toEqual([running.conversation.id, deleting.conversation.id].sort())
  })
})

describe('catalog', () => {
  it('returns light summaries, newest first, and hides what the UI must not show', async () => {
    const store = await open()
    const older = chat([], 'Older', { updatedAt: 10 })
    const newer = chat([], 'Newer', { updatedAt: 20 })
    const archived = chat([], 'Archived', { updatedAt: 30, archived: true })
    const empty = chat([], 'Withdrawn', { updatedAt: 40, branches: [] })
    delete (empty.conversation as { selectedBranchId?: BranchId }).selectedBranchId
    const deleting = { ...chat([], 'Deleting', { updatedAt: 50 }), deleting: true }
    for (const record of [older, newer, archived, empty, deleting]) store.saveConversation(record)
    expect(await store.catalog({ query: '', archived: false })).toEqual([
      { id: newer.conversation.id, title: 'Newer', updatedAt: 20 },
      { id: older.conversation.id, title: 'Older', updatedAt: 10 },
    ])
    expect((await store.catalog({ query: '', archived: true })).map(item => item.title)).toEqual(['Archived'])
  })
  it('matches text the way a substring search does', async () => {
    const store = await open()
    store.saveConversation(chat([entry('Alpha 搜索 目标 say "hi" 100% a_b')], 'first'))
    store.saveConversation(chat([entry('nothing related')], 'Second TITLE'))
    const hits = async (query: string) => (await store.catalog({ query, archived: false })).map(item => item.title)
    expect(await hits('ALPHA 搜索')).toEqual(['first'])
    expect(await hits('lph')).toEqual(['first'])
    expect(await hits('搜索')).toEqual(['first'])
    expect(await hits('Ａｌｐｈａ')).toEqual(['first'])
    expect(await hits('"hi"')).toEqual(['first'])
    expect(await hits('"')).toEqual(['first'])
    expect(await hits('100%')).toEqual(['first'])
    expect(await hits('%')).toEqual(['first'])
    expect(await hits('a_b')).toEqual(['first'])
    expect(await hits('title')).toEqual(['Second TITLE'])
    expect(await hits('ti')).toEqual(['Second TITLE'])
    expect(await hits('a\0b')).toEqual([])
    expect(await hits('a*')).toEqual([])
    expect(await hits('NEAR(alpha')).toEqual([])
    expect(await hits('zzz')).toEqual([])
  })
  it('indexes archive text under its owner and drops it with the revision', async () => {
    const store = await open()
    const owner = chat([], 'Imported')
    store.saveConversation(owner)
    const id = randomUUID() as ArchiveRevisionId
    const batchId = randomUUID() as ImportBatchId
    store.saveArchive({ id, batchId, conversationId: owner.conversation.id, sourceId: 'source', original: { keep: true } }, 'archived words')
    expect(store.hasArchive(id)).toBe(true)
    expect(store.archive(id)?.original).toEqual({ keep: true })
    expect(store.archivesForSource('source').map(item => item.id)).toEqual([id])
    expect(store.archiveOwners(batchId)).toEqual([owner.conversation.id])
    expect((await store.catalog({ query: 'archived w', archived: false })).map(item => item.title)).toEqual(['Imported'])
    store.removeArchive(id)
    expect(store.hasArchive(id)).toBe(false)
    expect(store.archiveBytes()).toBe(0)
    expect(await store.catalog({ query: 'archived w', archived: false })).toEqual([])
  })
  it('names the conversations continuing from withdrawn revisions', async () => {
    const store = await open()
    const revision = randomUUID() as ArchiveRevisionId
    const record = chat()
    const [branch] = record.conversation.branches
    const continued = { ...record, conversation: { ...record.conversation, branches: [{ ...branch!, archive: { revisionId: revision, nodeId: 'n' } }] } }
    store.saveConversation(continued)
    store.saveConversation(chat())
    expect(store.continuationsOf([revision])).toEqual([record.conversation.id])
    expect(store.continuationsOf([randomUUID() as ArchiveRevisionId])).toEqual([])
  })
})

describe('deleted text', () => {
  const canary = '㐀㐁㐂㐃㐄㐅㐆㐇 deletecanary'
  it('leaves no trace in the index or on disk', async () => {
    const store = await open()
    const removed = chat([entry(canary)], 'Removed')
    store.saveConversation(removed)
    store.saveConversation(chat([entry('kept words')], 'Kept'))
    store.checkpoint()
    expect((await diskBytes(pathOf(store))).includes(Buffer.from('㐁㐂'))).toBe(true)
    store.removeConversation(removed.conversation.id)
    store.checkpoint()
    const disk = await diskBytes(pathOf(store))
    expect(disk.includes(Buffer.from('㐁㐂'))).toBe(false)
    expect(disk.includes(Buffer.from('deletecanary'))).toBe(false)
    expect(store.conversation(removed.conversation.id)).toBeUndefined()
    expect(await store.catalog({ query: '㐁㐂㐃', archived: false })).toEqual([])
    expect((await store.catalog({ query: 'kept wo', archived: false })).map(item => item.title)).toEqual(['Kept'])
  })
  it('leaves no trace of a withdrawn archive', async () => {
    const store = await open()
    const owner = chat()
    store.saveConversation(owner)
    const id = randomUUID() as ArchiveRevisionId
    store.saveArchive({ id, batchId: randomUUID() as ImportBatchId, conversationId: owner.conversation.id, sourceId: 's', original: { text: canary } }, canary)
    store.removeArchive(id)
    store.checkpoint()
    const disk = await diskBytes(pathOf(store))
    expect(disk.includes(Buffer.from('㐁㐂'))).toBe(false)
    expect(disk.includes(Buffer.from('deletecanary'))).toBe(false)
  })
})

describe('stored versions', () => {
  it('refuses an older database and leaves it untouched', async () => {
    const path = await mkdtemp(join(tmpdir(), 'personal-chat-storage-'))
    const file = join(path, 'personal-chat.sqlite3')
    const old = new DatabaseSync(file)
    old.exec('CREATE TABLE personal_chat_meta(version INTEGER NOT NULL); INSERT INTO personal_chat_meta(version) VALUES(1); CREATE TABLE personal_chat_records(kind TEXT, id TEXT, value TEXT)')
    old.close()
    await expect(PersonalStore.open(path)).rejects.toMatchObject({ reason: 'storage-version' })
    const check = new DatabaseSync(file, { readOnly: true })
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name)
    check.close()
    await rm(path, { recursive: true, force: true })
    expect(names).toEqual(['personal_chat_meta', 'personal_chat_records'])
  })
  it('refuses a database that belongs to another application', async () => {
    const path = await mkdtemp(join(tmpdir(), 'personal-chat-storage-'))
    const foreign = new DatabaseSync(join(path, 'personal-chat.sqlite3'))
    foreign.exec('CREATE TABLE someone_else(value TEXT)')
    foreign.close()
    await expect(PersonalStore.open(path)).rejects.toMatchObject({ reason: 'invalid-storage' })
    await rm(path, { recursive: true, force: true })
  })
})
