/** Personal Chat's shared Host/Client operation contract. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelChoice, ModelRef } from './models.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type ConversationId = Branded<'PersonalConversationId'>
export type BranchId = Branded<'PersonalBranchId'>
export type ArchiveRevisionId = Branded<'PersonalArchiveRevisionId'>
export type ImportBatchId = Branded<'PersonalImportBatchId'>
export type ImportPreviewId = Branded<'PersonalImportPreviewId'>
export type MemoryId = Branded<'PersonalMemoryId'>
export type CandidateId = Branded<'PersonalCandidateId'>

export interface ArchiveSelection { readonly revisionId: ArchiveRevisionId; readonly nodeId: string }
export interface ChatBranch {
  readonly id: BranchId
  readonly messageIds: readonly string[]
  readonly context?: string
  readonly operation?: 'edit' | 'regenerate' | 'fork'
  readonly parentBranchId?: BranchId
  readonly sourceMessageId?: string
  readonly archive?: ArchiveSelection
  readonly snapshot?: { readonly omittedNodes: number; readonly includedNodes: number; readonly bytes: number }
  readonly createdAt: number
}
export interface Conversation {
  readonly id: ConversationId
  readonly title: string
  readonly temporary: boolean
  readonly archived: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly branches: readonly ChatBranch[]
  readonly selectedBranchId?: BranchId
  readonly archiveRevisions: readonly ArchiveRevisionId[]
  readonly selectedArchive?: ArchiveSelection
  readonly pinned?: boolean
  /** Later plugin conversation messages remain after import withdrawal. */
  readonly archiveWithdrawn: boolean
}
/** One history row; bodies are read with `get`. */
export interface ConversationSummary {
  readonly id: ConversationId
  readonly title: string
  readonly updatedAt: number
  readonly pinned: boolean
}
export interface ArchiveNode {
  readonly id: string
  readonly parent: string | null
  readonly children: readonly string[]
  readonly role: string | null
  readonly time: JsonValue
  readonly text: string
  readonly structural: boolean
  readonly unsupportedContent: boolean
}
export interface ArchiveView {
  readonly revisionId: ArchiveRevisionId
  readonly sourceId: string
  readonly title: string
  readonly currentNode: string
  readonly selectedNode: string
  readonly nodes: readonly ArchiveNode[]
  readonly branchNodes: readonly ArchiveNode[]
  /** Exact parsed source object, including unknown fields and original mapping. */
  readonly original: Record<string, JsonValue>
  readonly warnings: readonly string[]
}
/** One Office file shown as images: a document's first pages, or the start of one worksheet. */
export interface OfficePreview {
  readonly pages: readonly { readonly base64: string; readonly width: number; readonly height: number }[]
  /** Pages in the document; a worksheet counts its images. */
  readonly pageCount: number
  readonly missingFonts: readonly string[]
  readonly sheets?: readonly string[]
  readonly sheet?: string
  readonly range?: string
  /** The worksheet goes on past the range shown. */
  readonly clipped?: boolean
}
/** A cell as read from a saved workbook. */
export type SheetCell = string | number | boolean | null
/** One rectangle of a worksheet, for the model. */
export interface SheetRange {
  readonly sheet: string
  readonly range: string
  readonly rows: readonly (readonly SheetCell[])[]
  readonly formulas: Readonly<Record<string, string>>
  /** What to read next when the request was larger than one answer. */
  readonly nextRange?: string
}
/** A page a reply consulted. */
export interface WebSource {
  readonly url: string
  readonly title?: string
}
export interface ChatMessageView {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly reasoning?: string
  readonly time: number
  readonly attachmentIds: readonly string[]
  readonly toolNames: readonly string[]
  readonly sources?: readonly WebSource[]
}
export interface ArtifactVersion {
  readonly rootId: string
  readonly parentId?: string
  readonly version: number
  readonly summary: string
}
export interface ChatAttachment {
  readonly artifact?: ArtifactVersion
  readonly id: string
  readonly conversationId: ConversationId
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
  readonly image: boolean
}
export interface LiveTurn {
  readonly id: string
  readonly branchId: BranchId
  readonly text: string
  readonly reasoning: string
  readonly tool?: string
}
export interface ConversationDetail {
  readonly conversation: Conversation
  readonly archive?: ArchiveView
  readonly messages: readonly ChatMessageView[]
  readonly attachments: readonly ChatAttachment[]
  readonly live?: LiveTurn
  readonly model?: ModelRef
  readonly error?: string
  readonly omittedMessages: number
}
export type ChatUpdate = { readonly kind: 'snapshot'; readonly detail: ConversationDetail }
  | { readonly kind: 'delta'; readonly turnId: string; readonly text: string; readonly reasoning: boolean }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failure'; readonly reason: string }
export interface PersonalChange { readonly kind: 'baseline' | 'catalog' | 'memory' | 'imports'; readonly conversationId?: ConversationId }

export interface ImportPreviewItem {
  readonly sourceId: string
  readonly title: string
  readonly nodes: number
  readonly branches: number
  readonly status: 'new' | 'duplicate' | 'revision'
  readonly warnings: readonly string[]
}
export interface ImportPreview {
  readonly id: ImportPreviewId
  readonly fileName: string
  readonly items: readonly ImportPreviewItem[]
  readonly warnings: readonly string[]
  readonly expiresAt: number
}
export interface ImportBatch {
  readonly id: ImportBatchId
  readonly fileName: string
  readonly createdAt: number
  readonly state: 'preparing' | 'committed' | 'withdrawn'
  readonly revisionIds: readonly ArchiveRevisionId[]
  readonly skipped: number
}
export interface ImportResult { readonly batch: ImportBatch; readonly conversations: readonly ConversationId[] }
export interface ImportUndoResult { readonly batch: ImportBatch; readonly retainedContinuations: readonly ConversationId[] }
export interface ProfileImportSource { readonly fileName: string; readonly kind: 'profile' | 'custom-instructions' | 'agents'; readonly scope: 'personal' }
export interface PersonalProfile {
  readonly revision: number
  readonly background: string
  readonly source?: ProfileImportSource
  readonly instructions: string
  readonly autoSaveLowRisk: boolean
  /** Whether the model may search earlier chats while replying. */
  readonly referenceChats: boolean
  readonly updatedAt: number
}
export type MemorySource =
  | { readonly kind: 'chat'; readonly conversationId: ConversationId; readonly messageId: string }
  | { readonly kind: 'archive'; readonly revisionId: ArchiveRevisionId; readonly nodeId: string }
  | { readonly kind: 'manual' }
  | { readonly kind: 'imported-text'; readonly fileName: string }
export interface Memory {
  readonly id: MemoryId
  readonly revision: number
  readonly text: string
  readonly category: 'preference' | 'fact' | 'decision'
  readonly scope: 'personal'
  readonly source: MemorySource
  readonly createdAt: number
  readonly updatedAt: number
  readonly state: 'active' | 'superseded' | 'forgotten'
  readonly supersedes?: MemoryId
}
export interface MemoryCandidate {
  readonly id: CandidateId
  readonly revision: number
  readonly text: string
  readonly category: Memory['category']
  readonly source: MemorySource
  readonly reason: 'low-risk' | 'explicit' | 'sensitive' | 'inference' | 'conflict' | 'archive' | 'suppressed' | 'review'
  readonly state: 'pending' | 'saved' | 'rejected'
  readonly createdAt: number
  readonly memoryId?: MemoryId
  readonly replaces?: MemoryId
}
export interface MemoryState { readonly profile: PersonalProfile; readonly memories: readonly Memory[]; readonly candidates: readonly MemoryCandidate[] }
export interface CandidateInput {
  readonly conversationId?: ConversationId
  readonly text: string
  readonly category: Memory['category']
  readonly source: MemorySource
  readonly replaces?: MemoryId
}
export interface BranchRequest {
  readonly requestId: string
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly messageId: string
  readonly action: 'edit' | 'regenerate' | 'fork'
  readonly text?: string
  readonly model?: ModelRef
  readonly web?: boolean
}
export interface AttachmentText {
  readonly name: string
  readonly status: 'text' | 'unsupported'
  readonly text: string
  readonly truncated: boolean
  readonly reason?: string
  readonly pages?: number
  readonly pagesRead?: number
}
/** All calls use the authenticated owner Remote namespace `personalChat`. */
export interface UploadLimits { readonly uploadBytes: number; readonly attachmentBytes: number; readonly profileBytes: number
  /** Whether the Office extension can render files here. */
  readonly office: boolean
}
export interface PersonalChatOperations {
  limits(): Promise<UploadLimits>
  models(): Promise<readonly ModelChoice[]>
  send(request: { readonly conversationId: ConversationId; readonly requestId: string; readonly branchId?: BranchId; readonly archive?: ArchiveSelection; readonly text: string; readonly attachmentIds?: readonly string[]; readonly model: ModelRef; readonly web?: boolean }): Promise<ConversationDetail>
  stop(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail>
  removeAttachment(request: { readonly conversationId: ConversationId; readonly attachmentId: string }): Promise<void>
  upload(request: { readonly conversationId: ConversationId; readonly name: string; readonly base64: string }): Promise<ChatAttachment>
  previewFile(request: { readonly conversationId: ConversationId; readonly attachmentId: string; readonly sheet?: string }): Promise<OfficePreview>
  exportPdf(request: { readonly conversationId: ConversationId; readonly attachmentId: string }): Promise<{ readonly name: string; readonly base64: string }>
  attachment(request: { readonly conversationId: ConversationId; readonly attachmentId: string; readonly original?: boolean }): Promise<{ readonly name: string; readonly mediaType: string; readonly base64: string }>
  follow(signal: AbortSignal): AsyncIterable<PersonalChange>
  followConversation(request: { readonly conversationId: ConversationId }, signal: AbortSignal): AsyncIterable<ChatUpdate>
  list(request: { readonly query?: string; readonly archived?: boolean }): Promise<readonly ConversationSummary[]>
  create(request: { readonly temporary: boolean }): Promise<ConversationDetail>
  get(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail>
  rename(request: { readonly conversationId: ConversationId; readonly title: string }): Promise<Conversation>
  setArchived(request: { readonly conversationId: ConversationId; readonly archived: boolean }): Promise<Conversation>
  setPinned(request: { readonly conversationId: ConversationId; readonly pinned: boolean }): Promise<Conversation>
  deleteConversation(request: { readonly conversationId: ConversationId }): Promise<void>
  closeTemporary(request: { readonly conversationId: ConversationId }): Promise<void>
  selectBranch(request: { readonly conversationId: ConversationId; readonly branchId: BranchId }): Promise<ConversationDetail>
  branch(request: BranchRequest): Promise<ConversationDetail>
  selectArchive(request: { readonly conversationId: ConversationId; readonly selection: { readonly revisionId: ArchiveRevisionId; readonly nodeId?: string } }): Promise<ConversationDetail>
  /** Select a plugin-owned continuation without changing the source archive. */
  continueArchive(request: { readonly conversationId: ConversationId }): Promise<ConversationDetail>
  previewImport(request: { readonly fileName: string; readonly base64: string }): Promise<ImportPreview>
  commitImport(request: { readonly previewId: ImportPreviewId }): Promise<ImportResult>
  listImports(): Promise<readonly ImportBatch[]>
  undoImport(request: { readonly batchId: ImportBatchId }): Promise<ImportUndoResult>
  memoryState(request: { readonly conversationId?: ConversationId }): Promise<MemoryState>
  updateProfile(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number; readonly background: string; readonly instructions: string; readonly autoSaveLowRisk: boolean; readonly referenceChats: boolean; readonly source?: ProfileImportSource }): Promise<PersonalProfile>
  proposeMemory(request: CandidateInput): Promise<MemoryCandidate>
  decideCandidate(request: { readonly conversationId?: ConversationId; readonly candidateId: CandidateId; readonly expectedRevision: number; readonly decision: 'confirm' | 'reject' }): Promise<MemoryCandidate>
  editMemory(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number; readonly text: string }): Promise<Memory>
  forgetMemory(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number }): Promise<Memory>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'personal-chat/failed': { readonly reason: string }
    'personal-chat/forbidden': Record<string, never>
  }
}
