/** The open chat in Chat's main panel; the chat list lives in the sidebar region (ADR 0005) and Settings in its own dialog. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconEllipsisOutlineRegular, IconQueueOutlineRegular, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppsView, ConversationDetail, WorkspaceRef } from '../shared/types.ts'
import type { PersonalCommands, PersonalPageProps } from './contract.ts'
import type { PersonalState } from './model.ts'
import { ArchiveHistory } from './Archive.tsx'
import { ChatMessages } from './Chat.tsx'
import { Composer, DropOverlay, useDropZone, useTray } from './Composer.tsx'
import { conversationMarkdown, exportName, saveFile } from './export.ts'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

/** Sidebar-owned global navigation glyph. @param props - Sidebar icon dimensions. @returns the existing chat/history glyph. */
export function PersonalPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconQueueOutlineRegular size={size} /> }

/** A chat that holds an image can only go on with a route that reads images. */
function holdsImages(detail: ConversationDetail | undefined): boolean {
  if (!detail) return false
  const images = new Set(detail.attachments.filter(file => file.image).map(file => file.id))
  return detail.messages.some(message => message.attachmentIds.some(id => images.has(id)))
}

/**
 * The open chat, or the empty one about to start: the thread (or greeting) above the composer.
 * Keyed by navigation, so moving to another chat starts with an empty composer.
 */
function ChatPane({ state, commands, imagesNeeded, t }: { state: PersonalState; commands: PersonalCommands; imagesNeeded: boolean; t: T }) {
  const detail = state.detail
  const conversation = detail?.conversation
  const tray = useTray(commands, state.limits?.attachmentBytes)
  const uploadable = !detail?.live && !conversation?.archived && !!state.limits
  const drop = useDropZone(tray, uploadable)
  const branch = conversation?.branches.find(item => item.id === conversation.selectedBranchId)
  const temporary = conversation ? conversation.temporary : state.draftTemporary
  const landing = !detail || (!detail.archive && detail.messages.length === 0 && !detail.live && !detail.error)
  const top = conversation && <>
    {temporary && <p className={css.threadNote} role="status">{t('temporaryNotice')}</p>}
    {conversation.archiveWithdrawn && <p className={css.threadNote}>{t('withdrawn')}</p>}
    {branch?.snapshot && branch.snapshot.omittedNodes > 0 && <p className={css.threadNote}>{t('snapshotOmitted', { count: branch.snapshot.omittedNodes })}</p>}
    {detail.archive && <ArchiveHistory archive={detail.archive} conversation={conversation} commands={commands} busy={state.busy} t={t} />}
  </>
  return <div className={css.pane} data-landing={landing || undefined} {...drop.handlers}>
    {landing ? <div className={css.landing}><h1>{t(temporary ? 'temporary' : 'greeting')}</h1>{temporary && <p>{t('temporaryNotice')}</p>}</div>
      : branch === undefined ? <div className={css.thread}><div className={css.messages}><div className={css.messageColumn}>{top}</div></div></div>
        : <ChatMessages state={state} commands={commands} t={t}>{top}</ChatMessages>}
    <div className={css.dock}>
      {conversation?.archived ? <div className={css.archivedBar}><span>{t('archivedNotice')}</span><Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void commands.archive(false) }}>{t('restore')}</Button></div>
        : <Composer state={state} commands={commands} tray={tray} imagesNeeded={imagesNeeded} uploadable={uploadable} t={t} />}
    </div>
    {drop.over && <DropOverlay t={t} />}
  </div>
}

/**
 * Pick a workspace; the brief is written and put into a new Work session there, for the person to send.
 * @param props.workspace - the pick, null before one is made; undefined keeps the dialog closed.
 */
function HandOffDialog({ apps, workspace, busy, choose, close, confirm, t }: { apps: AppsView | undefined; workspace: WorkspaceRef | null | undefined; busy: boolean; choose: (id: WorkspaceRef) => void; close: () => void; confirm: (id: WorkspaceRef) => void; t: T }) {
  const workspaces = apps?.work.workspaces ?? []
  return <Modal open={workspace !== undefined} title={t('handOff')} description={t('handOffBody')} closeLabel={t('cancel')} onClose={() => { if (!busy) close() }} footer={<><Button disabled={busy} onClick={close}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !workspace} onClick={() => { if (workspace) confirm(workspace) }}>{t(busy ? 'handOffWriting' : 'handOffConfirm')}</Button></>}>
    {workspaces.length ? <fieldset className={css.appLevels} disabled={busy}>
      <legend>{t('workspace')}</legend>
      {workspaces.map(item => <label key={item.id} className={css.appCheck}><input type="radio" name="personal-handoff-workspace" checked={workspace === item.id} onChange={() => { choose(item.id) }} /><span>{item.title}<small>{item.path}</small></span></label>)}
    </fieldset> : <p className={css.muted}>{apps ? t('handOffNoWorkspace') : t('loading')}</p>}
  </Modal>
}

/** Render the open chat without changing the Work Session binding. @param props - Authoritative views, command callbacks and nested native slot. @returns the Personal Chat page. */
export function PersonalPage({ usePersonal, commands, useStore, t }: PersonalPageProps) {
  const state = usePersonal(value => value)
  const savedConversation = useStore(value => value.conversationId)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    if (savedConversation !== null && state.detail === undefined) void commands.open(savedConversation)
  }, [commands, savedConversation, state.detail])
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<string | undefined>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [handOff, setHandOff] = useState<WorkspaceRef | null | undefined>()
  const startHandOff = () => { setHandOff(null); void commands.refreshApps() }
  const detail = state.detail
  const conversation = detail?.conversation
  const temporary = conversation?.temporary === true
  const currentCommands = useRef(commands)
  currentCommands.current = commands
  useEffect(() => { const id = temporary ? conversation?.id : undefined; return () => { if (id) currentCommands.current.releaseTemporary(id) } }, [temporary, conversation?.id])
  const exportChat = (value: ConversationDetail) => { saveFile(exportName(value.conversation.title), new Blob([conversationMarkdown(value, { user: t('roleUser'), assistant: t('roleAssistant') })], { type: 'text/markdown' })) }
  const imagesNeeded = holdsImages(detail)
  return <div className={css.page}>
    <main className={css.detail}>
      <header className={css.detailHead}>
        <h2>{temporary || (!conversation && state.draftTemporary) ? t('temporary') : conversation?.title || t('newChat')}</h2>
        {conversation !== undefined && <div className={css.headerActions}>
          {temporary ? <><Button size="sm" variant="outline" disabled={state.busy || !detail?.messages.length} onClick={startHandOff}>{t('handOff')}</Button><Button size="sm" disabled={state.busy} onClick={() => { void commands.close() }}>{t('closeTemporary')}</Button></> : <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal align="end" autoFocus anchor={<button type="button" className={css.iconAction} aria-label={t('more')} aria-haspopup="menu" aria-expanded={menuOpen} disabled={state.busy} onClick={() => { setMenuOpen(value => !value) }}><IconEllipsisOutlineRegular size={20} /></button>} items={[
            { id: 'rename', label: t('rename') },
            { id: 'pin', label: t(conversation.pinned ? 'unpin' : 'pin') },
            { id: 'export', label: t('exportMarkdown') },
            { id: 'handoff', label: t('handOff'), disabled: !detail?.messages.length },
            { id: 'archive', label: t(conversation.archived ? 'restore' : 'archive') },
            { id: 'delete', label: t('delete'), danger: true },
          ]} onSelect={id => { setMenuOpen(false); if (id === 'rename') setRename(conversation.title); else if (id === 'pin') void commands.pin(!conversation.pinned); else if (id === 'export') exportChat(detail!); else if (id === 'handoff') startHandOff(); else if (id === 'archive') void commands.archive(!conversation.archived); else if (id === 'delete') setDeleteOpen(true) }} />}
        </div>}
      </header>
      <ChatPane key={state.navigation} state={state} commands={commands} imagesNeeded={imagesNeeded} t={t} />
    </main>
    <Modal open={rename !== undefined} title={t('rename')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setRename(undefined) }} footer={<><Button disabled={state.busy} onClick={() => { setRename(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy || !rename?.trim()} onClick={() => { void commands.rename(rename!).then(ok => { if (ok) setRename(undefined) }) }}>{t('save')}</Button></>}><input className={css.field} aria-label={t('title')} value={rename ?? ''} onChange={event => { setRename(event.target.value) }} /></Modal>
    <HandOffDialog apps={state.apps} workspace={handOff} busy={state.busy} choose={setHandOff} close={() => { setHandOff(undefined) }} confirm={id => { void commands.handOff(id).then(ok => { if (ok) setHandOff(undefined) }) }} t={t} />
    <Modal open={deleteOpen} title={t('deleteTitle')} description={t('deleteBody')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setDeleteOpen(false) }} footer={<><Button disabled={state.busy} onClick={() => { setDeleteOpen(false) }}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy} onClick={() => { void commands.delete().then(ok => { if (ok) setDeleteOpen(false) }) }}>{t('confirmDelete')}</Button></>} />
  </div>
}
