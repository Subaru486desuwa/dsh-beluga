import { archiveView, parseConversation, PersonalChatError, type ParsedArchive } from './archive.ts'
import { Feed } from './feed.ts'
import { Lru } from './lru.ts'
import { proposingChats } from './memory.ts'
import { textOf, type ConversationRecord, type ToolNotes } from './records.ts'
import { todosOf } from './todos.ts'
import type { Config } from './config.ts'
import type { PersonalDomain } from './storage.ts'
import type { ModelRef } from '../shared/models.ts'
import type { GitHubTool } from './github-contract.ts'
import type { ArchiveRevisionId, ArchiveSelection, BranchId, ChatActivity, ChatAttachment, ChatUpdate, Conversation, ConversationDetail, ConversationId, LiveTurn, MemoryId, PendingAction, PersonalChange, WebSource } from '../shared/types.ts'

/** Bounds the parsed imports held in memory, counted in nodes. */
const CACHED_ARCHIVE_NODES = 20000
/** Chats the list marks: turns that ended while no one had them open, and memory proposals waiting for the person. */
export interface ListMarks {
  readonly unseen: ReadonlySet<ConversationId>
  readonly proposing: ReadonlySet<ConversationId>
}
export interface RunningTurn {
  /** Notes for the result of the tool call being run, stored with that result. */
  pendingNotes?: { readonly callId: string; readonly notes: ToolNotes }
  /** This reply read Work sessions, so it proposes nothing to memory from here on. */
  readWork?: boolean
  /** Saved Memories given to this turn as context, noted on its reply. */
  recalled: readonly MemoryId[]
  pendingDocument?: { callId: string; id: string; name: string; bytes: Uint8Array; artifact: NonNullable<ChatAttachment["artifact"]> }
  /** The GitHub action waiting for the person, and how their answer reaches the turn. */
  approval?: { readonly action: PendingAction; decide(allow: boolean): void }
  /** GitHub as this turn found it: the account and the tools it offers. */
  github?: { readonly account: string; readonly tools: readonly GitHubTool[] }
  readonly id: string
  readonly branchId: BranchId
  readonly userId: string
  readonly model: ModelRef
  /** What the person picked for this message from the tools menu. */
  readonly chosen: { readonly web: boolean; readonly github: boolean }
  /** GitHub tools the model has loaded on this branch, by the server's names. */
  readonly githubTools: Set<string>
  readonly controller: AbortController
  readonly sources: WebSource[]
  text: string
  reasoning: string
  tool?: string
  /** When the current model step's request started, by the Host clock. */
  stepStarted: number
  done: Promise<void>
  settled(): void
}

/**
 * The shared state of every chat: which conversations exist, what is running and who is
 * listening. All durable writes pass through {@link Conversations.serial}; Temporary Chat
 * stays in this object's memory and never reaches the store.
 */
export class Conversations {
  readonly temporary = new Map<ConversationId, ConversationRecord>()
  readonly running = new Map<ConversationId, RunningTurn>()
  readonly deleting = new Set<ConversationId>()
  readonly changes = new Feed<PersonalChange>()
  readonly temporarySeen = new Map<ConversationId, number>()
  private readonly archives = new Lru<ArchiveRevisionId, ParsedArchive>(CACHED_ARCHIVE_NODES, archive => archive.nodes.length)
  private readonly feeds = new Map<ConversationId, Feed<ChatUpdate>>()
  private writes: Promise<unknown> = Promise.resolve()
  closing = false

  constructor(private readonly config: Config, readonly domain: PersonalDomain) {}
  /** Stop every turn and finish queued writes; afterwards only shutdown writes are accepted. */
  async drain(): Promise<void> {
    this.closing = true
    for (const turn of this.running.values()) turn.controller.abort()
    await Promise.allSettled([...this.running.values()].map(turn => turn.done))
    await this.writes
    this.changes.close()
    for (const feed of this.feeds.values()) feed.close()
  }
  async close(): Promise<void> {
    this.temporary.clear()
    await this.domain.close()
  }
  /** End a conversation's live feed after it is removed. */
  closeFeed(id: ConversationId): void {
    this.feeds.get(id)?.publish({ kind: 'closed' })
    this.feeds.get(id)?.close()
    this.feeds.delete(id)
  }
  listening(id: ConversationId): boolean { return (this.feeds.get(id)?.subscriberCount ?? 0) > 0 }
  forgetArchive(id: ArchiveRevisionId): void { this.archives.delete(id) }
  serial<T>(operation: () => Promise<T>, allowClosing = false): Promise<T> {
    const pending = this.writes.then(() => { if (this.closing && !allowClosing) throw new PersonalChatError('unavailable', 'Personal Chat is shutting down'); return operation() })
    this.writes = pending.catch(() => { /* Each caller receives its failure; storage rejects quarantined access. */ })
    return pending
  }
  changed(kind: 'catalog' | 'memory' | 'imports', conversationId?: ConversationId): void {
    this.changes.publish({ kind, ...(conversationId ? { conversationId } : {}) })
    const feed = conversationId && this.feeds.get(conversationId)
    if (!feed || !feed.subscriberCount || this.deleting.has(conversationId!)) return
    const record = this.raw(conversationId!)
    if (record) feed.publish({ kind: 'snapshot', detail: this.detail(this.hydrate(record.conversation)) })
  }
  feed(id: ConversationId): Feed<ChatUpdate> {
    let feed = this.feeds.get(id)
    if (!feed) { feed = new Feed(); this.feeds.set(id, feed) }
    return feed
  }
  /** @returns whether someone follows this chat now. */
  following(id: ConversationId): boolean { return (this.feeds.get(id)?.subscriberCount ?? 0) > 0 }
  /** @returns what the list marks, read once per listing. */
  marks(): ListMarks {
    return { unseen: new Set(this.domain.unseen.get()), proposing: proposingChats(this.domain.global.get().candidates) }
  }
  /**
   * A running turn ranks first, then memory proposals waiting for the person, then a reply no one has seen.
   * @param marks - what the list marks, from {@link marks}.
   * @returns how much this chat needs the person now.
   */
  activity(id: ConversationId, marks: ListMarks): ChatActivity {
    const turn = this.running.get(id)
    if (turn) return turn.approval ? 'waiting' : 'running'
    return marks.proposing.has(id) ? 'waiting' : marks.unseen.has(id) ? 'replied' : 'idle'
  }
  /** Record that a chat's last turn ended while no one had it open, or that someone opened it, and tell the list. */
  async markUnseen(id: ConversationId, unseen: boolean): Promise<void> {
    const ids = this.domain.unseen.get()
    if (ids.includes(id) === unseen) return
    await this.domain.unseen.set(unseen ? [...ids, id] : ids.filter(item => item !== id))
    this.changes.publish({ kind: 'catalog' })
  }
  raw(id: ConversationId): ConversationRecord | undefined { return this.temporary.get(id) ?? this.domain.conversation(id) }
  record(id: ConversationId): ConversationRecord {
    const record = this.raw(id)
    if (!record || record.deleting || this.deleting.has(id)) throw new PersonalChatError('not-found', 'Conversation is unavailable')
    if (record.conversation.temporary) this.temporarySeen.set(id, Date.now())
    return record
  }
  async saveRecord(record: ConversationRecord, notify = true): Promise<void> {
    const { conversation } = record
    if (conversation.temporary) this.temporary.set(conversation.id, structuredClone(record))
    else this.domain.saveConversation(record)
    if (notify) this.changed('catalog', conversation.id)
  }
  async saveConversation(conversation: Conversation, notify = true): Promise<void> {
    const current = this.raw(conversation.id)
    await this.saveRecord({ ...(current ?? { entries: [], attachments: [] }), conversation }, notify)
  }
  /** Commit and withdrawal are atomic, so a revision is visible exactly while its row exists. */
  visibleRevision(id: ArchiveRevisionId): boolean { return this.domain.hasArchive(id) }
  hydrate(conversation: Conversation): Conversation {
    const archiveRevisions = conversation.archiveRevisions.filter(id => this.visibleRevision(id))
    const selectedBranch = conversation.branches.find(branch => branch.id === conversation.selectedBranchId)
    const withdrawn = selectedBranch?.archive !== undefined && !this.visibleRevision(selectedBranch.archive.revisionId)
    const selectedArchive = withdrawn ? undefined : conversation.selectedArchive && this.visibleRevision(conversation.selectedArchive.revisionId)
      ? conversation.selectedArchive : archiveRevisions.length ? this.defaultSelection(archiveRevisions.at(-1)!) : undefined
    const { selectedArchive: _old, ...base } = conversation
    return { ...base, archiveRevisions, ...(selectedArchive ? { selectedArchive } : {}), archiveWithdrawn: conversation.branches.some(branch => branch.archive !== undefined && !this.visibleRevision(branch.archive.revisionId)) }
  }
  find(id: ConversationId): Conversation {
    const value = this.hydrate(this.record(id).conversation)
    if (!value.branches.length && !value.archiveRevisions.length) throw new PersonalChatError('not-found', 'Imported conversation was withdrawn')
    return value
  }
  private defaultSelection(id: ArchiveRevisionId): ArchiveSelection { return { revisionId: id, nodeId: this.readArchive(id).currentNode } }
  readArchive(id: ArchiveRevisionId): ParsedArchive {
    if (!this.visibleRevision(id)) throw new PersonalChatError('archive-unavailable', 'Archive revision was withdrawn or deleted')
    let archive = this.archives.get(id)
    if (!archive) {
      archive = parseConversation(this.domain.archive(id)!.original, 0, this.config.maxNodes)
      this.archives.set(id, archive)
    }
    return archive
  }
  detail(conversation: Conversation): ConversationDetail {
    const record = this.record(conversation.id)
    const branch = conversation.branches.find(item => item.id === conversation.selectedBranchId)
    const entries = new Map(record.entries.map(entry => [entry.id, entry]))
    const referenced = (branch?.messageIds ?? []).flatMap(id => entries.get(id)?.referenced ?? [])
    const titles = referenced.length ? this.domain.titles(referenced) : new Map<ConversationId, string>()
    const messages = (branch?.messageIds ?? []).map(id => {
      const entry = entries.get(id)
      if (!entry) throw new PersonalChatError('invalid-storage', 'A branch refers to an unavailable message')
      const role = entry.message.role
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') throw new PersonalChatError('invalid-storage', 'Unsupported chat message role')
      const reasoning = entry.message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
      const todos = todosOf(entry.message)
      return { id, role, text: entry.userText ?? textOf(entry.message), ...(reasoning ? { reasoning } : {}), ...(entry.thinkingMs === undefined ? {} : { thinkingMs: entry.thinkingMs }), time: entry.time, attachmentIds: entry.attachmentIds, toolNames: entry.message.content.filter(block => block.type === 'tool-call').map(block => block.name), ...(todos ? { todos } : {}), ...(entry.sources ? { sources: entry.sources } : {}), ...(entry.proposed ? { proposed: entry.proposed } : {}), ...(entry.recalled ? { recalled: entry.recalled } : {}),
        ...(entry.referenced ? { referenced: entry.referenced.flatMap(conversationId => { const title = titles.get(conversationId); return title === undefined ? [] : [{ conversationId, title }] }) } : {}), ...(entry.work ? { work: entry.work } : {}) }
    })
    const running = this.running.get(conversation.id)
    const live: LiveTurn | undefined = running && running.branchId === branch?.id ? { id: running.id, branchId: running.branchId, text: running.text, reasoning: running.reasoning, stepElapsedMs: Math.max(0, Date.now() - running.stepStarted), ...(running.tool ? { tool: running.tool } : {}), ...(running.approval ? { approval: running.approval.action } : {}) } : undefined
    return { conversation, messages, attachments: record.attachments, ...(live ? { live } : {}), ...(record.model ? { model: record.model } : {}), ...((record.error || (record.running && !running)) ? { error: record.error ?? 'interrupted' } : {}), ...(conversation.selectedArchive ? { archive: archiveView(this.readArchive(conversation.selectedArchive.revisionId), conversation.selectedArchive.revisionId, conversation.selectedArchive.nodeId) } : {}) }
  }
  idle(id: ConversationId): void {
    if (this.running.has(id)) throw new PersonalChatError('busy', 'Stop the current response before changing branches')
  }
  ownedAsset(record: ConversationRecord, id: string): ChatAttachment {
    const attachment = record.attachments.find(item => item.id === id && item.conversationId === record.conversation.id)
    if (!attachment) throw new PersonalChatError('attachment-forbidden', 'This attachment does not belong to the current chat')
    return attachment
  }
}
