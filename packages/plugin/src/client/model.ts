import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AppsChange, AppsView, PersonalChatOperations, UploadLimits, ConversationSummary, ConversationDetail, ConversationId, BranchId, ArchiveSelection, ImportPreview, ImportBatch, ImportBatchId, MemoryState, MemorySummaryView, Memory, MemorySource, MemoryCandidate, PersonalProfile, ChatUpdate, ChatAttachment } from '../shared/types.ts'
import { routeKey, sameRoute, type ModelChoice, type ModelRef } from '../shared/models.ts'
import type { PersonalChatKey } from './locales.ts'

/** The pages of the Settings dialog. */
export type SettingsTab = 'general' | 'personalization' | 'apps' | 'data'

export interface PersonalState {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly results: readonly ConversationSummary[]
  readonly query: string
  readonly detail: ConversationDetail | undefined
  /** The Settings dialog's open page, or undefined while it is closed. */
  readonly settings: SettingsTab | undefined
  readonly memory: MemoryState | undefined
  readonly imports: readonly ImportBatch[]
  /** Archived chats for Data controls; undefined until that page first loads them. */
  readonly archivedChats: readonly ConversationSummary[] | undefined
  readonly preview: ImportPreview | undefined
  readonly busy: boolean
  readonly models: readonly ModelChoice[]
  readonly modelsLoading: boolean
  /** Tools picked from the tools menu for the next messages. */
  readonly web: boolean
  readonly github: boolean
  readonly limits?: UploadLimits
  /** Web search and connected apps, as the Apps settings and the tools menu show them. */
  readonly apps?: AppsView
  /** The route and effort the next message goes with. */
  readonly selectedModel: ModelRef | undefined
  /** With no chat open, the next message starts a chat of this kind; it is saved only then. */
  readonly draftTemporary: boolean
  /** Changes whenever the person moves to another chat, so the composer starts empty there. */
  readonly navigation: number
  readonly notice: { readonly seq: number; readonly key: PersonalChatKey; readonly count?: number; readonly undo?: Memory; readonly detail?: string } | undefined
}
const SEARCH_DEBOUNCE_MS = 200
export class PersonalModel {
  readonly state = createSnapshotStore<PersonalState>({ status: 'loading', results: [], query: '', detail: undefined, settings: undefined, memory: undefined, imports: [], archivedChats: undefined, preview: undefined, busy: false, modelsLoading: true, web: false, github: false, models: [], selectedModel: undefined, draftTemporary: false, navigation: 0, notice: undefined })
  private searchGeneration = 0
  private refreshing = false
  private stale = false
  private memoryGeneration = 0
  private noticeSeq = 0
  private pendingSend?: { key: string; id: string; target: { branchId?: BranchId; archive?: ArchiveSelection } }
  private pendingBranch?: { key: string; id: string; branchId: BranchId }
  private disposed = false
  /** The effort last chosen for each route, so switching back restores it. */
  private readonly efforts = new Map<string, string>()
  /** What a new chat starts with: the route and effort of the last message sent. */
  private startingModel?: ModelRef
  private readonly lifetime = new AbortController()
  private conversationWatch?: AbortController
  private watchedId?: ConversationId
  constructor(private readonly api: PersonalChatOperations) {}
  private patch(value: Partial<PersonalState>): void { if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private notice(key: PersonalChatKey, count?: number, undo?: Memory, detail?: string): void { this.patch({ notice: { seq: ++this.noticeSeq, key, ...(count === undefined ? {} : { count }), ...(undo ? { undo } : {}), ...(detail ? { detail } : {}) } }) }
  dismissNotice(): void { this.patch({ notice: undefined }) }
  async start(): Promise<void> {
    await this.refresh()
    void Promise.resolve().then(() => this.api.apps()).then(apps => { this.patch({ apps }) }, () => { /* The tools menu goes without apps until the Apps settings load them. */ })
    try {
      this.patch({ limits: await this.api.limits() })
      const models = await this.api.models()
      for (const choice of models) if (choice.effort !== undefined) this.efforts.set(routeKey(choice), choice.effort)
      const first = models.find(choice => choice.lastUsed) ?? models[0]
      this.startingModel = first && this.withEffort(first)
      this.patch({ models, ...(this.state.getSnapshot().selectedModel ? {} : { selectedModel: this.startingModel }) })
    }
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
    const restored = detail.model && current?.conversation.id !== detail.conversation.id ? this.offered(detail.model) : undefined
    this.patch({ detail, ...(detail.conversation.temporary ? { memory: undefined, notice: undefined } : {}), ...(restored ? { selectedModel: restored } : {}) })
    this.watch(detail.conversation.id)
  }
  async refresh(): Promise<void> {
    const generation = ++this.searchGeneration
    const { query } = this.state.getSnapshot()
    try {
      const results = await this.api.list({ query })
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
        if (this.state.getSnapshot().settings === 'data') await this.loadData()
      } while (this.stale && !this.lifetime.signal.aborted)
    } catch { if (!this.lifetime.signal.aborted) this.patch({ status: 'failed' }) }
    finally { this.refreshing = false }
  }
  /** Unarchived chats, plus archived ones the query matches. */
  async search(query: string): Promise<void> {
    const generation = ++this.searchGeneration
    this.patch({ query })
    await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS))
    if (generation !== this.searchGeneration || this.lifetime.signal.aborted) return
    try { const results = await this.api.list({ query }); if (generation === this.searchGeneration) this.patch({ results }) }
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
  /** Show an empty chat; nothing is saved until the first file or message. */
  async create(temporary: boolean): Promise<void> {
    await this.leave()
    this.conversationWatch?.abort(); this.watchedId = undefined
    this.pendingSend = undefined
    this.patch({ detail: undefined, settings: undefined, draftTemporary: temporary, navigation: this.state.getSnapshot().navigation + 1, ...(this.startingModel ? { selectedModel: this.startingModel } : {}), ...(temporary ? { memory: undefined, notice: undefined } : {}) })
    if (!temporary && !this.state.getSnapshot().memory) await this.refreshMemory(false)
  }
  /** The open chat, saved now if it is still an empty one on screen. */
  private async ensure(): Promise<ConversationDetail> {
    const open = this.state.getSnapshot().detail
    if (open) return open
    const created = await this.api.create({ temporary: this.state.getSnapshot().draftTemporary })
    this.select(created)
    return created
  }
  async open(id: ConversationId): Promise<void> { await this.leave(id); this.select(await this.api.get({ conversationId: id })); this.patch({ navigation: this.state.getSnapshot().navigation + 1, settings: undefined }); if (!this.state.getSnapshot().memory) await this.refreshMemory(false) }
  async close(): Promise<void> { await this.leave(); this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined, draftTemporary: false, navigation: this.state.getSnapshot().navigation + 1, ...(this.startingModel ? { selectedModel: this.startingModel } : {}) }) }
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
  private model(): ModelRef { const model = this.state.getSnapshot().selectedModel; if (!model) throw new Error('Configure and select a model first'); return { provider: model.provider, model: model.model, ...(model.inline ? { inline: true } : {}), ...(model.effort === undefined ? {} : { effort: model.effort }) } }
  setWeb(web: boolean): void { this.patch({ web }) }
  setGitHub(github: boolean): void { this.patch({ github }) }
  /** Switch route, with the effort last chosen for it. */
  chooseModel(model: ModelRef): void { this.patch({ selectedModel: this.withEffort(model) }) }
  /** @param effort - an effort the selected route offers, or undefined for its default. */
  chooseEffort(effort: string | undefined): void {
    const selected = this.state.getSnapshot().selectedModel
    if (!selected) return
    const key = routeKey(selected)
    if (effort === undefined) this.efforts.delete(key)
    else this.efforts.set(key, effort)
    this.patch({ selectedModel: this.withEffort(selected) })
  }
  private withEffort(model: ModelRef): ModelRef {
    const effort = this.efforts.get(routeKey(model))
    return { provider: model.provider, model: model.model, ...(model.inline ? { inline: true as const } : {}), ...(effort === undefined ? {} : { effort }) }
  }
  /** A chat's own route and effort, while the route and effort are still offered. */
  private offered(model: ModelRef): ModelRef | undefined {
    const choice = this.state.getSnapshot().models.find(item => sameRoute(item, model))
    if (!choice) return undefined
    const effort = model.effort !== undefined && choice.efforts?.some(item => item.id === model.effort) ? model.effort : undefined
    return { provider: choice.provider, model: choice.model, ...(choice.inline ? { inline: true as const } : {}), ...(effort === undefined ? {} : { effort }) }
  }
  /** The next new chat starts from what was just sent, as the Host also remembers. */
  private sent(model: ModelRef): void {
    if (this.state.getSnapshot().detail?.conversation.temporary) return
    this.startingModel = model
    if (model.effort !== undefined) this.efforts.set(routeKey(model), model.effort)
  }
  async send(text: string, attachmentIds: readonly string[]): Promise<void> {
    const current = (await this.ensure()).conversation
    const payload = { conversationId: current.id, text, attachmentIds, model: this.model(), web: this.state.getSnapshot().web, github: this.state.getSnapshot().github }
    const key = JSON.stringify(payload)
    if (this.pendingSend?.key !== key) this.pendingSend = { key, id: crypto.randomUUID(), target: current.selectedBranchId ? { branchId: current.selectedBranchId } : current.selectedArchive ? { archive: current.selectedArchive } : {} }
    this.select(await this.api.send({ ...payload, ...this.pendingSend.target, requestId: this.pendingSend.id }), true)
    this.pendingSend = undefined
    this.sent(payload.model)
  }
  async stop(): Promise<void> { this.select(await this.api.stop({ conversationId: this.detail().conversation.id })) }
  async continueArchive(text: string): Promise<void> { await this.send(text, []) }
  async removeAttachment(id: string): Promise<void> { await this.api.removeAttachment({ conversationId: this.detail().conversation.id, attachmentId: id }) }
  async upload(fileName: string, base64: string): Promise<ChatAttachment> { return this.api.upload({ conversationId: (await this.ensure()).conversation.id, name: fileName, base64 }) }
  async previewFile(id: string, sheet?: string) { return this.api.previewFile({ conversationId: this.detail().conversation.id, attachmentId: id, ...(sheet === undefined ? {} : { sheet }) }) }
  async exportPdf(id: string) { return this.api.exportPdf({ conversationId: this.detail().conversation.id, attachmentId: id }) }
  async attachment(id: string, original?: boolean) { return this.api.attachment({ conversationId: this.detail().conversation.id, attachmentId: id, ...(original ? { original: true } : {}) }) }
  async rename(title: string): Promise<void> { const { id } = this.detail().conversation; await this.api.rename({ conversationId: id, title }); this.amend(id, { title }); await this.refresh() }
  async archive(archived: boolean): Promise<void> { await this.setArchived(this.detail().conversation.id, archived) }
  /** Archive or unarchive any listed chat; the open one shows the change at once. */
  async setArchived(id: ConversationId, archived: boolean): Promise<void> {
    await this.api.setArchived({ conversationId: id, archived })
    if (this.state.getSnapshot().detail?.conversation.id === id) this.select(await this.api.get({ conversationId: id }))
    await this.refresh()
    if (this.state.getSnapshot().settings === 'data') await this.loadData()
  }
  async pin(pinned: boolean): Promise<void> { const { id } = this.detail().conversation; await this.api.setPinned({ conversationId: id, pinned }); this.amend(id, { pinned }); await this.refresh() }
  async delete(): Promise<void> { await this.remove(this.detail().conversation.id) }
  /** Delete any listed chat; deleting the open one leaves an empty chat on screen. */
  async remove(id: ConversationId): Promise<void> {
    await this.api.deleteConversation({ conversationId: id })
    if (this.state.getSnapshot().detail?.conversation.id === id) { this.conversationWatch?.abort(); this.watchedId = undefined; this.patch({ detail: undefined }) }
    await this.refresh()
    if (this.state.getSnapshot().settings === 'data') await this.loadData()
  }
  async selectBranch(branchId: BranchId): Promise<void> { this.pendingSend = undefined; this.pendingBranch = undefined; this.select(await this.api.selectBranch({ conversationId: this.detail().conversation.id, branchId })) }
  async selectArchive(selection: { revisionId: ArchiveSelection['revisionId']; nodeId?: string }): Promise<void> { this.pendingSend = undefined; this.pendingBranch = undefined; this.select(await this.api.selectArchive({ conversationId: this.detail().conversation.id, selection })) }
  async branch(messageId: string, action: 'edit' | 'regenerate' | 'fork', text?: string): Promise<void> {
    const current = this.detail().conversation
    if (!current.selectedBranchId) throw new Error('Select a branch first')
    const { web, github } = this.state.getSnapshot()
    const payload = { conversationId: current.id, branchId: current.selectedBranchId, messageId, action, ...(text === undefined ? {} : { text }), model: this.model(), web, github }
    const key = JSON.stringify({ conversationId: current.id, messageId, action, text, model: this.model(), web, github })
    if (this.pendingBranch?.key !== key) this.pendingBranch = { key, id: crypto.randomUUID(), branchId: current.selectedBranchId }
    this.select(await this.api.branch({ ...payload, branchId: this.pendingBranch.branchId, requestId: this.pendingBranch.id }), true)
    this.pendingBranch = undefined
    this.sent(payload.model)
  }
  /** Show a Settings page at once, then load what it lists. Personalization and Data controls stay unloaded during a Temporary Chat. */
  async openSettings(tab: SettingsTab): Promise<void> {
    this.patch({ settings: tab })
    const temporary = this.state.getSnapshot().detail?.conversation.temporary === true
    if (tab === 'personalization' && !temporary) await this.refreshMemory(false)
    if (tab === 'data' && !temporary) await this.loadData()
    if (tab === 'apps') this.patch({ apps: await this.api.apps() })
  }
  closeSettings(): void { this.patch({ settings: undefined }) }
  private async loadData(): Promise<void> {
    const [imports, archivedChats] = await Promise.all([this.api.listImports(), this.api.list({ archived: true })])
    this.patch({ imports, archivedChats })
  }
  async updateApps(change: AppsChange): Promise<void> { this.patch({ apps: await this.api.updateApps(change) }) }
  /** @returns a brief the Host wrote from the open chat, for a new Work session. */
  async brief(): Promise<string> {
    const conversation = this.state.getSnapshot().detail?.conversation
    if (!conversation) throw new Error('Open a chat first')
    return (await this.api.handOff({ conversationId: conversation.id })).brief
  }
  /** Read Work workspaces again, as the hand-off lists them. */
  async loadApps(): Promise<void> { this.patch({ apps: await this.api.apps() }) }
  async connectGitHub(source: { readonly token: string } | { readonly cli: true }): Promise<void> { this.patch({ apps: await this.api.connectGitHub(source) }) }
  /** A disconnected account can no longer be picked for the next message. */
  async disconnectGitHub(): Promise<void> { this.patch({ apps: await this.api.disconnectGitHub(), github: false }) }
  async decideAction(actionId: string, allow: boolean): Promise<void> { this.select(await this.api.decideAction({ conversationId: this.detail().conversation.id, actionId, allow }), true) }
  /** @param announce - offer Undo for a memory another chat saved on its own; the open chat shows its own under the reply. */
  async refreshMemory(announce: boolean): Promise<void> {
    if (this.state.getSnapshot().detail?.conversation.temporary) return
    const generation = ++this.memoryGeneration
    const previous = this.state.getSnapshot().memory
    const memory = await this.api.memoryState(this.memoryContext())
    if (generation !== this.memoryGeneration || this.state.getSnapshot().detail?.conversation.temporary) return
    this.patch({ memory })
    if (announce) {
      const open = this.state.getSnapshot().detail?.conversation.id
      const elsewhere = (candidate: MemoryCandidate) => candidate.source.kind !== 'chat' || candidate.source.conversationId !== open
      const saved = memory.memories.find(item => item.state === 'active' && !previous?.memories.some(old => old.id === item.id) && memory.candidates.some(candidate => candidate.memoryId === item.id && (candidate.reason === 'low-risk' || candidate.reason === 'explicit') && elsewhere(candidate)))
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
  private summary(): MemorySummaryView {
    const summary = this.state.getSnapshot().memory?.summary
    if (!summary) throw new Error('Open the memory page first')
    return summary
  }
  private showSummary(summary: MemorySummaryView): void { const memory = this.state.getSnapshot().memory; if (memory) this.patch({ memory: { ...memory, summary } }) }
  async refreshSummary(): Promise<void> { this.showSummary(await this.api.refreshSummary(this.memoryContext())) }
  /** @returns the answer to show; empty when the model only changed the summary. */
  async askSummary(text: string): Promise<string> { const result = await this.api.askSummary({ ...this.memoryContext(), text }); this.showSummary(result.summary); return result.reply }
  /** Save typed summary text; the notice says when credentials or contact details were removed from it. */
  async editSummary(text: string, expectedRevision: number): Promise<void> {
    const summary = await this.api.editSummary({ ...this.memoryContext(), expectedRevision, text })
    this.showSummary(summary)
    this.notice(summary.text === text.trim() ? 'summaryChanged' : 'summaryScrubbed')
  }
  async undoSummary(): Promise<void> { this.showSummary(await this.api.undoSummary({ ...this.memoryContext(), expectedRevision: this.summary().revision })) }
  async clearSummary(): Promise<void> { this.showSummary(await this.api.clearSummary({ ...this.memoryContext(), expectedRevision: this.summary().revision })) }
  async summaryOptions(options: { readonly model?: ModelRef; readonly sensitive: boolean }): Promise<void> { this.showSummary(await this.api.summaryOptions({ ...this.memoryContext(), ...options })) }
  /** A new normal chat that opens with `text`, as a suggestion under the summary starts one. */
  async startChat(text: string): Promise<void> { await this.create(false); await this.send(text, []) }
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
