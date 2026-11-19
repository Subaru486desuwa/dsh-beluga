import type { ComponentType } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppsChange, ArchiveSelection, BranchId, ConversationId, ImportBatchId, Memory, MemorySource, MemoryCandidate, OfficePreview, PersonalProfile, ChatAttachment, WorkSessionRef, WorkspaceRef } from '../shared/types.ts'
import type { ModelRef } from '../shared/models.ts'
import type { createPersonalListStore, createPersonalViewStore } from './stores.ts'
import type { ChatOrder } from './list.ts'
import type { PersonalState, SettingsTab } from './model.ts'
import type { PersonalChatKey } from './locales.ts'

export interface PersonalCommands {
  create(temporary: boolean): Promise<boolean>
  /** Turn Temporary Chat on or off for the empty chat on screen; the composer keeps its text. */
  setTemporary(temporary: boolean): Promise<boolean>
  open(id: ConversationId): Promise<boolean>
  close(): Promise<boolean>
  releaseTemporary(id: ConversationId): void
  rename(title: string): Promise<boolean>
  archive(value: boolean): Promise<boolean>
  pin(value: boolean): Promise<boolean>
  delete(): Promise<boolean>
  /** Unarchive a chat from the archived list. */
  restore(id: ConversationId): Promise<boolean>
  /** Delete a chat from the archived list. */
  remove(id: ConversationId): Promise<boolean>
  search(query: string): void
  selectBranch(id: BranchId): Promise<boolean>
  selectArchive(selection: { revisionId: ArchiveSelection['revisionId']; nodeId?: string }): Promise<boolean>
  continueArchive(text: string): Promise<boolean>
  send(text: string, attachments: readonly string[]): Promise<boolean>
  stop(): Promise<boolean>
  chooseModel(model: ModelRef): void
  /** @param effort - an effort the selected route offers, or undefined for the route's default. */
  chooseEffort(effort: string | undefined): void
  setWeb(web: boolean): void
  setGitHub(github: boolean): void
  updateApps(change: AppsChange): Promise<boolean>
  /** Write a brief from the open chat and put it in a new Work session's composer in `workspace`, for the person to send. */
  handOff(workspace: WorkspaceRef): Promise<boolean>
  /** Show a Work session a reply read. */
  openWork(sessionId: WorkSessionRef): void
  /** Read apps and Work workspaces again. */
  refreshApps(): Promise<boolean>
  /** @param source - a pasted token, or this computer's GitHub CLI sign-in. */
  connectGitHub(source: { readonly token: string } | { readonly cli: true }): Promise<boolean>
  disconnectGitHub(): Promise<boolean>
  /** Answer the GitHub action the running reply waits on. */
  decideAction(actionId: string, allow: boolean): Promise<boolean>
  branch(messageId: string, action: 'edit' | 'regenerate' | 'fork', text?: string): Promise<boolean>
  removeAttachment(id: string): Promise<boolean>
  upload(file: File): Promise<ChatAttachment | undefined>
  attachment(id: string, original?: boolean): Promise<{ name: string; mediaType: string; base64: string }>
  previewFile(id: string, sheet?: string): Promise<OfficePreview>
  exportPdf(id: string): Promise<{ name: string; base64: string }>
  openSettings(tab: SettingsTab): Promise<boolean>
  closeSettings(): void
  proposeMemory(text: string, category: Memory['category'], source: MemorySource): Promise<boolean>
  updateProfile(profile: PersonalProfile): Promise<boolean>
  decide(candidate: MemoryCandidate, decision: 'confirm' | 'reject'): Promise<boolean>
  editMemory(memory: Memory, text: string): Promise<boolean>
  forget(memory: Memory): Promise<boolean>
  refreshSummary(): Promise<boolean>
  /** @returns the answer to show, empty when only the summary changed; undefined when the request failed. */
  askSummary(text: string): Promise<string | undefined>
  /** @param expectedRevision - the revision the person started editing, so a change made meanwhile is not overwritten. */
  editSummary(text: string, expectedRevision: number): Promise<boolean>
  undoSummary(): Promise<boolean>
  clearSummary(): Promise<boolean>
  /** @param options - `model` absent follows the route of the last message sent. */
  summaryOptions(options: { readonly model?: ModelRef; readonly sensitive: boolean }): Promise<boolean>
  /** Open a new normal chat and send `text`, as a suggestion under the summary does. */
  startChat(text: string): Promise<boolean>
  preview(file: File): Promise<boolean>
  discardPreview(): void
  commitImport(): Promise<boolean>
  undoImport(id: ImportBatchId): Promise<boolean>
  retry(): void
  dismissNotice(): void
}
export interface PersonalInjected { hooks: { personal: HostObservable<PersonalState> }; commands: PersonalCommands }
export type PersonalPageProps = PropsRuntime<'main'> & PropsLocale<'personalChat'> & InjectFace<PersonalInjected> & PropsStore<ReturnType<typeof createPersonalViewStore>>
export type NoticeProps = PropsLocale<'personalChat'> & InjectFace<PersonalInjected>
/**
 * The Chat sidebar region and the Settings dialog also change how the chat list is ordered.
 * `seated` is true while the sidebar primary action or Work's New Session carries New chat, which then leaves the region.
 */
export interface NavigationInjected extends PersonalInjected { hooks: PersonalInjected['hooks'] & { seated: HostObservable<boolean> }; setOrder(order: ChatOrder): void }
export type NavigationProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'personalChat'> & InjectFace<NavigationInjected> & PropsStore<ReturnType<typeof createPersonalListStore>>
export type SettingsProps = PropsLocale<'personalChat'> & InjectFace<NavigationInjected> & PropsStore<ReturnType<typeof createPersonalListStore>>
/** Props Harness gives a primary action icon. */
export interface PrimaryActionIconProps { readonly size: number }
/**
 * One sidebar primary action, as Harness's `ctx.sidebarPrimaryAction.register` takes it (deepseek-harness ui-sidebar README, Primary action).
 * The lowest `priority` among live registrations runs from the sidebar button, the title-bar control, the brand, and `session.new`.
 */
export interface SidebarPrimaryAction {
  readonly id: string
  readonly label: string | (() => string)
  readonly icon: ComponentType<PrimaryActionIconProps>
  readonly priority?: number
  /** A reason the action refuses to run, or null while it can. */
  readonly blocked?: { getSnapshot(): string | null; subscribe(listener: () => void): () => void }
  run(): void
}
/** Harness's sidebar primary action registry. */
export interface SidebarPrimaryActions {
  /** @returns a disposer that removes the registration. */
  register(action: SidebarPrimaryAction): () => void
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Harness 0.2.1-rc.3 does not provide this service, so Beluga waits for it with `ctx.inject` and answers New Session's call on Chat's page instead (`new-session.ts`).
     * Delete this declaration once Beluga builds against a Harness whose ui-sidebar declares it.
     */
    sidebarPrimaryAction: SidebarPrimaryActions
  }
}
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { personalChat: PersonalChatKey } }
