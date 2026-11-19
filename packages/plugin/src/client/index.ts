import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore, type BoundActions } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import personalRemote from 'dsh-beluga/remote'
import type { PersonalChatOperations, ChatAttachment, ConversationId } from '../shared/types.ts'
import { PersonalModel } from './model.ts'
import { exportUpload } from './export-upload.ts'
import type { NavigationInjected, PersonalCommands, PersonalInjected } from './contract.ts'
import { createPersonalListStore, createPersonalViewStore } from './stores.ts'
import { NewChatIcon, PersonalPage, PersonalPanelIcon } from './Page.tsx'
import { ChatNavigation, WorkPanelIcon } from './Navigation.tsx'
import { modeAfter, whileValue, type Mode, type ModePanels } from './panels.ts'
import { answerNewSession } from './new-session.ts'
import { PersonalNotice } from './Notice.tsx'
import { PersonalSettings } from './Settings.tsx'
import { en, zh } from './locales.ts'

const PANEL = 'personal-chat' as MainPanelId
/** A panel-list row whose selection hands straight back to the Conversation view, so Work sits beside Chat. */
const WORK_PANEL = 'personal-chat.work' as MainPanelId
const MODE_PANELS: ModePanels = { chat: PANEL, work: WORK_PANEL }
export const inject = ['slots', 'locale', 'remote', 'layout']
async function unwrap<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw result.error
  return result.value
}
function bytesBase64(data: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768))
  return btoa(binary)
}
async function fileBase64(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) throw new Error('File exceeds the upload size limit')
  return bytesBase64(new Uint8Array(await file.arrayBuffer()))
}
/** Mount one independent Chat destination. No Work hooks or native Session APIs are used. */
export async function apply(ctx: Context): Promise<void> {
  const unmountRemote = await ctx.remote.$mount(personalRemote)
  ctx.effect(() => unmountRemote, 'personal-chat: Remote contribution')
  // A client plugin receives no configuration, so the Host's start mode arrives over the Remote before anything mounts.
  await ctx.inject(['slots', 'locale', 'remote', 'remote.personalChat', 'layout'], async inner => { mountView(inner, await unwrap(inner.remote.personalChat.startMode())) }).await()
}
/**
 * Register Chat's page, rows, region, and New chat primary action.
 * @param startMode - the Mode this launch opens in.
 */
function mountView(ctx: Context, startMode: Mode): void {
  let model: PersonalModel | undefined
  ctx.effect(() => async () => { await model?.dispose() }, 'personal-chat: runtime')
  ctx.effect(() => ctx.locale.register('personalChat', 'en', en), 'personal-chat: English')
  ctx.effect(() => ctx.locale.register('personalChat', 'zh', zh), 'personal-chat: Chinese')
  const remote = ctx.remote.personalChat
  const api: PersonalChatOperations = {
    limits: () => unwrap(remote.limits()), startMode: () => unwrap(remote.startMode()),
    models: () => unwrap(remote.models()),
    list: request => unwrap(remote.list(request)), create: request => unwrap(remote.create(request)), get: request => unwrap(remote.get(request)),
    rename: request => unwrap(remote.rename(request)), setArchived: request => unwrap(remote.setArchived(request)), setPinned: request => unwrap(remote.setPinned(request)), deleteConversation: request => unwrap(remote.deleteConversation(request)), closeTemporary: request => unwrap(remote.closeTemporary(request)),
    send: request => unwrap(remote.send(request)), stop: request => unwrap(remote.stop(request)),
    removeAttachment: request => unwrap(remote.removeAttachment(request)),
    upload: request => unwrap(remote.upload(request)), attachment: request => unwrap(remote.attachment(request)), previewFile: request => unwrap(remote.previewFile(request)), exportPdf: request => unwrap(remote.exportPdf(request)),
    follow: signal => remote.follow(signal), followConversation: (request, signal) => remote.followConversation(request, signal),
    selectBranch: request => unwrap(remote.selectBranch(request)), branch: request => unwrap(remote.branch(request)), selectArchive: request => unwrap(remote.selectArchive(request)), continueArchive: request => unwrap(remote.continueArchive(request)),
    previewImport: request => unwrap(remote.previewImport(request)), commitImport: request => unwrap(remote.commitImport(request)), listImports: () => unwrap(remote.listImports()), undoImport: request => unwrap(remote.undoImport(request)),
    memoryState: request => unwrap(remote.memoryState(request)), updateProfile: request => unwrap(remote.updateProfile(request)), proposeMemory: request => unwrap(remote.proposeMemory(request)),
    decideCandidate: request => unwrap(remote.decideCandidate(request)), editMemory: request => unwrap(remote.editMemory(request)), forgetMemory: request => unwrap(remote.forgetMemory(request)),
    refreshSummary: request => unwrap(remote.refreshSummary(request)), askSummary: request => unwrap(remote.askSummary(request)), editSummary: request => unwrap(remote.editSummary(request)), undoSummary: request => unwrap(remote.undoSummary(request)),
    clearSummary: request => unwrap(remote.clearSummary(request)), summaryOptions: request => unwrap(remote.summaryOptions(request)),
    apps: () => unwrap(remote.apps()), updateApps: request => unwrap(remote.updateApps(request)), connectGitHub: request => unwrap(remote.connectGitHub(request)), disconnectGitHub: () => unwrap(remote.disconnectGitHub()),
    decideAction: request => unwrap(remote.decideAction(request)), handOff: request => unwrap(remote.handOff(request)),
  }
  const instance = new PersonalModel(api)
  model = instance
  const commands: PersonalCommands = {
    create: temporary => instance.run(() => instance.create(temporary)), open: id => instance.run(() => instance.open(id)), close: () => instance.run(() => instance.close()),
    setTemporary: temporary => instance.run(() => instance.setTemporary(temporary)),
    releaseTemporary: id => instance.releaseTemporary(id),
    rename: title => instance.run(() => instance.rename(title), 'changed'), archive: value => instance.run(() => instance.archive(value), 'changed'), pin: value => instance.run(() => instance.pin(value), 'changed'), delete: () => instance.run(() => instance.delete(), 'deleted'),
    restore: id => instance.run(() => instance.setArchived(id, false), 'changed'), remove: id => instance.run(() => instance.remove(id), 'deleted'),
    search: query => { void instance.search(query) }, selectBranch: id => instance.run(() => instance.selectBranch(id)), selectArchive: selection => instance.run(() => instance.selectArchive(selection)),
    continueArchive: text => instance.run(() => instance.continueArchive(text)), send: (text, attachments) => instance.run(() => instance.send(text, attachments)), stop: () => instance.run(() => instance.stop()), chooseModel: selected => instance.chooseModel(selected), chooseEffort: effort => instance.chooseEffort(effort), setWeb: enabled => instance.setWeb(enabled),
    branch: (id, action, text) => instance.run(() => instance.branch(id, action, text)),
    removeAttachment: id => instance.run(() => instance.removeAttachment(id)),
    upload: async file => { let result: ChatAttachment | undefined; await instance.run(async () => { result = await instance.upload(file.name, await fileBase64(file, instance.state.getSnapshot().limits?.attachmentBytes ?? 0)) }); return result },
    attachment: (id, original) => instance.attachment(id, original), previewFile: (id, sheet) => instance.previewFile(id, sheet), exportPdf: id => instance.exportPdf(id),
    openSettings: tab => instance.run(() => instance.openSettings(tab)), closeSettings: () => instance.closeSettings(),
    proposeMemory: (text, category, source) => instance.run(() => instance.proposeMemory(text, category, source)),
    updateProfile: profile => instance.run(() => instance.updateProfile(profile), 'changed'), decide: (candidate, decision) => instance.run(() => instance.decide(candidate, decision), 'changed'), editMemory: (memory, text) => instance.run(() => instance.editMemory(memory, text), 'memoryUpdated'), forget: memory => instance.run(() => instance.forget(memory), 'memoryUpdated'),
    refreshSummary: () => instance.run(() => instance.refreshSummary()),
    askSummary: async text => { let reply: string | undefined; await instance.run(async () => { reply = await instance.askSummary(text) }); return reply },
    editSummary: (text, expectedRevision) => instance.run(() => instance.editSummary(text, expectedRevision)),
    undoSummary: () => instance.run(() => instance.undoSummary()), clearSummary: () => instance.run(() => instance.clearSummary()),
    summaryOptions: options => instance.run(() => instance.summaryOptions(options)),
    startChat: text => instance.run(() => instance.startChat(text)),
    preview: file => instance.run(async () => { await instance.preview(file.name, bytesBase64(await exportUpload(file, instance.state.getSnapshot().limits))) }), discardPreview: () => instance.discardPreview(),
    commitImport: () => instance.run(() => instance.commitImport(), 'importComplete'), undoImport: id => instance.run(() => instance.undoImport(id)),
    setGitHub: github => instance.setGitHub(github),
    updateApps: change => instance.run(() => instance.updateApps(change), 'changed'),
    connectGitHub: source => instance.run(() => instance.connectGitHub(source), 'githubConnectedNotice'), disconnectGitHub: () => instance.run(() => instance.disconnectGitHub()),
    decideAction: (actionId, allow) => instance.run(() => instance.decideAction(actionId, allow)),
    // Work's navigation opens the session and then reveals Work itself. Selecting a panel here would
    // abort the pending navigation that `startSession` begins, leaving the brief unwritten.
    handOff: workspace => instance.run(async () => {
      const work = ctx.get('uiWorkspace')
      if (!work) throw new Error(ctx.locale.bind('personalChat')('workUnavailable'))
      const prompt = await instance.brief()
      work.startSession(workspace, { prompt, whenDraftExists: 'append' })
    }),
    refreshApps: () => instance.run(() => instance.loadApps()),
    openWork: sessionId => {
      void instance.run(async () => {
        const work = ctx.get('uiWorkspace')
        if (!work) throw new Error(ctx.locale.bind('personalChat')('workUnavailable'))
        work.openSession(sessionId)
      })
    },
    retry: () => { void instance.refresh() },
    dismissNotice: () => instance.dismissNotice(),
  }
  const face = (): PersonalInjected => ({ hooks: { personal: instance.state }, commands })
  const navigation = createPersonalViewStore()
  // The main panel's store remembers the open chat; the sidebar region opens chats too, so both remember through it.
  let rememberChat: ((id: ConversationId | null) => void) | undefined
  const remember = async (operation: Promise<boolean>): Promise<boolean> => {
    const ok = await operation
    const selected = instance.state.getSnapshot().detail?.conversation
    rememberChat?.(selected === undefined || selected.temporary ? null : selected.id)
    return ok
  }
  // A new chat is saved by its first message or file, so those are where its identity first exists.
  const remembering: PersonalCommands = { ...commands, create: temporary => remember(commands.create(temporary)), open: id => remember(commands.open(id)), close: () => remember(commands.close()), delete: () => remember(commands.delete()), remove: id => remember(commands.remove(id)),
    send: (text, attachments) => remember(commands.send(text, attachments)), startChat: text => remember(commands.startChat(text)),
    upload: async file => { const result = await commands.upload(file); await remember(Promise.resolve(true)); return result } }
  const layout = ctx.layout
  // The Mode starts as the configured one and then follows panel selections; it is not persisted (GLOSSARY.md: Mode).
  const mode = createSnapshotStore<Mode>(modeAfter(layout.panelInfo.getSnapshot().activePanelId, startMode, MODE_PANELS), { flush: 'sync' })
  ctx.effect(() => layout.panelInfo.subscribe(() => { mode.set(modeAfter(layout.panelInfo.getSnapshot().activePanelId, mode.getSnapshot(), MODE_PANELS)) }), 'personal-chat: Mode')
  let landed = false
  ctx.slots.inject('main', () => {
    const off = ctx.slots.register({
      name: 'main', key: PANEL, locale: 'personalChat', store: navigation,
      inject: (actions: BoundActions<typeof navigation>): PersonalInjected => { rememberChat = actions.select; return { ...face(), commands: remembering } },
    }, PersonalPage)
    // Land on Chat once per launch, and only if nothing was selected before Chat's panel existed.
    if (!landed && startMode === 'chat' && layout.panelInfo.getSnapshot().activePanelId === null) layout.selectPanel(PANEL)
    landed = true
    return off
  })
  /** Show Chat's page before a sidebar action changes the open chat, so the chat it opens is visible. */
  const reveal = () => { if (layout.panelInfo.getSnapshot().activePanelId !== PANEL) layout.selectPanel(PANEL) }
  const revealing: PersonalCommands = { ...remembering, create: temporary => { reveal(); return remembering.create(temporary) }, open: id => { reveal(); return remembering.open(id) } }
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: -101, locale: 'personalChat', label: () => ctx.locale.bind('personalChat')('panel') }, PersonalPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'personal.notice', locale: 'personalChat', inject: face }, PersonalNotice))
  const list = createPersonalListStore()
  // New chat is seated outside the region while either the sidebar primary action or Harness 0.2.1-rc.3's New Session carries it.
  const seated = createSnapshotStore(false)
  let seats = 0
  const seat = (): (() => void) => { seated.set(++seats > 0); return () => { seated.set(--seats > 0) } }
  const listFace = (actions: BoundActions<typeof list>): NavigationInjected => ({ hooks: { personal: instance.state, seated }, commands: revealing, setOrder: actions.setOrder })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'personal.settings', locale: 'personalChat', store: list, inject: listFace }, PersonalSettings))
  // Chat's list takes the workspace browser's place while the Mode is Chat; removing it brings the stock browser back (ADR 0005).
  ctx.slots.inject('sidebar.workspaces', () => whileValue(mode, 'chat',
    () => ctx.slots.register({ name: 'sidebar.workspaces', priority: -1, locale: 'personalChat', store: list, inject: listFace }, ChatNavigation), () => { instance.closeSettings() }))
  // A Harness that offers the sidebar primary action gets New chat there in place of New Session while the Mode is Chat, and the region drops its own.
  const blocked = { getSnapshot: () => instance.state.getSnapshot().busy ? ctx.locale.bind('personalChat')('newChatBusy') : null, subscribe: (listener: () => void) => instance.state.subscribe(listener) }
  ctx.inject(['sidebarPrimaryAction'], primary => {
    primary.effect(() => {
      const unseat = seat()
      const stop = whileValue(mode, 'chat', () => primary.sidebarPrimaryAction.register({
        id: 'personal-chat.new', label: () => ctx.locale.bind('personalChat')('newChat'), icon: NewChatIcon, priority: -1, blocked,
        run: () => { void revealing.create(false) },
      }))
      return () => { stop(); unseat() }
    }, 'personal-chat: primary action')
  })
  // Without the primary action, New Session starts a chat while Chat's page is open; elsewhere, such as Automation tasks' New task, it starts Work (ADR 0005).
  ctx.inject(['uiWorkspace'], work => {
    work.effect(() => {
      const unseat = seat()
      const restore = answerNewSession(work.uiWorkspace, () => layout.panelInfo.getSnapshot().activePanelId === PANEL && ctx.get('sidebarPrimaryAction') === undefined,
        () => { void revealing.create(false) })
      return () => { restore(); unseat() }
    }, 'personal-chat: New Session on Chat\'s page')
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORK_PANEL }, () => null))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: WORK_PANEL, order: -100, locale: 'personalChat', label: () => ctx.locale.bind('personalChat')('work') }, WorkPanelIcon))
  ctx.effect(() => layout.panelInfo.subscribe(() => { if (layout.panelInfo.getSnapshot().activePanelId === WORK_PANEL) queueMicrotask(() => { layout.selectPanel(null) }) }), 'personal-chat: Work row')
  ctx.effect(() => () => { const active = layout.panelInfo.getSnapshot().activePanelId; if (active === PANEL || active === WORK_PANEL) layout.selectPanel(null) }, 'personal-chat: selected panel')
  void instance.start()
}
