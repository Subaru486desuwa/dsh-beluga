import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchiveSelection, BranchId, ConversationId, ImportBatchId, Memory, MemorySource, MemoryCandidate, OfficePreview, PersonalProfile, ChatAttachment } from '../shared/types.ts'
import type { ModelRef } from '../shared/models.ts'
import type { createPersonalViewStore } from './stores.ts'
import type { PersonalState } from './model.ts'
import type { PersonalChatKey } from './locales.ts'

export interface PersonalCommands {
  create(temporary: boolean): Promise<boolean>
  open(id: ConversationId): Promise<boolean>
  close(): Promise<boolean>
  releaseTemporary(id: ConversationId): void
  rename(title: string): Promise<boolean>
  archive(value: boolean): Promise<boolean>
  pin(value: boolean): Promise<boolean>
  delete(): Promise<boolean>
  search(query: string, archived: boolean): void
  selectBranch(id: BranchId): Promise<boolean>
  selectArchive(selection: { revisionId: ArchiveSelection['revisionId']; nodeId?: string }): Promise<boolean>
  continueArchive(text: string): Promise<boolean>
  send(text: string, attachments: readonly string[]): Promise<boolean>
  stop(): Promise<boolean>
  chooseModel(model: ModelRef): void
  setWeb(web: boolean): void
  branch(messageId: string, action: 'edit' | 'regenerate' | 'fork', text?: string): Promise<boolean>
  removeAttachment(id: string): Promise<boolean>
  upload(file: File): Promise<ChatAttachment | undefined>
  attachment(id: string, original?: boolean): Promise<{ name: string; mediaType: string; base64: string }>
  previewFile(id: string, sheet?: string): Promise<OfficePreview>
  exportPdf(id: string): Promise<{ name: string; base64: string }>
  section(section: PersonalState['section']): Promise<boolean>
  proposeMemory(text: string, category: Memory['category'], source: MemorySource): Promise<boolean>
  updateProfile(profile: PersonalProfile): Promise<boolean>
  decide(candidate: MemoryCandidate, decision: 'confirm' | 'reject'): Promise<boolean>
  editMemory(memory: Memory, text: string): Promise<boolean>
  forget(memory: Memory): Promise<boolean>
  preview(file: File): Promise<boolean>
  discardPreview(): void
  commitImport(): Promise<boolean>
  undoImport(id: ImportBatchId): Promise<boolean>
  retry(): void
  work(): void
  dismissNotice(): void
}
export interface PersonalInjected { hooks: { personal: HostObservable<PersonalState> }; commands: PersonalCommands }
export type PersonalPageProps = PropsRuntime<'main'> & PropsLocale<'personalChat'> & InjectFace<PersonalInjected> & PropsStore<ReturnType<typeof createPersonalViewStore>>
export type NoticeProps = PropsLocale<'personalChat'> & InjectFace<PersonalInjected>
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { personalChat: PersonalChatKey } }
