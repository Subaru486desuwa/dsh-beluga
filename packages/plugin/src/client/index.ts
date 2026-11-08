import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import personalRemote from 'dsh-beluga/remote'
import type { PersonalChatOperations, ChatAttachment } from '../shared/types.ts'
import { PersonalModel } from './model.ts'
import { exportUpload } from './export-upload.ts'
import type { PersonalCommands, PersonalInjected } from './contract.ts'
import { createPersonalViewStore } from './stores.ts'
import { PersonalPage, PersonalPanelIcon } from './Page.tsx'
import { PersonalNotice } from './Notice.tsx'
import { en, zh } from './locales.ts'

const PANEL = 'personal-chat' as MainPanelId
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
  await ctx.inject(['slots', 'locale', 'remote', 'remote.personalChat', 'layout'], mountView).await()
}
function mountView(ctx: Context): void {
  let model: PersonalModel | undefined
  ctx.effect(() => async () => { await model?.dispose() }, 'personal-chat: runtime')
  ctx.effect(() => ctx.locale.register('personalChat', 'en', en), 'personal-chat: English')
  ctx.effect(() => ctx.locale.register('personalChat', 'zh', zh), 'personal-chat: Chinese')
  const remote = ctx.remote.personalChat
  const api: PersonalChatOperations = {
    limits: () => unwrap(remote.limits()),
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
  }
  const instance = new PersonalModel(api)
  model = instance
  const commands: PersonalCommands = {
    create: temporary => instance.run(() => instance.create(temporary)), open: id => instance.run(() => instance.open(id)), close: () => instance.run(() => instance.close()),
    releaseTemporary: id => instance.releaseTemporary(id),
    rename: title => instance.run(() => instance.rename(title), 'changed'), archive: value => instance.run(() => instance.archive(value), 'changed'), pin: value => instance.run(() => instance.pin(value), 'changed'), delete: () => instance.run(() => instance.delete(), 'deleted'),
    search: (query, archived) => { void instance.search(query, archived) }, selectBranch: id => instance.run(() => instance.selectBranch(id)), selectArchive: selection => instance.run(() => instance.selectArchive(selection)),
    continueArchive: text => instance.run(() => instance.continueArchive(text)), send: (text, attachments) => instance.run(() => instance.send(text, attachments)), stop: () => instance.run(() => instance.stop()), chooseModel: selected => instance.chooseModel(selected), setWeb: enabled => instance.setWeb(enabled),
    branch: (id, action, text) => instance.run(() => instance.branch(id, action, text)),
    removeAttachment: id => instance.run(() => instance.removeAttachment(id)),
    upload: async file => { let result: ChatAttachment | undefined; await instance.run(async () => { result = await instance.upload(file.name, await fileBase64(file, instance.state.getSnapshot().limits?.attachmentBytes ?? 0)) }); return result },
    attachment: (id, original) => instance.attachment(id, original), previewFile: (id, sheet) => instance.previewFile(id, sheet), exportPdf: id => instance.exportPdf(id),
    section: section => instance.run(() => instance.section(section)),
    proposeMemory: (text, category, source) => instance.run(() => instance.proposeMemory(text, category, source)),
    updateProfile: profile => instance.run(() => instance.updateProfile(profile), 'changed'), decide: (candidate, decision) => instance.run(() => instance.decide(candidate, decision), 'changed'), editMemory: (memory, text) => instance.run(() => instance.editMemory(memory, text), 'memoryUpdated'), forget: memory => instance.run(() => instance.forget(memory), 'memoryUpdated'),
    preview: file => instance.run(async () => { await instance.preview(file.name, bytesBase64(await exportUpload(file, instance.state.getSnapshot().limits))) }), discardPreview: () => instance.discardPreview(),
    commitImport: () => instance.run(() => instance.commitImport(), 'importComplete'), undoImport: id => instance.run(() => instance.undoImport(id)),
    retry: () => { void instance.refresh() },
    work: () => { if (instance.state.getSnapshot().detail?.conversation.temporary) void instance.run(async () => { await instance.close(); ctx.layout.selectPanel(null) }); else ctx.layout.selectPanel(null) },
    dismissNotice: () => instance.dismissNotice(),
  }
  const face = (): PersonalInjected => ({ hooks: { personal: instance.state }, commands })
  const navigation = createPersonalViewStore()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL, locale: 'personalChat', store: navigation,
    inject: (actions: BoundActions<typeof navigation>): PersonalInjected => {
      const remember = async (operation: Promise<boolean>): Promise<boolean> => {
        const ok = await operation
        const selected = instance.state.getSnapshot().detail?.conversation
        actions.select(selected === undefined || selected.temporary ? null : selected.id)
        return ok
      }
      return { ...face(), commands: { ...commands, create: temporary => remember(commands.create(temporary)), open: id => remember(commands.open(id)), close: () => remember(commands.close()), delete: () => remember(commands.delete()) } }
    },
  }, PersonalPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: -100, locale: 'personalChat', label: () => ctx.locale.bind('personalChat')('panel') }, PersonalPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'personal.notice', locale: 'personalChat', inject: face }, PersonalNotice))
  const layout = ctx.layout
  ctx.effect(() => () => { if (layout.panelInfo.getSnapshot().activePanelId === PANEL) layout.selectPanel(null) }, 'personal-chat: selected panel')
  void instance.start()
}
