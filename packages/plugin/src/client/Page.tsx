/** Personal Chat list and detail share one global panel, independent of Work selection. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconQueueOutlineRegular, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BranchId, ConversationDetail } from '../shared/types.ts'
import type { PersonalPageProps } from './contract.ts'
import { ArchiveHistory } from './Archive.tsx'
import { MemoryPage } from './Memory.tsx'
import { ImportPage } from './Import.tsx'
import { ChatMessages, ChatComposer } from './Chat.tsx'
import { conversationMarkdown, exportName, saveFile } from './export.ts'
import css from './PersonalChat.module.css'

/** Sidebar-owned global navigation glyph. @param props - Sidebar icon dimensions. @returns the existing chat/history glyph. */
export function PersonalPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconQueueOutlineRegular size={size} /> }

/** Render conversations and management without changing the Work Session binding. @param props - Authoritative views, command callbacks and nested native slot. @returns the Personal Chat page. */
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
  const detail = state.detail
  const conversation = detail?.conversation
  const branch = conversation?.branches.find(item => item.id === conversation.selectedBranchId)
  const temporary = conversation?.temporary === true
  const currentCommands = useRef(commands)
  currentCommands.current = commands
  useEffect(() => { const id = temporary ? conversation?.id : undefined; return () => { if (id) currentCommands.current.releaseTemporary(id) } }, [temporary, conversation?.id])
  const exportChat = (value: ConversationDetail) => { saveFile(exportName(value.conversation.title), new Blob([conversationMarkdown(value, { user: t('roleUser'), assistant: t('roleAssistant') })], { type: 'text/markdown' })) }
  const candidates = state.memory?.candidates.filter(candidate => candidate.state === 'pending').length ?? 0
  const history = detail?.archive && <ArchiveHistory archive={detail.archive} conversation={conversation!} commands={commands} busy={state.busy} t={t} />
  return <div className={css.page} data-detail={detail !== undefined || state.section !== 'chats'}>
    <aside className={css.history} aria-label={t('history')}>
      <div className={css.historyHead}><h1>{t('panel')}</h1><Button size="sm" onClick={commands.work}>{t('work')}</Button></div>
      <Button variant="primary" disabled={state.busy} onClick={() => { void commands.create(false) }}>{t('newChat')}</Button>
      <Button disabled={state.busy} onClick={() => { void commands.create(true) }}>{t('temporary')}</Button>
      <input className={css.search} type="search" aria-label={t('search')} placeholder={t('search')} value={state.query} onChange={event => { commands.search(event.target.value, state.archived) }} />
      <div className={css.filters}><Button size="sm" aria-pressed={!state.archived} onClick={() => { commands.search(state.query, false) }}>{t('active')}</Button><Button size="sm" aria-pressed={state.archived} onClick={() => { commands.search(state.query, true) }}>{t('archived')}</Button></div>
      <div className={css.historyRows}>{state.status === 'loading' ? <div className={css.skeleton} aria-label={t('loading')} /> : state.status === 'failed' ? <div className={css.loadError}><p>{t('loadFailed')}</p><Button onClick={commands.retry}>{t('retry')}</Button></div> : state.results.length === 0 ? <p className={css.muted}>{t('noResults')}</p> : state.results.map(item => <button key={item.id} type="button" className={css.historyRow} aria-current={item.id === conversation?.id ? 'page' : undefined} disabled={state.busy} onClick={() => { void commands.open(item.id) }}><span>{item.title || t('newChat')}</span><time>{item.pinned ? t('pinned') + ' · ' : ''}{new Date(item.updatedAt).toLocaleDateString()}</time></button>)}</div>
      <div className={css.managementNav}><Button disabled={state.busy || temporary} onClick={() => { void commands.section('memory') }}>{t('memory')}{candidates > 0 ? ` (${candidates})` : ''}</Button><Button disabled={state.busy || temporary} onClick={() => { void commands.section('imports') }}>{t('import')}</Button></div>
    </aside>
    <main className={css.detail}>
      <header className={css.detailHead}>
        <Button size="sm" className={css.back} aria-label={t('back')} title={t('back')} disabled={state.busy} onClick={() => { void commands.close().then(ok => { if (ok) void commands.section('chats') }) }}>←</Button>
        <h2>{state.section === 'memory' ? t('memory') : state.section === 'imports' ? t('importTitle') : temporary ? t('temporary') : conversation?.title || t('newChat')}</h2>
        {state.section === 'chats' && conversation !== undefined && <div className={css.headerActions}>
          {temporary ? <Button size="sm" disabled={state.busy} onClick={() => { void commands.close() }}>{t('closeTemporary')}</Button> : <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal autoFocus anchor={<Button size="sm" aria-label={t('more')} title={t('more')} disabled={state.busy} onClick={() => { setMenuOpen(value => !value) }}>⋯</Button>} items={[
            { id: 'rename', label: t('rename') },
            { id: 'pin', label: t(conversation.pinned ? 'unpin' : 'pin') },
            { id: 'export', label: t('exportMarkdown') },
            { id: 'archive', label: t(conversation.archived ? 'restore' : 'archive') },
            { id: 'delete', label: t('delete'), danger: true },
          ]} onSelect={id => { setMenuOpen(false); if (id === 'rename') setRename(conversation.title); else if (id === 'pin') void commands.pin(!conversation.pinned); else if (id === 'export') exportChat(detail!); else if (id === 'archive') void commands.archive(!conversation.archived); else if (id === 'delete') setDeleteOpen(true) }} />}
        </div>}
      </header>
      {state.section === 'memory' && state.memory !== undefined ? <MemoryPage canAdd={!temporary} memory={state.memory} commands={commands} busy={state.busy} t={t} /> : state.section === 'imports' ? <ImportPage state={state} commands={commands} t={t} /> : detail === undefined ? <div className={css.empty}><IconQueueOutlineRegular size={32} /><h2>{t('emptyTitle')}</h2><p>{t('emptyBody')}</p><Button variant="primary" disabled={state.busy} onClick={() => { void commands.create(false) }}>{t('newChat')}</Button></div> : <>
        {temporary && <p className={css.retention} role="status">{t('temporaryNotice')}</p>}
        {conversation!.archiveWithdrawn && <p className={css.notice}>{t('withdrawn')}</p>}
        {conversation!.branches.length > 1 && <label className={css.branchPicker}>{t('branches')}<select value={conversation!.selectedBranchId ?? ''} disabled={state.busy} onChange={event => { void commands.selectBranch(event.target.value as BranchId) }}>{conversation!.branches.map((item, index) => <option key={item.id} value={item.id}>{t('branch', { number: index + 1 })}</option>)}</select></label>}
        {branch?.snapshot && branch.snapshot.omittedNodes > 0 && <p className={css.notice}>{t('snapshotOmitted', { count: branch.snapshot.omittedNodes })}</p>}
        {branch === undefined ? history !== undefined && <div className={css.archiveBody}>{history}</div> : <ChatMessages state={state} commands={commands} t={t}>{history && <div className={css.archiveLead}>{history}</div>}</ChatMessages>}
        {!conversation!.archived && <ChatComposer key={conversation!.id} state={state} commands={commands} t={t} />}
      </>}
    </main>
    <Modal open={rename !== undefined} title={t('rename')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setRename(undefined) }} footer={<><Button disabled={state.busy} onClick={() => { setRename(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy || !rename?.trim()} onClick={() => { void commands.rename(rename!).then(ok => { if (ok) setRename(undefined) }) }}>{t('save')}</Button></>}><input className={css.field} aria-label={t('title')} value={rename ?? ''} onChange={event => { setRename(event.target.value) }} /></Modal>
    <Modal open={deleteOpen} title={t('deleteTitle')} description={t('deleteBody')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setDeleteOpen(false) }} footer={<><Button disabled={state.busy} onClick={() => { setDeleteOpen(false) }}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy} onClick={() => { void commands.delete().then(ok => { if (ok) setDeleteOpen(false) }) }}>{t('confirmDelete')}</Button></>} />
  </div>
}
