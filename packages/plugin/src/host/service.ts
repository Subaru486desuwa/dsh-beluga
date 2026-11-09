import { randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-web'
import { archiveSnapshot, archiveView, PersonalChatError } from './archive.ts'
import { Config } from './config.ts'
import { Conversations, type RunningTurn } from './conversations.ts'
import { Imports } from './imports.ts'
import { PersonalMemory } from './personal-memory.ts'
import { MemorySummaries, SUMMARY_CHECK_MS } from './memory-summary.ts'
import { Condenser } from './condense.ts'
import { Titles } from './titles.ts'
import { HandOff } from './handoff.ts'
import { offerMemoryLookup } from './work-memory.ts'
import { PersonalStore } from './storage.ts'
import { textOf, type ChatEntry, type ConversationRecord } from './records.ts'
import { Turns } from './turns.ts'
import { Apps } from './apps.ts'
import { AssetRepository } from './assets.ts'
import { decodeBase64 } from './base64.ts'
import { ModelBridge } from './model-bridge.ts'
import { routeKey, sameRoute, type ModelChoice, type ModelRef } from '../shared/models.ts'
import type { AppsChange, AppsView, ArchiveRevisionId, ArchiveSelection, BranchId, BranchRequest, CandidateId, CandidateInput, ChatBranch, Conversation, ConversationDetail, ConversationId, ConversationSummary, OfficePreview, UploadLimits, ImportBatch, ImportBatchId, ImportPreview, ImportPreviewId, ImportResult, ImportUndoResult, Memory, MemoryCandidate, MemoryId, MemoryState, MemorySummaryView, PersonalChatOperations, PersonalProfile, ProfileImportSource, ChatAttachment, ChatUpdate, PersonalChange, WorkspaceRef } from '../shared/types.ts'
export type * from '../shared/types.ts'

/** The kit gives up at 60 s per operation; this also covers the wait for a turn behind it. */
const RENDER_TIMEOUT_MS = 180000
export type * from '../shared/models.ts'
export { Config } from './config.ts'

declare module '@deepseek-ai/cordis' { interface Context { personalChat: PersonalChatService } }
const uuid = <T extends Branded<string>>() => brandString<T>(randomUUID())

/** One plugin owns Chat lifetimes; no operation creates or edits a Work Session. */
export class PersonalChatService extends TypertRemoteService implements PersonalChatOperations {
  static inject = ['llm']
  static Config = Config
  readonly config: Config
  private readonly bridge: ModelBridge
  private readonly assets: AssetRepository
  private chats!: Conversations
  private memory!: PersonalMemory
  private summaries!: MemorySummaries
  private imports!: Imports
  private turns!: Turns
  /** Web search, connected apps and Work crossings; the Remote method `apps` reports them. */
  private integrations!: Apps
  private handOffs!: HandOff

  constructor(ctx: Context, config: Config) {
    super(ctx, 'personalChat', { namespace: 'personalChat' })
    this.config = Config(config)
    if (!isAbsolute(this.config.dataDir)) throw new PersonalChatError('invalid-config', 'dataDir must be an absolute private data directory')
    this.bridge = new ModelBridge(ctx, this.config.inlineProvider)
    this.assets = new AssetRepository(join(this.config.dataDir, 'attachments'), this.config, () => this.ctx.get('personalChatOffice'))
  }
  protected async [Service.init](): Promise<void> {
    const chats = this.chats = new Conversations(this.config, await PersonalStore.open(this.config.dataDir))
    this.memory = new PersonalMemory(chats, this.config)
    const summaries = this.summaries = new MemorySummaries(chats, this.bridge, this.config)
    this.imports = new Imports(chats, this.config)
    const apps = this.integrations = new Apps(this.ctx, chats.domain, this.config)
    const condenser = new Condenser(chats, this.bridge, this.config, message => this.ctx.logger.warn(message))
    const titles = new Titles(chats, this.bridge, this.config, message => this.ctx.logger.warn(message))
    const handOffs = this.handOffs = new HandOff(chats, this.bridge, this.config)
    this.turns = new Turns(this.ctx, chats, this.memory, summaries, this.assets, this.bridge, apps, condenser, titles, apps.work, this.config)
    // Work agents exist only where the profile runs them; the tool follows those services and the setting (ADR 0006).
    const memory = this.memory
    this.ctx.inject(['tools', 'agents'], scope => { offerMemoryLookup(scope, { saved: query => memory.saved(query), summary: () => summaries.current() }, this.config.maxWorkBytes, () => apps.settings().workMemory, listener => apps.watch(listener)) })
    this.ctx.effect(() => async () => {
      await chats.drain()
      this.imports.clear()
      this.assets.clearTemporary()
      await chats.close()
    })
    await this.assets.initialize()
    for (const id of chats.domain.interrupted()) {
      const record = chats.domain.conversation(id)!
      if (record.deleting) await this.cleanupConversation(id, record)
      else chats.domain.saveConversation({ ...record, running: false, error: 'interrupted' })
    }
    await this.imports.recover()
    const interval = setInterval(() => {
      for (const [id, seen] of chats.temporarySeen) if (!chats.listening(id) && Date.now() - seen > this.config.temporaryIdleMs) {
        void this.closeTemporary({ conversationId: id }).catch(() => { /* A subsequent expiry pass retries a failed close. */ })
      }
    }, Math.min(60000, this.config.temporaryIdleMs))
    interval.unref()
    this.ctx.effect(() => () => clearInterval(interval))
    const summaryCheck = setInterval(() => { summaries.tick() }, SUMMARY_CHECK_MS)
    summaryCheck.unref()
    this.ctx.effect(() => () => { clearInterval(summaryCheck); summaries.dispose(); condenser.dispose(); titles.dispose(); handOffs.dispose() })
  }
  private owner(): void {
    if (this.chats.closing) throw new PersonalChatError('unavailable', 'Personal Chat is shutting down')
    if (principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('personal-chat/forbidden', 'Personal Chat is restricted to the Host owner', {})
  }
  /** Effective upload limits, without provider configuration or credentials. */
  @Remote async limits(): Promise<UploadLimits> { this.owner(); return { office: !!this.ctx.get('personalChatOffice'), uploadBytes: this.config.maxUploadBytes, archiveBytes: this.config.maxArchiveBytes, zipEntries: this.config.maxZipEntries, attachmentBytes: this.config.maxAttachmentBytes, profileBytes: this.config.maxProfileBytes } }
  /** Configured Harness models, plus any explicitly configured inline image models, each with the effort last sent with it. */
  @Remote async models(): Promise<readonly ModelChoice[]> {
    this.owner()
    const { last, efforts } = this.chats.domain.preferences.get()
    return (await this.bridge.models()).map(choice => {
      const effort = efforts[routeKey(choice)]
      return { ...choice, ...(effort !== undefined && choice.efforts?.some(item => item.id === effort) ? { effort } : {}), ...(last && sameRoute(last, choice) ? { lastUsed: true as const } : {}) }
    })
  }
  /**
   * List plugin histories only. Temporary conversations are never added to history.
   * @param request - `archived: true` lists only archived chats; otherwise unarchived chats, plus archived ones a non-empty `query` matches.
   * @returns matching summaries, pinned ones first, then newest first.
   */
  @Remote async list(request: { readonly query?: string; readonly archived?: boolean }): Promise<readonly ConversationSummary[]> {
    this.owner()
    const marks = this.chats.marks()
    return (await this.chats.domain.catalog({ query: request.query ?? '', archived: request.archived ?? false })).map(item => ({ ...item, activity: this.chats.activity(item.id, marks) }))
  }
  /** Create a plugin conversation with immutable retention and no Work side effects. */
  @Remote async create(request: { readonly temporary: boolean }): Promise<ConversationDetail> {
    this.owner()
    return this.chats.serial(async () => {
      await this.discardDrafts()
      const now = Date.now()
      const branch: ChatBranch = { id: uuid<BranchId>(), messageIds: [], createdAt: now }
      const conversation: Conversation = { id: uuid<ConversationId>(), title: '', temporary: request.temporary, archived: false, createdAt: now, updatedAt: now, branches: [branch], selectedBranchId: branch.id, archiveRevisions: [], archiveWithdrawn: false }
      await this.chats.saveConversation(conversation)
      return this.chats.detail(conversation)
    })
  }
  /**
   * A chat is saved on creation so files can be attached before the first message, but only
   * listed once it holds one. Remove the ones left before sending, with their files, unless a
   * page still shows them.
   */
  private async discardDrafts(): Promise<void> {
    for (const id of this.chats.domain.drafts()) {
      const record = this.chats.raw(id)
      if (!record || record.entries.length || record.conversation.archiveRevisions.length || record.conversation.branches.some(branch => branch.archive) || this.chats.running.has(id) || this.chats.listening(id)) continue
      await this.cleanupConversation(id, record)
    }
  }
  /** Read the selected source branch and plugin-owned messages. */
  @Remote async get(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail> { this.owner(); return this.chats.detail(this.chats.find(request.conversationId)) }
  /** Change the title without touching Work or other branches. */
  @Remote async rename(request: { readonly conversationId: ConversationId; readonly title: string }): Promise<Conversation> {
    this.owner()
    const title = request.title.trim()
    if (!title || Buffer.byteLength(title) > 500) throw new PersonalChatError('invalid-title', 'Title must be 1–500 UTF-8 bytes')
    return this.chats.serial(async () => { const current = this.chats.find(request.conversationId); const changed = { ...current, title, titleSource: 'renamed' as const, updatedAt: Date.now() }; await this.chats.saveConversation(changed); return changed })
  }
  /** Archive is reversible and is distinct from deletion. */
  @Remote async setArchived(request: { readonly conversationId: ConversationId; readonly archived: boolean }): Promise<Conversation> {
    this.owner()
    await this.stop({ conversationId: request.conversationId })
    return this.chats.serial(async () => {
      const current = this.chats.find(request.conversationId)
      if (current.temporary) throw new PersonalChatError('temporary-operation', 'Temporary Chat cannot be archived')
      const value = { ...current, archived: request.archived, updatedAt: Date.now() }
      await this.chats.saveConversation(value)
      return value
    })
  }
  /** Pinning reorders the history without counting as activity. */
  @Remote async setPinned(request: { readonly conversationId: ConversationId; readonly pinned: boolean }): Promise<Conversation> {
    this.owner()
    return this.chats.serial(async () => {
      const { pinned: _old, ...current } = this.chats.find(request.conversationId)
      if (current.temporary) throw new PersonalChatError('temporary-operation', 'Temporary Chat cannot be pinned')
      const value = { ...current, ...(request.pinned ? { pinned: true } : {}) }
      await this.chats.saveConversation(value)
      return value
    })
  }
  private async cleanupConversation(id: ConversationId, record: ConversationRecord): Promise<void> {
    if (record.conversation.id !== id || record.attachments.some(asset => asset.conversationId !== id)) throw new PersonalChatError('invalid-storage', 'Attachment ownership is inconsistent')
    if (!record.conversation.temporary) await this.memory.releaseConversation(id)
    for (const attachment of record.attachments) await this.assets.remove(attachment, record.conversation.temporary)
    for (const revision of record.conversation.archiveRevisions) this.chats.forgetArchive(revision)
    if (record.conversation.temporary) { this.chats.temporary.delete(id); this.chats.temporarySeen.delete(id) }
    else { this.chats.domain.removeConversation(id); this.chats.domain.checkpoint() }
    this.chats.closeFeed(id)
    this.chats.deleting.delete(id); this.chats.changes.publish({ kind: 'catalog', conversationId: id })
  }
  /** Stop all owned writers, then remove owned history and files; retries are idempotent. */
  @Remote async deleteConversation(request: { readonly conversationId: ConversationId }): Promise<void> {
    this.owner()
    this.chats.deleting.add(request.conversationId)
    const turn = this.chats.running.get(request.conversationId)
    turn?.controller.abort()
    if (turn) await turn.done
    return this.chats.serial(async () => {
      const record = this.chats.raw(request.conversationId)
      if (!record) { this.chats.deleting.delete(request.conversationId); return }
      if (!record.conversation.temporary) this.chats.domain.saveConversation({ ...record, deleting: true, running: false })
      await this.cleanupConversation(request.conversationId, record)
    })
  }
  /** Dispose a temporary chat without a durable tombstone or memory access. */
  @Remote async closeTemporary(request: { readonly conversationId: ConversationId }): Promise<void> {
    this.owner()
    if (this.chats.temporary.has(request.conversationId)) await this.deleteConversation(request)
  }
  /** Switch to an existing immutable branch. */
  @Remote async selectBranch(request: { readonly conversationId: ConversationId; readonly branchId: BranchId }): Promise<ConversationDetail> {
    this.owner()
    return this.chats.serial(async () => {
      this.chats.idle(request.conversationId)
      const current = this.chats.find(request.conversationId)
      const branch = current.branches.find(item => item.id === request.branchId)
      if (!branch) throw new PersonalChatError('branch-not-found', 'Branch does not belong to this chat')
      const { selectedArchive: _old, ...base } = current
      const updated = { ...base, selectedBranchId: branch.id, ...(branch.archive && this.chats.visibleRevision(branch.archive.revisionId) ? { selectedArchive: branch.archive } : {}) }
      await this.chats.saveConversation(updated)
      return this.chats.detail(updated)
    })
  }
  /** Fork or resend edited/regenerated input while preserving the old branch. */
  @Remote async branch(request: BranchRequest): Promise<ConversationDetail> {
    this.owner()
    this.requestId(request.requestId)
    let run: RunningTurn | undefined
    const result = await this.chats.serial(async () => {
      const record = this.chats.record(request.conversationId)
      const current = this.chats.find(request.conversationId)
      if (current.archived) throw new PersonalChatError('archived', 'Restore this conversation first')
      const prior = current.branches.find(item => item.id === request.requestId)
      if (prior) {
        if (prior.parentBranchId !== request.branchId || prior.sourceMessageId !== request.messageId || prior.operation !== request.action) throw new PersonalChatError('request-conflict', 'This request id was already used for another operation')
        const admitted = record.entries.find(entry => entry.originBranchId === prior.id && entry.message.role === 'user')
        if ((request.action === 'edit' && admitted?.userText !== request.text?.trim()) || (request.model && admitted?.admissionModel && !sameModel(request.model, admitted.admissionModel)) || (admitted && !!admitted.admissionWeb !== !!request.web)) throw new PersonalChatError('request-conflict', 'This branch request id has a different payload')
        return this.chats.detail({ ...current, selectedBranchId: prior.id })
      }
      this.chats.idle(request.conversationId)
      const source = current.branches.find(item => item.id === request.branchId)
      if (!source) throw new PersonalChatError('branch-not-found', 'Branch does not belong to this chat')
      const index = source.messageIds.indexOf(request.messageId)
      if (index < 0) throw new PersonalChatError('message-not-found', 'Message does not belong to the selected branch')
      const entries = new Map(record.entries.map(entry => [entry.id, entry]))
      let cut = index + 1
      let input: ChatEntry | undefined
      if (request.action !== 'fork') {
        let userIndex = index
        if (request.action === 'regenerate') while (userIndex >= 0 && entries.get(source.messageIds[userIndex]!)?.message.role !== 'user') userIndex--
        input = entries.get(source.messageIds[userIndex]!)
        if (!input || input.message.role !== 'user') throw new PersonalChatError('invalid-branch', 'Select a user message or an answer following one')
        cut = userIndex
      }
      const branch: ChatBranch = { ...source, id: brandString<BranchId>(request.requestId), operation: request.action, parentBranchId: source.id, sourceMessageId: request.messageId, messageIds: source.messageIds.slice(0, cut), createdAt: Date.now() }
      const updated = { ...record, conversation: { ...current, branches: [...current.branches, branch], selectedBranchId: branch.id, updatedAt: Date.now() } }
      if (input) {
        const model = request.model ?? record.model
        if (!model) throw new PersonalChatError('model-unavailable', 'Select a model before generating')
        await this.requireModel(model)
        run = await this.turns.admit(updated, branch, request.action === 'edit' ? request.text ?? '' : input.userText ?? textOf(input.message), input.attachmentIds, model, { web: request.web === true })
      } else await this.chats.saveRecord(updated)
      return this.chats.detail(this.chats.find(current.id))
    })
    if (run) this.turns.launch(request.conversationId, run)
    return result
  }
  /** Start a response after durable input admission, or entirely in memory for Temporary Chat. */
  @Remote async send(request: { readonly conversationId: ConversationId; readonly requestId: string; readonly branchId?: BranchId; readonly archive?: ArchiveSelection; readonly text: string; readonly attachmentIds?: readonly string[]; readonly model: ModelRef; readonly web?: boolean }): Promise<ConversationDetail> {
    this.owner()
    this.requestId(request.requestId)
    let run: RunningTurn | undefined
    let duplicate: ConversationDetail | undefined
    await this.chats.serial(async () => {
      let record = this.chats.record(request.conversationId)
      let conversation = this.chats.find(request.conversationId)
      const prior = record.entries.find(entry => entry.id === request.requestId)
      if (prior) {
        if (prior.message.role !== 'user' || prior.userText !== request.text.trim() || JSON.stringify(prior.attachmentIds) !== JSON.stringify(request.attachmentIds ?? []) || (!prior.admissionModel || !sameModel(prior.admissionModel, request.model)) || !!prior.admissionWeb !== !!request.web) throw new PersonalChatError('request-conflict', 'This request id was already used for another message')
        const originalBranch = conversation.branches.find(branch => branch.id === prior.originBranchId)
        if ((request.branchId && request.branchId !== prior.originBranchId) || (request.archive && (originalBranch?.archive?.revisionId !== request.archive.revisionId || originalBranch.archive.nodeId !== request.archive.nodeId))) throw new PersonalChatError('request-conflict', 'This request id has another branch target')
        duplicate = this.chats.detail({ ...conversation, ...(prior.originBranchId ? { selectedBranchId: prior.originBranchId } : {}) })
        return
      }
      this.chats.idle(request.conversationId)
      await this.requireModel(request.model)
      this.chats.record(request.conversationId)
      if (request.branchId && request.archive) throw new PersonalChatError('invalid-target', 'Choose one branch or archive target')
      if (request.branchId) {
        if (!conversation.branches.some(branch => branch.id === request.branchId)) throw new PersonalChatError('branch-not-found', 'The target branch is unavailable')
        conversation = { ...conversation, selectedBranchId: request.branchId }
        record = { ...record, conversation }
      } else if (request.archive) {
        if (!conversation.archiveRevisions.includes(request.archive.revisionId)) throw new PersonalChatError('archive-unavailable', 'The archive target is unavailable')
        const { selectedBranchId: _old, ...base } = conversation
        conversation = { ...base, selectedArchive: request.archive }
        record = { ...record, conversation }
      }
      if (conversation.archived) throw new PersonalChatError('archived', 'Restore this conversation before sending')
      if (!conversation.selectedBranchId) { conversation = await this.ensureContinuation(conversation); record = this.chats.record(conversation.id) }
      const branch = conversation.branches.find(item => item.id === conversation.selectedBranchId)!
      run = await this.turns.admit(record, branch, request.text, request.attachmentIds ?? [], request.model, { web: request.web === true }, request.requestId)
    })
    if (duplicate) return duplicate
    if (run) this.turns.launch(request.conversationId, run)
    return this.chats.detail(this.chats.find(request.conversationId))
  }
  private async requireModel(model: ModelRef): Promise<void> {
    if (!await this.bridge.available(model)) throw new PersonalChatError('model-unavailable', 'Select an available configured model')
    if (!await this.bridge.takesEffort(model)) throw new PersonalChatError('effort-unavailable', 'Select a reasoning effort this model offers')
  }
  /** Web search and Work crossings, with their settings. */
  @Remote async apps(): Promise<AppsView> { this.owner(); return this.integrations.view() }
  @Remote async updateApps(request: AppsChange): Promise<AppsView> {
    this.owner()
    const change = z.object({ webAuto: z.boolean().optional(), workMemory: z.boolean().optional(), workRecords: z.boolean().optional(), workWorkspaces: z.array(z.string().min(1).max(200).transform(brandString<WorkspaceRef>)).max(500).optional() }).strict().parse(request)
    await this.chats.serial(() => this.integrations.update(Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined))))
    return this.integrations.view()
  }
  /** Write a task brief from the chat; the person sends it to a new Work session themselves. */
  @Remote async handOff(request: { readonly conversationId: ConversationId }): Promise<{ readonly brief: string }> {
    this.owner()
    this.chats.find(request.conversationId)
    return { brief: await this.handOffs.brief(request.conversationId) }
  }
  /** Cancel the provider and in-flight tools, then return the settled prefix. */
  @Remote async stop(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail> {
    this.owner()
    const running = this.chats.running.get(request.conversationId)
    running?.controller.abort()
    if (running) await running.done
    return this.chats.detail(this.chats.find(request.conversationId))
  }
  private requestId(id: string): void { if (!z.string().uuid().safeParse(id).success) throw new PersonalChatError('invalid-request-id', 'Use a fresh UUID for each message or branch request') }
  /** Remove an unsubmitted upload; committed message attachments remain part of history. */
  @Remote async removeAttachment(request: { readonly conversationId: ConversationId; readonly attachmentId: string }): Promise<void> {
    this.owner()
    return this.chats.serial(async () => {
      const record = this.chats.record(request.conversationId)
      const attachment = this.chats.ownedAsset(record, request.attachmentId)
      if (record.entries.some(entry => entry.attachmentIds.includes(attachment.id))) throw new PersonalChatError('attachment-in-use', 'This attachment is part of a sent message; delete the chat to remove its history')
      await this.assets.remove(attachment, record.conversation.temporary)
      await this.chats.saveRecord({ ...record, attachments: record.attachments.filter(item => item.id !== attachment.id) })
    })
  }
  /** Store only a selected file, bound to this conversation and immutable retention. */
  @Remote async upload(request: { readonly conversationId: ConversationId; readonly name: string; readonly base64: string }): Promise<ChatAttachment> {
    this.owner()
    const bytes = decodeBase64(request.base64, this.config.maxAttachmentBytes)
    if (!bytes) throw new PersonalChatError('attachment-limit', 'Invalid file encoding or file exceeds upload limit')
    return this.chats.serial(async () => {
      const record = this.chats.record(request.conversationId)
      if (record.attachments.length >= 128) throw new PersonalChatError('attachment-limit', 'This chat already owns 128 attachments')
      const attachment = await this.assets.save(randomUUID(), record.conversation.id, record.conversation.temporary, request.name, bytes)
      try { await this.chats.saveRecord({ ...record, attachments: [...record.attachments, attachment] }) }
      catch (error) { await this.assets.remove(attachment, record.conversation.temporary); throw error }
      return attachment
    })
  }
  /** Show an owned Office file as images, for the person to read before downloading it. */
  @Remote async previewFile(request: { readonly conversationId: ConversationId; readonly attachmentId: string; readonly sheet?: string }): Promise<OfficePreview> {
    this.owner()
    const record = this.chats.record(request.conversationId)
    return this.assets.preview(this.chats.ownedAsset(record, request.attachmentId), record.conversation.temporary, request.sheet, AbortSignal.timeout(RENDER_TIMEOUT_MS))
  }
  @Remote async exportPdf(request: { readonly conversationId: ConversationId; readonly attachmentId: string }): Promise<{ readonly name: string; readonly base64: string }> {
    this.owner()
    const record = this.chats.record(request.conversationId)
    const attachment = this.chats.ownedAsset(record, request.attachmentId)
    const pdf = await this.assets.pdf(attachment, record.conversation.temporary, AbortSignal.timeout(RENDER_TIMEOUT_MS))
    return { name: attachment.name.replace(/\.[^.]+$/u, '') + '.pdf', base64: Buffer.from(pdf).toString('base64') }
  }
  /** Read an owned attachment for explicit browser preview/download. */
  @Remote async attachment(request: { readonly conversationId: ConversationId; readonly attachmentId: string; readonly original?: boolean }): Promise<{ readonly name: string; readonly mediaType: string; readonly base64: string }> {
    this.owner()
    const record = this.chats.record(request.conversationId)
    const attachment = this.chats.ownedAsset(record, request.attachmentId)
    if (attachment.image && !request.original) { const image = await this.assets.image(attachment, record.conversation.temporary, new AbortController().signal); return { name: attachment.name, ...image } }
    const data = await this.assets.read(attachment, record.conversation.temporary)
    return { name: attachment.name, mediaType: attachment.mediaType, base64: Buffer.from(data).toString('base64') }
  }
  /** Plugin-owned invalidation stream; no official event allowlist is changed. */
  @Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<PersonalChange> {
    this.owner()
    yield* this.chats.changes.follow(() => ({ kind: 'baseline' }), signal)
  }
  /** Baseline plus bounded deltas; reconnecting always starts with a current snapshot. */
  @Remote({ mode: 'stream' }) async *followConversation(request: { readonly conversationId: ConversationId }, signal: AbortSignal): AsyncIterable<ChatUpdate> {
    this.owner()
    this.chats.find(request.conversationId)
    const baseline = (): ChatUpdate => {
      const record = this.chats.raw(request.conversationId)
      return !record || record.deleting || this.chats.deleting.has(request.conversationId) ? { kind: 'closed' } : { kind: 'snapshot', detail: this.chats.detail(this.chats.hydrate(record.conversation)) }
    }
    if (!this.chats.find(request.conversationId).temporary) await this.chats.markUnseen(request.conversationId, false)
    try { yield* this.chats.feed(request.conversationId).follow(baseline, signal) }
    finally { if (this.chats.temporary.has(request.conversationId)) this.chats.temporarySeen.set(request.conversationId, Date.now()) }
  }
  /** Select any retained imported branch; source data is never rewritten. */
  @Remote async selectArchive(request: { readonly conversationId: ConversationId; readonly selection: { readonly revisionId: ArchiveRevisionId; readonly nodeId?: string } }): Promise<ConversationDetail> {
    this.owner()
    return this.chats.serial(async () => {
      this.chats.idle(request.conversationId)
      const conversation = this.chats.find(request.conversationId)
      if (!conversation.archiveRevisions.includes(request.selection.revisionId)) throw new PersonalChatError('archive-unavailable', 'Revision does not belong to this chat')
      const selection = { revisionId: request.selection.revisionId, nodeId: request.selection.nodeId ?? this.chats.readArchive(request.selection.revisionId).currentNode }
      archiveView(this.chats.readArchive(selection.revisionId), selection.revisionId, selection.nodeId)
      const linked = conversation.branches.find(item => item.archive?.revisionId === selection.revisionId && item.archive.nodeId === selection.nodeId)
      const { selectedBranchId: _old, ...base } = conversation
      const updated = { ...base, selectedArchive: selection, ...(linked ? { selectedBranchId: linked.id } : {}) }
      await this.chats.saveConversation(updated)
      return this.chats.detail(updated)
    })
  }
  private async ensureContinuation(conversation: Conversation): Promise<Conversation> {
    const selection = conversation.selectedArchive
    if (!selection) throw new PersonalChatError('archive-unavailable', 'Select an imported branch first')
    const existing = conversation.branches.find(item => item.archive?.revisionId === selection.revisionId && item.archive.nodeId === selection.nodeId)
    if (existing) { const updated = { ...conversation, selectedBranchId: existing.id }; await this.chats.saveConversation(updated); return updated }
    const snapshot = archiveSnapshot(this.chats.readArchive(selection.revisionId), selection.revisionId, selection.nodeId, this.config.maxSnapshotBytes)
    const branch: ChatBranch = { id: uuid<BranchId>(), messageIds: [], context: snapshot.text, archive: selection, snapshot: { omittedNodes: snapshot.omittedNodes, includedNodes: snapshot.includedNodes, bytes: snapshot.bytes }, createdAt: Date.now() }
    const updated = { ...conversation, branches: [...conversation.branches, branch], selectedBranchId: branch.id, updatedAt: Date.now() }
    await this.chats.saveConversation(updated)
    return updated
  }
  /** Continue in the same plugin view, not a native Work Session. */
  @Remote async continueArchive(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail> {
    this.owner()
    return this.chats.serial(async () => { this.chats.idle(request.conversationId); const current = this.chats.find(request.conversationId); if (current.archived) throw new PersonalChatError('archived', 'Restore this chat first'); return this.chats.detail(await this.ensureContinuation(current)) })
  }
  /** Validate one bounded upload without writing its content to disk. */
  @Remote async previewImport(request: { readonly fileName: string; readonly base64: string }): Promise<ImportPreview> { this.owner(); return this.imports.preview(request) }
  /** Commit one preview; duplicate records never acquire ownership in the new batch. */
  @Remote async commitImport(request: { readonly previewId: ImportPreviewId }): Promise<ImportResult> { this.owner(); return this.imports.commit(request) }
  /** Read import ownership and undo status. */
  @Remote async listImports(): Promise<readonly ImportBatch[]> { this.owner(); return this.imports.list() }
  /** Withdraw exactly this batch; plugin continuations and earlier batches survive. */
  @Remote async undoImport(request: { readonly batchId: ImportBatchId }): Promise<ImportUndoResult> { this.owner(); return this.imports.undo(request) }
  /** Read confirmed and pending state; temporary callers are denied before the ledger read. */
  @Remote async memoryState(request: { readonly conversationId?: ConversationId }): Promise<MemoryState> { this.owner(); return { ...await this.memory.state(request), summary: this.summaries.view() } }
  /** Replace the compact profile and custom instructions with optimistic concurrency. */
  @Remote async updateProfile(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number; readonly background: string; readonly instructions: string; readonly autoSaveLowRisk: boolean; readonly referenceChats: boolean; readonly source?: ProfileImportSource }): Promise<PersonalProfile> { this.owner(); return this.memory.updateProfile(request) }
  /** Propose a source-grounded memory; the server decides sensitivity and automatic admission. */
  @Remote async proposeMemory(request: CandidateInput): Promise<MemoryCandidate> { this.owner(); return this.memory.propose(request) }
  /** Confirm the exact pending revision, or reject/undo a candidate and suppress resurrection. */
  @Remote async decideCandidate(request: { readonly conversationId?: ConversationId; readonly candidateId: CandidateId; readonly expectedRevision: number; readonly decision: 'confirm' | 'reject' }): Promise<MemoryCandidate> { this.owner(); return this.memory.decide(request) }
  /** Human correction creates a new revision and supersedes the previous fact. */
  @Remote async editMemory(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number; readonly text: string }): Promise<Memory> { this.owner(); return this.memory.edit(request) }
  /** Forget removes future recall and suppresses old source evidence from automatic saving. */
  @Remote async forgetMemory(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number }): Promise<Memory> { this.owner(); return this.memory.forget(request) }
  /** Fold chats the Memory Summary has not read into it; returns once the update is queued. */
  @Remote async refreshSummary(request: { readonly conversationId?: ConversationId }): Promise<MemorySummaryView> { this.owner(); this.memory.guard(request.conversationId); this.summaries.refresh(); return this.summaries.view() }
  /** Answer a question about the summary, or apply a correction typed on the memory page. */
  @Remote async askSummary(request: { readonly conversationId?: ConversationId; readonly text: string }): Promise<{ readonly reply: string; readonly summary: MemorySummaryView }> {
    this.owner(); this.memory.guard(request.conversationId)
    const text = z.string().max(this.config.maxSummaryBytes * 2).parse(request.text)
    return { reply: await this.summaries.ask(text), summary: this.summaries.view() }
  }
  /** Save summary text typed on the memory page, without a model. */
  @Remote async editSummary(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number; readonly text: string }): Promise<MemorySummaryView> {
    this.owner(); this.memory.guard(request.conversationId)
    const text = z.string().max(this.config.maxSummaryBytes * 2).parse(request.text)
    await this.summaries.edit(request.expectedRevision, text)
    return this.summaries.view()
  }
  @Remote async undoSummary(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number }): Promise<MemorySummaryView> { this.owner(); this.memory.guard(request.conversationId); await this.summaries.undo(request.expectedRevision); return this.summaries.view() }
  @Remote async clearSummary(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number }): Promise<MemorySummaryView> { this.owner(); this.memory.guard(request.conversationId); await this.summaries.clear(request.expectedRevision); return this.summaries.view() }
  @Remote async summaryOptions(request: { readonly conversationId?: ConversationId; readonly model?: ModelRef; readonly sensitive: boolean }): Promise<MemorySummaryView> {
    this.owner(); this.memory.guard(request.conversationId)
    const options = z.object({ model: z.object({ provider: z.string().min(1), model: z.string().min(1), inline: z.literal(true).optional(), effort: z.string().optional() }).optional(), sensitive: z.boolean() }).parse({ model: request.model, sensitive: request.sensitive })
    await this.summaries.options(options.model ? { model: options.model, sensitive: options.sensitive } : { sensitive: options.sensitive })
    return this.summaries.view()
  }
}
function sameModel(left: ModelRef, right: ModelRef): boolean { return sameRoute(left, right) && left.effort === right.effort }
export default PersonalChatService
