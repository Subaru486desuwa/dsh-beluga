import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonical, parseExport, PersonalChatError, type ParsedArchive } from './archive.ts'
import { decodeBase64 } from './base64.ts'
import { normalized } from './memory.ts'
import { pacing } from './pacing.ts'
import type { Config } from './config.ts'
import type { Conversations } from './conversations.ts'
import type { ArchiveRevisionId, Conversation, ConversationId, ImportBatch, ImportBatchId, ImportPreview, ImportPreviewId, ImportResult, ImportUndoResult } from '../shared/types.ts'

interface PreviewState { readonly preview: ImportPreview; readonly archives: readonly ParsedArchive[]; result?: ImportResult }

/** Import batches own their revisions, so one batch can be withdrawn without touching any other. */
export class Imports {
  private readonly previews = new Map<ImportPreviewId, PreviewState>()
  constructor(private readonly chats: Conversations, private readonly config: Config) {}
  clear(): void { this.previews.clear() }
  /** Withdraw a batch a previous run left before its commit marker. */
  async recover(): Promise<void> {
    for (const [, batch] of this.chats.domain.batches.entries()) {
      if (batch.state !== 'preparing') continue
      await this.chats.domain.transaction(async () => {
        await this.chats.domain.batches.put(batch.id, { ...batch, state: 'withdrawn' })
        await this.cleanup(batch.id)
      })
    }
  }
  async preview(request: { readonly fileName: string; readonly base64: string }): Promise<ImportPreview> {
    const bytes = decodeBase64(request.base64, this.config.maxUploadBytes)
    if (!bytes) throw new PersonalChatError('invalid-upload', 'Invalid base64 or upload exceeds ' + this.config.maxUploadBytes + ' bytes (maxUploadBytes)')
    const archives = parseExport(bytes, request.fileName, this.config)
    const preview: ImportPreview = { id: brandString<ImportPreviewId>(randomUUID()), fileName: request.fileName.slice(0, 255), expiresAt: Date.now() + this.config.previewTtlMs, warnings: ['Configured limits: upload ' + this.config.maxUploadBytes + ' bytes; conversation JSON ' + this.config.maxArchiveBytes + ' bytes; ' + this.config.maxConversations + ' conversations; ' + this.config.maxNodes + ' total nodes.'], items: archives.map(archive => ({ sourceId: archive.sourceId, title: archive.title, nodes: archive.nodes.length, branches: archive.nodes.filter(node => !node.children.length).length, status: this.status(archive), warnings: archive.warnings })) }
    this.previews.clear()
    this.previews.set(preview.id, { preview, archives })
    return preview
  }
  private status(archive: ParsedArchive): 'new' | 'duplicate' | 'revision' {
    const existing = this.chats.domain.archivesForSource(archive.sourceId)
    if (existing.some(item => canonical(item.original) === canonical(archive.original))) return 'duplicate'
    return existing.length ? 'revision' : 'new'
  }
  async commit(request: { readonly previewId: ImportPreviewId }): Promise<ImportResult> {
    return this.chats.serial(async () => {
      const state = this.previews.get(request.previewId)
      if (!state || state.preview.expiresAt < Date.now()) throw new PersonalChatError('preview-expired', 'Preview expired; select the export again')
      if (state.result) return state.result
      const fresh = state.archives.filter(archive => this.status(archive) !== 'duplicate')
      const existingBytes = this.chats.domain.archiveBytes()
      const addedBytes = fresh.reduce((sum, archive) => sum + Buffer.byteLength(JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', batchId: '00000000-0000-4000-8000-000000000000', conversationId: '00000000-0000-4000-8000-000000000000', sourceId: archive.sourceId, original: archive.original })), 0)
      if (existingBytes + addedBytes > this.config.maxStoredArchiveBytes) throw new PersonalChatError('archive-capacity', 'Stored archives would exceed maxStoredArchiveBytes')
      const batch: ImportBatch = { id: brandString<ImportBatchId>(randomUUID()), fileName: state.preview.fileName, createdAt: Date.now(), state: 'preparing', revisionIds: fresh.map(() => brandString<ArchiveRevisionId>(randomUUID())), skipped: state.archives.length - fresh.length }
      const conversations: ConversationId[] = []
      const committed: ImportBatch = { ...batch, state: 'committed' }
      const pause = pacing()
      await this.chats.domain.transaction(async () => {
        await this.chats.domain.batches.put(batch.id, batch)
        for (const [index, archive] of fresh.entries()) {
          const previous = this.chats.domain.archivesForSource(archive.sourceId)[0]
          const old = previous ? this.chats.find(previous.conversationId) : undefined
          const id = old?.id ?? brandString<ConversationId>(randomUUID())
          const revisionId = batch.revisionIds[index]!
          this.chats.domain.saveArchive({ id: revisionId, batchId: batch.id, conversationId: id, sourceId: archive.sourceId, original: archive.original }, archive.nodes.map(node => normalized(node.text)).filter(Boolean).join('\n'))
          const conversation: Conversation = old ? { ...old, archiveRevisions: [...old.archiveRevisions, revisionId] } : { id, title: archive.title, temporary: false, archived: false, createdAt: Date.now(), updatedAt: Date.now(), branches: [], archiveRevisions: [revisionId], selectedArchive: { revisionId, nodeId: archive.currentNode }, archiveWithdrawn: false }
          await this.chats.saveConversation(conversation, false)
          conversations.push(id)
          await pause()
        }
        await this.chats.domain.batches.put(batch.id, committed)
      })
      state.result = { batch: committed, conversations }
      this.chats.changed('imports'); this.chats.changed('catalog')
      return state.result
    })
  }
  list(): readonly ImportBatch[] { return this.chats.domain.batches.entries().map(([, item]) => item).sort((a, b) => b.createdAt - a.createdAt) }
  private async cleanup(id: ImportBatchId): Promise<void> {
    const batch = this.chats.domain.batches.get(id)!
    const owners = this.chats.domain.archiveOwners(id)
    const pause = pacing()
    for (const revisionId of batch.revisionIds) {
      this.chats.domain.removeArchive(revisionId)
      this.chats.forgetArchive(revisionId)
      await pause()
    }
    for (const owner of owners) {
      const raw = this.chats.domain.conversation(owner)
      if (!raw) continue
      const value = this.chats.hydrate(raw.conversation)
      if (!value.archiveRevisions.length && !value.branches.length) this.chats.domain.removeConversation(value.id)
      else await this.chats.saveConversation(value, false)
      await pause()
    }
  }
  async undo(request: { readonly batchId: ImportBatchId }): Promise<ImportUndoResult> {
    return this.chats.serial(async () => {
      const batch = this.chats.domain.batches.get(request.batchId)
      if (!batch) throw new PersonalChatError('batch-not-found', 'Import batch is unavailable')
      const withdrawn: ImportBatch = { ...batch, state: 'withdrawn' }
      await this.chats.domain.transaction(async () => {
        await this.chats.domain.batches.put(batch.id, withdrawn)
        await this.cleanup(batch.id)
      })
      const retainedContinuations = this.chats.domain.continuationsOf(batch.revisionIds)
      this.chats.domain.checkpoint()
      this.chats.changed('imports'); this.chats.changed('catalog')
      return { batch: withdrawn, retainedContinuations }
    })
  }
}
