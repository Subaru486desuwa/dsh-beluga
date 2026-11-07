import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PersonalChatOperations, UploadLimits, ConversationSummary, ConversationDetail, ConversationId, BranchId, ArchiveSelection, ImportPreview, ImportBatch, ImportBatchId, MemoryState, Memory, MemorySource, MemoryCandidate, PersonalProfile, ChatUpdate, ChatAttachment } from '../shared/types.ts'
import type { ModelChoice, ModelRef } from '../shared/models.ts'
import type { PersonalChatKey } from './locales.ts'

export interface PersonalState {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly results: readonly ConversationSummary[]
  readonly query: string
  readonly archived: boolean
  readonly detail: ConversationDetail | undefined
  readonly section: 'chats' | 'memory' | 'imports'
  readonly memory: MemoryState | undefined
  readonly imports: readonly ImportBatch[]
  readonly preview: ImportPreview | undefined
  readonly busy: boolean
  readonly models: readonly ModelChoice[]
  readonly modelsLoading: boolean
  readonly web: boolean
  readonly limits?: UploadLimits
  readonly selectedModel: ModelRef | undefined
  readonly notice: { readonly seq: number; readonly key: PersonalChatKey; readonly count?: number; readonly undo?: Memory; readonly detail?: string } | undefined
}
const SEARCH_DEBOUNCE_MS = 200
export class PersonalModel {
  readonly state = createSnapshotStore<PersonalState>({ status: 'loading', results: [], query: '', archived: false, detail: undefined, section: 'chats', memory: undefined, imports: [], preview: undefined, busy: false, modelsLoading: true, web: false, models: [], selectedModel: undefined, notice: undefined })
  private searchGeneration = 0
  private refreshing = false
  private stale = false
  private memoryGeneration = 0
  private noticeSeq = 0
  private pendingSend?: { key: string; id: string; target: { branchId?: BranchId; archive?: ArchiveSelection } }
  private pendingBranch?: { key: string; id: string; branchId: BranchId }
  private disposed = false
  private readonly lifetime = new AbortController()
  private conversationWatch?: AbortController
  private watchedId?: ConversationId
  constructor(private readonly api: PersonalChatOperations) {}
  private patch(value: Partial<PersonalState>): void { if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private notice(key: PersonalChatKey, count?: number, undo?: Memory, detail?: string): void { this.patch({ notice: { seq: ++this.noticeSeq, key, ...(count === undefined ? {} : { count }), ...(undo ? { undo } : {}), ...(detail ? { detail } : {}) } }) }
  dismissNotice(): void { this.patch({ notice: undefined }) }
  async start(): Promise<void> {
    await this.refresh()
    try { this.patch({ limits: await this.api.limits() }); const models = await this.api.models(); this.patch({ models, selectedModel: models[0] }) }
    catch { this.notice('noModels') }
    finally { this.patch({ modelsLoading: false }) }
    void this.listenChanges()
  }
  private async listenChanges(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      try {
        for await (const change of this.api.follow(this.lifetime.signal)) {
          if (this.lifetime.signal.aborted) return
          if (change.kind === 'memory') await this.refreshMemory(true)
          else void this.refreshSoon()
        }
      } catch { if (!this.lifetime.signal.aborted) this.patch({ status: 'failed' }) }
      if (!await delay(this.lifetime.signal)) return
    }
  }
  private watch(id: ConversationId): void {
    if (this.watchedId === id) return
    this.conversationWatch?.abort()
    const control = new AbortController()
    this.conversationWatch = control
    this.watchedId = id
    void (async () => {
      while (!control.signal.aborted && !this.lifetime.signal.aborted) {
        try {
          for await (const event of this.api.followConversation({ conversationId: id }, control.signal)) {
            if (control.signal.aborted || this.state.getSnapshot().detail?.conversation.id !== id) return
            this.applyUpdate(event)
          }
        } catch { if (!control.signal.aborted) this.notice('loadFailed') }
        if (!await delay(control.signal)) return
      }
    })()
  }
  private applyUpdate(event: ChatUpdate): void {
    if (event.kind === 'snapshot') { this.patch({ detail: event.detail }); return }
    if (event.kind === 'closed') { this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined }); return }
    if (event.kind === 'failure') { this.notice('failed', undefined, undefined, event.reason); return }
    const detail = this.state.getSnapshot().detail
    if (detail?.live?.id !== event.turnId) return
    this.patch({ detail: { ...detail, live: { ...detail.live, text: detail.live.text + (event.reasoning ? '' : event.text), reasoning: detail.live.reasoning + (event.reasoning ? event.text : '') } } })
  }
  private select(detail: ConversationDetail, preserveStream = false): void {
    const current = this.state.getSnapshot().detail
    // A unary receipt can arrive after stream deltas or even the final snapshot.
    // Keep the newer prefix of this same branch instead of rewinding live text.
    if (preserveStream && current?.conversation.id === detail.conversation.id
      && current.conversation.selectedBranchId === detail.conversation.selectedBranchId
      && detail.messages.every((message, index) => current.messages[index]?.id === message.id)
      && (current.messages.length > detail.messages.length || (current.live && detail.live
        && current.live.id === detail.live.id
        && current.live.text.startsWith(detail.live.text)
        && current.live.reasoning.startsWith(detail.live.reasoning)))) detail = current
    if (detail.conversation.temporary) ++this.memoryGeneration
    this.patch({ detail, section: 'chats', ...(detail.conversation.temporary ? { memory: undefined, notice: undefined } : {}), ...(detail.model ? { selectedModel: detail.model } : {}) })
    this.watch(detail.conversation.id)
  }
  async refresh(): Promise<void> {
    const generation = ++this.searchGeneration
    const { query, archived } = this.state.getSnapshot()
    try {
      const results = await this.api.list({ query, archived })
      this.patch({ status: 'ready', ...(generation === this.searchGeneration ? { results } : {}) })
    } catch { this.patch({ status: 'failed' }) }
  }
  /** Changes arrive once per stored message; any burst folds into one read plus one trailing read. */
  private async refreshSoon(): Promise<void> {
    if (this.refreshing) { this.stale = true; return }
    this.refreshing = true
    try {
      do {
        this.stale = false
        await this.refresh()
        if (this.state.getSnapshot().section === 'imports') this.patch({ imports: await this.api.listImports() })
      } while (this.stale && !this.lifetime.signal.aborted)
    } catch { if (!this.lifetime.signal.aborted) this.patch({ status: 'failed' }) }
    finally { this.refreshing = false }
  }
  async search(query: string, archived: boolean): Promise<void> {
    const generation = ++this.searchGeneration
    const typing = archived === this.state.getSnapshot().archived
    this.patch({ query, archived })
    if (typing) {
      await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS))
      if (generation !== this.searchGeneration || this.lifetime.signal.aborted) return
    }
    try { const results = await this.api.list({ query, archived }); if (generation === this.searchGeneration) this.patch({ results }) }
    catch { if (generation === this.searchGeneration) this.notice('failed') }
  }
  async run(operation: () => Promise<void>, success?: PersonalChatKey): Promise<boolean> {
    if (this.state.getSnapshot().busy) return false
    this.patch({ busy: true })
    try { await operation(); if (success) this.notice(success); return true }
    catch (error) {
      const message = error instanceof Error ? error.message : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : undefined
      this.notice('failed', undefined, undefined, message)
      return false
    }
    finally { this.patch({ busy: false }) }
  }
  private async leave(next?: ConversationId): Promise<void> {
    const current = this.state.getSnapshot().detail?.conversation
    if (current?.temporary && current.id !== next) { await this.api.closeTemporary({ conversationId: current.id }); this.patch({ detail: undefined }); this.conversationWatch?.abort(); this.watchedId = undefined }
  }
  async create(temporary: boolean): Promise<void> { await this.leave(); this.select(await this.api.create({ temporary })); await this.refresh(); if (!temporary) await this.refreshMemory(false) }
  async open(id: ConversationId): Promise<void> { await this.leave(id); this.select(await this.api.get({ conversationId: id })); if (!this.state.getSnapshot().memory) await this.refreshMemory(false) }
  async close(): Promise<void> { await this.leave(); this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined }) }
  releaseTemporary(id: ConversationId): void {
    void this.api.closeTemporary({ conversationId: id }).then(() => {
      if (this.state.getSnapshot().detail?.conversation.id === id) { this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined }) }
    }).catch(() => { if (!this.disposed) this.notice('failed') })
  }
  /** Apply a settled field to whatever is on screen now: replies and other chats may have arrived during the request. */
  private amend(id: ConversationId, change: Partial<ConversationDetail['conversation']>): void {
    const latest = this.state.getSnapshot().detail
    if (latest?.conversation.id === id) this.patch({ detail: { ...latest, conversation: { ...latest.conversation, ...change } } })
  }
  private detail(): ConversationDetail { const detail = this.state.getSnapshot().detail; if (!detail) throw new Error('No chat selected'); return detail }
  private model(): ModelRef { const model = this.state.getSnapshot().selectedModel; if (!model) throw new Error('Configure and select a model first'); return { provider: model.provider, model: model.model, ...(model.inline ? { inline: true } : {}) } }
  setWeb(web: boolean): void { this.patch({ web }) }
  chooseModel(model: ModelRef): void { this.patch({ selectedModel: model }) }
  async send(text: string, attachmentIds: readonly string[]): Promise<void> {
    const current = this.detail().conversation
    const payload = { conversationId: current.id, text, attachmentIds, model: this.model(), web: this.state.getSnapshot().web }
    const key = JSON.stringify(payload)
    if (this.pendingSend?.key !== key) this.pendingSend = { key, id: crypto.randomUUID(), target: current.selectedBranchId ? { branchId: current.selectedBranchId } : current.selectedArchive ? { archive: current.selectedArchive } : {} }
    this.select(await this.api.send({ ...payload, ...this.pendingSend.target, requestId: this.pendingSend.id }), true)
    this.pendingSend = undefined
  }
  async stop(): Promise<void> { this.select(await this.api.stop({ conversationId: this.detail().conversation.id })) }
  async continueArchive(text: string): Promise<void> { await this.send(text, []) }
  async removeAttachment(id: string): Promise<void> { await this.api.removeAttachment({ conversationId: this.detail().conversation.id, attachmentId: id }) }
  async upload(fileName: string, base64: string): Promise<ChatAttachment> { return this.api.upload({ conversationId: this.detail().conversation.id, name: fileName, base64 }) }
  async previewFile(id: string, sheet?: string) { return this.api.previewFile({ conversationId: this.detail().conversation.id, attachmentId: id, ...(sheet === undefined ? {} : { sheet }) }) }
  async exportPdf(id: string) { return this.api.exportPdf({ conversationId: this.detail().conversation.id, attachmentId: id }) }
  async attachment(id: string, original?: boolean) { return this.api.attachment({ conversationId: this.detail().conversation.id, attachmentId: id, ...(original ? { original: true } : {}) }) }
  async rename(title: string): Promise<void> { const { id } = this.detail().conversation; await this.api.rename({ conversationId: id, title }); this.amend(id, { title }); await this.refresh() }
  async archive(archived: boolean): Promise<void> { const current = this.detail(); await this.api.setArchived({ conversationId: current.conversation.id, archived }); this.select(await this.api.get({ conversationId: current.conversation.id })); await this.refresh() }
  async pin(pinned: boolean): Promise<void> { const { id } = this.detail().conversation; await this.api.setPinned({ conversationId: id, pinned }); this.amend(id, { pinned }); await this.refresh() }
  async delete(): Promise<void> { const id = this.detail().conversation.id; await this.api.deleteConversation({ conversationId: id }); this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined }); await this.refresh() }
  async selectBranch(branchId: BranchId): Promise<void> { this.pendingSend = undefined; this.pendingBranch = undefined; this.select(await this.api.selectBranch({ conversationId: this.detail().conversation.id, branchId })) }
  async selectArchive(selection: { revisionId: ArchiveSelection['revisionId']; nodeId?: string }): Promise<void> { this.pendingSend = undefined; this.pendingBranch = undefined; this.select(await this.api.selectArchive({ conversationId: this.detail().conversation.id, selection })) }
  async branch(messageId: string, action: 'edit' | 'regenerate' | 'fork', text?: string): Promise<void> {
    const current = this.detail().conversation
    if (!current.selectedBranchId) throw new Error('Select a branch first')
    const payload = { conversationId: current.id, branchId: current.selectedBranchId, messageId, action, ...(text === undefined ? {} : { text }), model: this.model(), web: this.state.getSnapshot().web }
    const key = JSON.stringify({ conversationId: current.id, messageId, action, text, model: this.model(), web: this.state.getSnapshot().web })
    if (this.pendingBranch?.key !== key) this.pendingBranch = { key, id: crypto.randomUUID(), branchId: current.selectedBranchId }
    this.select(await this.api.branch({ ...payload, branchId: this.pendingBranch.branchId, requestId: this.pendingBranch.id }), true)
    this.pendingBranch = undefined
  }
  async section(section: PersonalState['section']): Promise<void> {
    if (section !== 'chats' && this.state.getSnapshot().detail?.conversation.temporary) throw new Error('Temporary chat has no memory access')
    if (section === 'memory') await this.refreshMemory(false)
    if (section === 'imports') this.patch({ imports: await this.api.listImports() })
    this.patch({ section })
  }
  async refreshMemory(announce: boolean): Promise<void> {
    if (this.state.getSnapshot().detail?.conversation.temporary) return
    const generation = ++this.memoryGeneration
    const previous = this.state.getSnapshot().memory
    const memory = await this.api.memoryState(this.memoryContext())
    if (generation !== this.memoryGeneration || this.state.getSnapshot().detail?.conversation.temporary) return
    this.patch({ memory })
    if (announce) {
      const saved = memory.memories.find(item => item.state === 'active' && !previous?.memories.some(old => old.id === item.id) && memory.candidates.some(candidate => candidate.memoryId === item.id && (candidate.reason === 'low-risk' || candidate.reason === 'explicit')))
      if (saved) this.notice('memoryUpdated', undefined, saved)
    }
  }
  private memoryContext(): { conversationId?: ConversationId } {
    const current = this.state.getSnapshot().detail?.conversation
    if (current?.temporary) throw new Error('Temporary chat has no memory access')
    return current ? { conversationId: current.id } : {}
  }
  async proposeMemory(text: string, category: Memory['category'], source: MemorySource): Promise<void> { const candidate = await this.api.proposeMemory({ ...this.memoryContext(), text, category, source }); await this.refreshMemory(false); this.notice(candidate.state === 'saved' ? 'memoryUpdated' : 'candidatePending') }
  async updateProfile(profile: PersonalProfile): Promise<void> { await this.api.updateProfile({ ...this.memoryContext(), expectedRevision: profile.revision, background: profile.background, instructions: profile.instructions, autoSaveLowRisk: profile.autoSaveLowRisk, referenceChats: profile.referenceChats, ...(profile.source ? { source: profile.source } : {}) }); await this.refreshMemory(false) }
  async decide(candidate: MemoryCandidate, decision: 'confirm' | 'reject'): Promise<void> { await this.api.decideCandidate({ ...this.memoryContext(), candidateId: candidate.id, expectedRevision: candidate.revision, decision }); await this.refreshMemory(false) }
  async editMemory(memory: Memory, text: string): Promise<void> { await this.api.editMemory({ ...this.memoryContext(), memoryId: memory.id, expectedRevision: memory.revision, text }); await this.refreshMemory(false) }
  async forget(memory: Memory): Promise<void> { await this.api.forgetMemory({ ...this.memoryContext(), memoryId: memory.id, expectedRevision: memory.revision }); await this.refreshMemory(false) }
  async preview(fileName: string, base64: string): Promise<void> { this.patch({ preview: await this.api.previewImport({ fileName, base64 }) }) }
  discardPreview(): void { this.patch({ preview: undefined }) }
  async commitImport(): Promise<void> { const preview = this.state.getSnapshot().preview; if (!preview) return; await this.api.commitImport({ previewId: preview.id }); this.patch({ preview: undefined, imports: await this.api.listImports() }); await this.refresh() }
  async undoImport(batchId: ImportBatchId): Promise<void> {
    const result = await this.api.undoImport({ batchId })
    this.patch({ imports: await this.api.listImports() }); await this.refresh()
    const id = this.state.getSnapshot().detail?.conversation.id
    if (id) {
      try { this.select(await this.api.get({ conversationId: id })); if (!this.state.getSnapshot().memory) await this.refreshMemory(false) }
      catch { await this.close() }
    }
    this.notice('importRetained', result.retainedContinuations.length)
  }
  async dispose(): Promise<void> {
    const current = this.state.getSnapshot().detail?.conversation
    this.disposed = true
    this.conversationWatch?.abort(); this.lifetime.abort()
    if (current?.temporary) {
      try { await this.api.closeTemporary({ conversationId: current.id }) }
      catch { /* A disconnected Host expires an unobserved temporary chat. */ }
    }
  }
}
function delay(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = (value: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value) }
    const abort = () => finish(false)
    const timer = setTimeout(() => finish(true), 1500)
    signal.addEventListener('abort', abort, { once: true })
  })
}
