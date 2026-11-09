import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { PersonalChatError } from './archive.ts'
import { Lru } from './lru.ts'
import { normalized } from './memory.ts'
import { pacing } from './pacing.ts'
import { appSettings, archiveRecord, chatEntry, consistent, conversationHead, importBatch, memoryLedger, modelPreferences, summaryRecord, textOf, type AppSettings, type ArchiveRecord, type ConversationRecord, type MemoryLedger, type ModelPreferences, type SummaryRecord } from './records.ts'
import type * as T from '../shared/types.ts'

const VERSION = 5
/** Statements that lift a database from the version they are keyed by to the next one. */
const UPGRADES: Readonly<Record<number, string>> = {
  2: 'ALTER TABLE personal_chat_conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;',
  3: 'DROP TABLE personal_chat_documents;',
  // A chat appears in the list once it holds a message or an import; empty drafts stay out.
  4: 'UPDATE personal_chat_conversations SET listed=0 WHERE listed=1 AND pending=0 AND NOT EXISTS (SELECT 1 FROM personal_chat_entries e WHERE e.conversation_id=personal_chat_conversations.id) AND NOT EXISTS (SELECT 1 FROM personal_chat_archives a WHERE a.conversation_id=personal_chat_conversations.id);',
}
/** Bounds the assembled conversations held in memory, counted in entries. */
const CACHED_ENTRIES = 20000
/**
 * Rows read between yields while scanning search text. Search scans a normalized copy of the
 * text instead of using FTS5: on natural text a trigram index measured five times the text
 * size, and removing one 4 KiB document without leaving postings behind took over a second.
 */
const SCAN_WINDOW = 64
/** Bounds what one search of earlier chats can place in a model request. */
const EXCERPT_CHATS = 8
const EXCERPT_CHARS = 400
const SCHEMA = `
CREATE TABLE personal_chat_meta(version INTEGER NOT NULL);
INSERT INTO personal_chat_meta(version) VALUES(${VERSION});
CREATE TABLE personal_chat_records(kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE personal_chat_conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, title_key TEXT NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL, listed INTEGER NOT NULL, pending INTEGER NOT NULL, value TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE personal_chat_entries(conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(conversation_id,seq));
CREATE TABLE personal_chat_archives(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX personal_chat_archive_batch ON personal_chat_archives(batch_id);
CREATE INDEX personal_chat_archive_owner ON personal_chat_archives(conversation_id);
CREATE INDEX personal_chat_archive_source ON personal_chat_archives(source_id);
CREATE TABLE personal_chat_search_text(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, revision_id TEXT, text TEXT NOT NULL);
CREATE INDEX personal_chat_search_owner ON personal_chat_search_text(conversation_id);
CREATE INDEX personal_chat_search_revision ON personal_chat_search_text(revision_id) WHERE revision_id IS NOT NULL;
`

interface Table<K extends string, V> {
  get(key: K): V | undefined
  entries(): [K, V][]
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
}
const initial: MemoryLedger = { profile: { revision: 0, background: '', instructions: '', autoSaveLowRisk: true, referenceChats: true, updatedAt: 0 }, memories: [], candidates: [], suppressed: [] }
/** Tools are there when the model needs them. */
const defaultApps: AppSettings = { webAuto: true }
const emptySummary: SummaryRecord = { revision: 0, text: '', suggestions: [], updatedAt: 0, history: [], progress: {}, collectedAt: 0, lastRunAt: 0, sensitive: false }
/** One match in an earlier chat, for the model to quote. */
export interface ChatExcerpt { readonly conversationId: T.ConversationId; readonly title: string; readonly updatedAt: number; readonly excerpt: string }
/** The statements needed to reach this version; a database they cannot lift is left untouched. */
function upgradesFrom(version: number): string {
  let statements = ''
  for (let step = version; step !== VERSION; step++) {
    const upgrade = UPGRADES[step]
    if (!upgrade) throw new PersonalChatError('storage-version', 'This plugin cannot read the stored data version')
    statements += upgrade
  }
  return statements
}
function decode<V>(schema: z.ZodType<V>, value: unknown): V {
  try { return schema.parse(JSON.parse(String(value))) }
  catch { throw new PersonalChatError('invalid-storage', 'A stored personal record cannot be decoded; restore a valid backup before continuing') }
}

/** One private database and writer lease; it never touches Harness Session storage. */
export class PersonalStore {
  private compromised = false
  private closed = false
  private readonly statements = new Map<string, StatementSync>()
  private readonly records = new Lru<T.ConversationId, ConversationRecord>(CACHED_ENTRIES, record => record.entries.length + 1)
  readonly batches: Table<T.ImportBatchId, T.ImportBatch>
  readonly global: { get(): MemoryLedger; set(value: MemoryLedger): Promise<void> }
  readonly preferences: { get(): ModelPreferences; set(value: ModelPreferences): Promise<void> }
  readonly summary: { get(): SummaryRecord; set(value: SummaryRecord): Promise<void> }
  readonly apps: { get(): AppSettings; set(value: AppSettings): Promise<void> }
  /** Chats whose last turn ended while no one had them open, until someone opens them. */
  readonly unseen: { get(): readonly T.ConversationId[]; set(value: readonly T.ConversationId[]): Promise<void> }
  private constructor(private readonly db: DatabaseSync, private readonly release: () => Promise<void>) {
    this.batches = this.makeTable('batches', importBatch, value => value.id)
    const globals = this.makeTable<string, MemoryLedger>('global', memoryLedger)
    this.global = { get: () => globals.get('memory') ?? structuredClone(initial), set: value => globals.put('memory', value) }
    const preferences = this.makeTable<string, ModelPreferences>('preferences', modelPreferences)
    this.preferences = { get: () => preferences.get('model') ?? { efforts: {} }, set: value => preferences.put('model', value) }
    const summaries = this.makeTable<string, SummaryRecord>('summary', summaryRecord)
    this.summary = { get: () => summaries.get('memory') ?? structuredClone(emptySummary), set: value => summaries.put('memory', value) }
    const apps = this.makeTable<string, AppSettings>('apps', appSettings)
    this.apps = { get: () => apps.get('settings') ?? defaultApps, set: value => apps.put('settings', value) }
    const unseen = this.makeTable<string, readonly T.ConversationId[]>('unseen', z.array(z.string().transform(brandString<T.ConversationId>)))
    this.unseen = { get: () => unseen.get('replies') ?? [], set: value => unseen.put('replies', value) }
  }
  /** Listed chats changed at or after `time`, oldest change first; running and deleting ones wait. */
  changedSince(time: number): T.ConversationId[] {
    this.available()
    return this.sql('SELECT id FROM personal_chat_conversations WHERE listed=1 AND pending=0 AND updated_at>=? ORDER BY updated_at').all(time).map(row => String(row.id) as T.ConversationId)
  }
  static async open(directory: string): Promise<PersonalStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = await realpath(directory)
    let store: PersonalStore | undefined
    const release = await lockfile.lock(path, { realpath: false, stale: 30000, update: 10000, retries: 0, onCompromised: () => { if (store) store.compromised = true } })
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(path, 'personal-chat.sqlite3'))
      db.exec('PRAGMA busy_timeout=5000')
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (tables.length && !tables.some(row => row.name === 'personal_chat_meta')) throw new PersonalChatError('invalid-storage', 'The configured database belongs to another application')
      const upgrade = tables.length ? upgradesFrom(Number(db.prepare('SELECT version FROM personal_chat_meta').get()?.version)) : ''
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      if (!tables.length) db.exec('BEGIN IMMEDIATE;' + SCHEMA + 'COMMIT;')
      if (upgrade) db.exec(`BEGIN IMMEDIATE;${upgrade}UPDATE personal_chat_meta SET version=${VERSION};COMMIT;`)
      store = new PersonalStore(db, release)
      return store
    } catch (error) { db?.close(); await release(); throw error }
  }
  private available(): void {
    if (this.closed || this.compromised) throw new PersonalChatError('storage-unavailable', 'Personal Chat storage is closed or its writer lease was lost')
  }
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement) }
    return statement
  }
  private makeTable<K extends string, V>(kind: string, schema: z.ZodType<V>, keyOf?: (value: V) => string): Table<K, V> {
    const read = (key: string, value: unknown): V => {
      const result = decode(schema, value)
      if (keyOf && keyOf(result) !== key) throw new PersonalChatError('invalid-storage', 'A stored personal record cannot be decoded; restore a valid backup before continuing')
      return result
    }
    return {
      get: key => { this.available(); const row = this.sql('SELECT value FROM personal_chat_records WHERE kind=? AND id=?').get(kind, key); return row ? read(key, row.value) : undefined },
      entries: () => { this.available(); return this.sql('SELECT id,value FROM personal_chat_records WHERE kind=?').all(kind).map(row => [String(row.id) as K, read(String(row.id), row.value)]) },
      put: async (key, value) => { this.available(); const valid = schema.parse(value); if (keyOf && keyOf(valid) !== key) throw new PersonalChatError('invalid-storage', 'Record identity does not match its storage key'); this.sql('INSERT INTO personal_chat_records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, key, JSON.stringify(valid)) },
      delete: async key => { this.available(); return Number(this.sql('DELETE FROM personal_chat_records WHERE kind=? AND id=?').run(kind, key).changes) > 0 },
    }
  }
  /** Read one conversation; decoding happens once, then it is served from memory until evicted. */
  conversation(id: T.ConversationId): ConversationRecord | undefined {
    this.available()
    const cached = this.records.get(id)
    if (cached) return cached
    const row = this.sql('SELECT value FROM personal_chat_conversations WHERE id=?').get(id)
    if (!row) return undefined
    const entries = this.sql('SELECT value FROM personal_chat_entries WHERE conversation_id=? ORDER BY seq').all(id).map(item => decode(chatEntry, item.value))
    const record: ConversationRecord = { ...decode(conversationHead, row.value), entries }
    if (record.conversation.id !== id || !consistent(record)) throw new PersonalChatError('invalid-storage', 'A stored conversation has inconsistent identities or references')
    this.records.set(id, record)
    return record
  }
  /**
   * Store one conversation by appending its new entries; earlier rows are
   * never rewritten, so the cost of a save does not grow with the length of the history.
   * @param value - the full record; its entries must extend the stored ones.
   * @throws PersonalChatError when the write would lose stored history.
   */
  saveConversation(value: ConversationRecord): void {
    this.available()
    const { entries, ...rest } = value
    const id = rest.conversation.id
    const stored = this.conversation(id)
    const known = stored?.entries ?? []
    if (entries.length < known.length || (known.length > 0 && entries[known.length - 1]!.id !== known.at(-1)!.id)) throw new PersonalChatError('invalid-storage', 'This write would lose stored history')
    const added = entries.slice(known.length).map(entry => chatEntry.parse(entry))
    const head = conversationHead.parse(rest)
    const record: ConversationRecord = { ...head, entries: [...known, ...added] }
    if (!consistent(record)) throw new PersonalChatError('invalid-storage', 'Conversation identities or owned references are inconsistent')
    const { title, updatedAt, archived, pinned, archiveRevisions } = head.conversation
    this.atomic(() => {
      this.sql('INSERT INTO personal_chat_conversations(id,title,title_key,updated_at,archived,listed,pending,value,pinned) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_key=excluded.title_key,updated_at=excluded.updated_at,archived=excluded.archived,listed=excluded.listed,pending=excluded.pending,value=excluded.value,pinned=excluded.pinned')
        .run(id, title, normalized(title), updatedAt, archived ? 1 : 0, !head.deleting && (record.entries.length > 0 || archiveRevisions.length > 0) ? 1 : 0, head.deleting || head.running ? 1 : 0, JSON.stringify(head), pinned ? 1 : 0)
      for (const [offset, entry] of added.entries()) {
        this.sql('INSERT INTO personal_chat_entries(conversation_id,seq,value) VALUES(?,?,?)').run(id, known.length + offset, JSON.stringify(entry))
        // Tool output is not conversation: it can quote web pages, or a memory forgotten later.
        if (entry.message.role !== 'tool') this.index(id, null, normalized(entry.userText ?? textOf(entry.message)))
      }
    })
    this.records.set(id, record)
  }
  /**
   * @param ids - chats a reply referenced.
   * @returns the current titles of those still in the list, archived ones included.
   */
  titles(ids: readonly T.ConversationId[]): Map<T.ConversationId, string> {
    this.available()
    const found = new Map<T.ConversationId, string>()
    for (const id of new Set(ids)) {
      const row = this.sql('SELECT title FROM personal_chat_conversations WHERE id=? AND listed=1').get(id)
      if (row) found.set(id, String(row.title))
    }
    return found
  }
  /** Remove a conversation with everything derived from it, including its search text. */
  removeConversation(id: T.ConversationId): void {
    this.available()
    this.atomic(() => {
      for (const table of ['entries', 'archives', 'search_text']) this.sql(`DELETE FROM personal_chat_${table} WHERE conversation_id=?`).run(id)
      this.sql('DELETE FROM personal_chat_conversations WHERE id=?').run(id)
    })
    this.records.delete(id)
  }
  /** Conversations a previous run left mid-turn or mid-delete. */
  /** Saved chats that never received a message or an import, such as a new chat left before sending. */
  drafts(): T.ConversationId[] {
    this.available()
    return this.sql('SELECT id FROM personal_chat_conversations WHERE listed=0 AND pending=0').all().map(row => brandString<T.ConversationId>(String(row.id)))
  }
  interrupted(): T.ConversationId[] {
    this.available()
    return this.sql('SELECT id FROM personal_chat_conversations WHERE pending=1').all().map(row => brandString<T.ConversationId>(String(row.id)))
  }
  /**
   * List conversations from plain columns, without decoding any conversation.
   * @param filter - `query` is a substring of a title, a message or an imported node. `archived: true` lists only archived chats; otherwise unarchived chats, plus archived ones a non-empty query matches.
   * @returns matching summaries, pinned ones first, then newest first.
   */
  async catalog(filter: { readonly query: string; readonly archived: boolean }): Promise<Omit<T.ConversationSummary, 'activity'>[]> {
    this.available()
    const query = normalized(filter.query)
    const containing = query ? await this.containing(query) : undefined
    this.available()
    const archived = filter.archived ? 'AND archived=1' : query ? '' : 'AND archived=0'
    return this.sql(`SELECT id,title,title_key,updated_at,pinned,archived FROM personal_chat_conversations WHERE listed=1 ${archived} ORDER BY pinned DESC, updated_at DESC`).all()
      .filter(row => !containing || containing.has(String(row.id)) || String(row.title_key).includes(query))
      .map(row => ({ id: brandString<T.ConversationId>(String(row.id)), title: String(row.title), updatedAt: Number(row.updated_at), pinned: row.pinned === 1, archived: row.archived === 1 }))
  }
  /**
   * Find what earlier chats said, most recent first, for one model tool call.
   * Imported history stays out: it reaches a model only when the user continues it.
   * @param query - a substring of a message.
   * @param asking - the chat that is asking; its own text is already in context.
   * @returns one excerpt from each matching chat, archived ones included, up to {@link EXCERPT_CHATS}.
   */
  async excerpts(query: string, asking: T.ConversationId): Promise<ChatExcerpt[]> {
    const needle = normalized(query)
    const found = new Map<string, ChatExcerpt>()
    const pause = pacing()
    let high = Number(this.sql('SELECT COALESCE(MAX(id),0) AS id FROM personal_chat_search_text').get()!.id)
    while (high > 0 && found.size < EXCERPT_CHATS) {
      this.available()
      const rows = this.sql('SELECT s.conversation_id AS id,c.title,c.updated_at,substr(s.text,MAX(instr(s.text,?)-?,1),?) AS excerpt FROM personal_chat_search_text s JOIN personal_chat_conversations c ON c.id=s.conversation_id WHERE s.id>? AND s.id<=? AND s.revision_id IS NULL AND instr(s.text,?)>0 AND c.listed=1 AND c.id<>? ORDER BY s.id DESC').all(needle, EXCERPT_CHARS / 2, EXCERPT_CHARS, high - SCAN_WINDOW, high, needle, asking)
      for (const row of rows) {
        const conversationId = brandString<T.ConversationId>(String(row.id))
        if (!found.has(conversationId) && found.size < EXCERPT_CHATS) found.set(conversationId, { conversationId, title: String(row.title), updatedAt: Number(row.updated_at), excerpt: String(row.excerpt) })
      }
      high -= SCAN_WINDOW
      await pause()
    }
    return [...found.values()]
  }
  /** Scan in windows so a large history never holds the Host for a whole search. */
  private async containing(query: string): Promise<Set<string>> {
    const found = new Set<string>()
    const last = Number(this.sql('SELECT COALESCE(MAX(id),0) AS id FROM personal_chat_search_text').get()!.id)
    const pause = pacing()
    for (let low = 0; low < last; low += SCAN_WINDOW) {
      this.available()
      for (const row of this.sql('SELECT DISTINCT conversation_id FROM personal_chat_search_text WHERE id>? AND id<=? AND instr(text,?)>0').all(low, low + SCAN_WINDOW, query)) found.add(String(row.conversation_id))
      await pause()
    }
    return found
  }
  private index(conversationId: T.ConversationId, revisionId: T.ArchiveRevisionId | null, text: string): void {
    if (text) this.sql('INSERT INTO personal_chat_search_text(conversation_id,revision_id,text) VALUES(?,?,?)').run(conversationId, revisionId, text)
  }
  archive(id: T.ArchiveRevisionId): ArchiveRecord | undefined {
    this.available()
    const row = this.sql('SELECT value FROM personal_chat_archives WHERE id=?').get(id)
    return row ? decode(archiveRecord, row.value) : undefined
  }
  hasArchive(id: T.ArchiveRevisionId): boolean { this.available(); return this.sql('SELECT 1 FROM personal_chat_archives WHERE id=?').get(id) !== undefined }
  /**
   * Store one imported revision.
   * @param searchText - normalized node text, each node on its own line, so a search never matches across nodes.
   */
  saveArchive(value: ArchiveRecord, searchText: string): void {
    this.available()
    const record = archiveRecord.parse(value)
    this.atomic(() => {
      this.sql('INSERT INTO personal_chat_archives(id,batch_id,conversation_id,source_id,value) VALUES(?,?,?,?,?)').run(record.id, record.batchId, record.conversationId, record.sourceId, JSON.stringify(record))
      this.index(record.conversationId, record.id, searchText)
    })
  }
  removeArchive(id: T.ArchiveRevisionId): void {
    this.available()
    this.atomic(() => {
      this.sql('DELETE FROM personal_chat_search_text WHERE revision_id=?').run(id)
      this.sql('DELETE FROM personal_chat_archives WHERE id=?').run(id)
    })
  }
  archivesForSource(sourceId: string): ArchiveRecord[] {
    this.available()
    return this.sql('SELECT value FROM personal_chat_archives WHERE source_id=?').all(sourceId).map(row => decode(archiveRecord, row.value))
  }
  archiveOwners(batchId: T.ImportBatchId): T.ConversationId[] {
    this.available()
    return this.sql('SELECT DISTINCT conversation_id FROM personal_chat_archives WHERE batch_id=?').all(batchId).map(row => brandString<T.ConversationId>(String(row.conversation_id)))
  }
  /** Conversations with a branch that continued from any of these revisions. */
  continuationsOf(revisionIds: readonly T.ArchiveRevisionId[]): T.ConversationId[] {
    this.available()
    return this.sql("SELECT DISTINCT c.id FROM personal_chat_conversations c, json_each(c.value,'$.conversation.branches') b WHERE json_extract(b.value,'$.archive.revisionId') IN (SELECT value FROM json_each(?))").all(JSON.stringify(revisionIds)).map(row => brandString<T.ConversationId>(String(row.id)))
  }
  archiveBytes(): number {
    this.available()
    return Number(this.sql('SELECT COALESCE(SUM(octet_length(value)),0) AS bytes FROM personal_chat_archives').get()!.bytes)
  }
  private atomic(operation: () => void): void {
    if (this.db.isTransaction) { operation(); return }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  /**
   * Run one serialized multi-row change as a single atomic commit. Autocommit costs one
   * fsync per row under synchronous=FULL, which stalls the Host on bulk writes.
   * @param operation - writes to apply; a rejection rolls all of them back.
   * @returns the operation result once durably committed.
   */
  async transaction<R>(operation: () => Promise<R>): Promise<R> {
    this.available()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      this.records.clear()
      throw error
    }
  }
  checkpoint(): void { this.available(); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.records.clear()
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close() }
    finally { await this.release() }
  }
}
export type PersonalDomain = PersonalStore
