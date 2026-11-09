/** Beluga's one Settings dialog: General, Personalization, Apps and Data controls, with detail pages opened inside it. */
import { useState, type ReactNode } from 'react'
import { Button, IconAppsAddOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconPersonalizationOutlineRegular, IconSettingsOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSummary, MemoryState } from '../shared/types.ts'
import type { PersonalCommands, SettingsProps } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import type { ChatOrder } from './list.ts'
import type { PersonalState, SettingsTab } from './model.ts'
import { AppsPage } from './Apps.tsx'
import { ImportPage } from './Import.tsx'
import { CustomInstructions, MemorySwitches, SavedMemories, instructionsKey } from './Memory.tsx'
import { MemorySummary } from './MemorySummary.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>
/** The pages a row opens inside its Settings page. */
type Detail = 'summary' | 'memories' | 'imports' | 'archived'

const TABS: readonly { readonly id: SettingsTab; readonly label: PersonalChatKey; readonly icon: ReactNode }[] = [
  { id: 'general', label: 'settingsGeneral', icon: <IconSettingsOutlineRegular size={18} /> },
  { id: 'personalization', label: 'settingsPersonalization', icon: <IconPersonalizationOutlineRegular size={18} /> },
  { id: 'apps', label: 'apps', icon: <IconAppsAddOutlineRegular size={18} /> },
  { id: 'data', label: 'settingsData', icon: <IconDatabaseOutlineRegular size={18} /> },
]
const ORDERS: readonly { readonly id: ChatOrder; readonly label: PersonalChatKey; readonly hint: PersonalChatKey }[] = [
  { id: 'time', label: 'orderTime', hint: 'orderTimeHint' },
  { id: 'activity', label: 'orderActivity', hint: 'orderActivityHint' },
]

/** @param memory - the Host memory snapshot, when loaded. @returns how many memory candidates wait for the person. */
export function pendingCandidates(memory: MemoryState | undefined): number { return memory?.candidates.filter(candidate => candidate.state === 'pending').length ?? 0 }

function Row({ title, hint, onOpen }: { title: string; hint: string; onOpen: () => void }) {
  return <button type="button" className={css.settingsRow} onClick={onOpen}><span className={css.settingsRowText}><span>{title}</span><small>{hint}</small></span><IconChevronRightOutlineRegular size={16} /></button>
}

function General({ order, setOrder, t }: { order: ChatOrder; setOrder: (order: ChatOrder) => void; t: T }) {
  return <fieldset className={css.appLevels}>
    <legend>{t('chatOrder')}</legend>
    {ORDERS.map(({ id, label, hint }) => <label key={id} className={css.appCheck}><input type="radio" name="personal-chat-order" checked={order === id} onChange={() => { setOrder(id) }} /><span>{t(label)}<small>{t(hint)}</small></span></label>)}
  </fieldset>
}

function Personalization({ memory, commands, busy, open, t }: { memory: MemoryState; commands: PersonalCommands; busy: boolean; open: (page: Detail) => void; t: T }) {
  const saved = t('memoriesCount', { count: memory.memories.filter(item => item.state === 'active').length })
  const pending = pendingCandidates(memory)
  return <>
    <section className={css.settingsSection} aria-labelledby="personal-settings-instructions">
      <h3 id="personal-settings-instructions">{t('customInstructions')}</h3>
      <p className={css.muted}>{t('customInstructionsHint')}</p>
      <CustomInstructions key={instructionsKey(memory.profile)} profile={memory.profile} commands={commands} busy={busy} t={t} />
    </section>
    <section className={css.settingsSection} aria-labelledby="personal-settings-memory">
      <h3 id="personal-settings-memory">{t('memoryTitle')}</h3>
      <MemorySwitches profile={memory.profile} commands={commands} busy={busy} t={t} />
      <Row title={t('summaryTitle')} hint={memory.summary.updatedAt ? t('summaryUpdated', { time: new Date(memory.summary.updatedAt).toLocaleString() }) : t('summaryRowEmpty')} onOpen={() => { open('summary') }} />
      <Row title={t('memories')} hint={pending > 0 ? `${saved} · ${t('candidatesCount', { count: pending })}` : saved} onOpen={() => { open('memories') }} />
    </section>
  </>
}

function ArchivedChats({ chats, commands, busy, t }: { chats: readonly ConversationSummary[] | undefined; commands: PersonalCommands; busy: boolean; t: T }) {
  const [deleting, setDeleting] = useState<ConversationSummary | undefined>()
  return <section aria-labelledby="personal-settings-archived">
    <h2 id="personal-settings-archived">{t('archivedChats')}</h2>
    <p className={css.muted}>{t('archivedHint')}</p>
    {chats === undefined ? <div className={css.skeleton} aria-label={t('loading')} />
      : chats.length === 0 ? <p className={css.muted}>{t('noArchived')}</p>
        : <ul className={css.recordList}>{chats.map(chat => <li key={chat.id} className={css.archivedRow}>
          <span className={css.settingsRowText}><span>{chat.title || t('newChat')}</span><small>{new Date(chat.updatedAt).toLocaleDateString()}</small></span>
          <div className={css.rowActions}>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void commands.open(chat.id) }}>{t('openChat')}</Button>
            <Button size="sm" disabled={busy} onClick={() => { void commands.restore(chat.id) }}>{t('restore')}</Button>
            <Button size="sm" disabled={busy} onClick={() => { setDeleting(chat) }}>{t('delete')}</Button>
          </div>
        </li>)}</ul>}
    <Modal open={deleting !== undefined} title={t('deleteTitle')} description={t('deleteBody')} closeLabel={t('cancel')} onClose={() => { if (!busy) setDeleting(undefined) }} footer={<>
      <Button disabled={busy} onClick={() => { setDeleting(undefined) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { if (deleting) void commands.remove(deleting.id).then(ok => { if (ok) setDeleting(undefined) }) }}>{t('confirmDelete')}</Button>
    </>} />
  </section>
}

function Content({ tab, page, state, order, setOrder, commands, open, t }: { tab: SettingsTab; page: Detail | undefined; state: PersonalState; order: ChatOrder; setOrder: (order: ChatOrder) => void; commands: PersonalCommands; open: (page: Detail) => void; t: T }) {
  const loading = <div className={css.skeleton} aria-label={t('loading')} />
  if ((tab === 'personalization' || tab === 'data') && state.detail?.conversation.temporary) return <p className={css.muted}>{t('temporarySettings')}</p>
  switch (tab) {
    case 'general': return <General order={order} setOrder={setOrder} t={t} />
    case 'personalization': {
      const memory = state.memory
      if (!memory) return loading
      if (page === 'summary') return <MemorySummary summary={memory.summary} models={state.models} enabled={memory.profile.referenceChats} commands={commands} busy={state.busy} t={t} />
      if (page === 'memories') return <SavedMemories memory={memory} canAdd commands={commands} busy={state.busy} t={t} />
      return <Personalization memory={memory} commands={commands} busy={state.busy} open={open} t={t} />
    }
    case 'apps': return state.apps ? <AppsPage apps={state.apps} commands={commands} busy={state.busy} t={t} /> : loading
    case 'data':
      if (page === 'imports') return <ImportPage state={state} commands={commands} t={t} />
      if (page === 'archived') return <ArchivedChats chats={state.archivedChats} commands={commands} busy={state.busy} t={t} />
      return <section className={css.settingsSection}>
        <Row title={t('import')} hint={t('importRowHint')} onOpen={() => { open('imports') }} />
        <Row title={t('archivedChats')} hint={state.archivedChats === undefined ? t('loading') : t('archivedCount', { count: state.archivedChats.length })} onOpen={() => { open('archived') }} />
      </section>
    default: { const unknown: never = tab; return unknown }
  }
}

/**
 * The page list beside the open page, which may show a detail page with a way back.
 * Personalization and Data controls stay closed during a Temporary Chat.
 * @param props - the shared Chat state and commands, and the remembered list order.
 * @returns the dialog while Settings is open; nothing otherwise.
 */
export function PersonalSettings({ usePersonal, commands, useStore, setOrder, t }: SettingsProps) {
  const state = usePersonal(value => value)
  const order = useStore(value => value.order)
  const [detail, setDetail] = useState<{ readonly tab: SettingsTab; readonly page: Detail } | undefined>()
  const tab = state.settings
  const page = detail !== undefined && detail.tab === tab ? detail.page : undefined
  const close = () => { setDetail(undefined); commands.closeSettings() }
  const pending = pendingCandidates(state.memory)
  const current = TABS.find(item => item.id === tab)
  return <Modal open={tab !== undefined} headless title={t('settings')} onClose={close} className={css.settingsDialog}>
    {tab !== undefined && current !== undefined && <div className={css.settings}>
      <nav className={css.settingsNav} aria-label={t('settings')}>
        <h2 className={css.settingsTitle}>{t('settings')}</h2>
        {TABS.map(item => <button key={item.id} type="button" className={css.settingsTab} aria-current={item.id === tab ? 'page' : undefined} onClick={() => { void commands.openSettings(item.id) }}>
          {item.icon}<span>{t(item.label)}</span>{item.id === 'personalization' && pending > 0 && <span className={css.settingsBadge} aria-label={t('candidatesCount', { count: pending })}>{pending}</span>}
        </button>)}
      </nav>
      <div className={css.settingsMain}>
        <header className={css.settingsHead}>
          {page ? <button type="button" className={css.settingsBack} aria-label={t('settingsBack', { page: t(current.label) })} onClick={() => { setDetail(undefined) }}><IconChevronLeftOutlineRegular size={16} /><span>{t(current.label)}</span></button> : <h2>{t(current.label)}</h2>}
          <button type="button" className={css.iconAction} aria-label={t('close')} onClick={close}><IconCloseOutlineRegular size={16} /></button>
        </header>
        <div className={css.settingsContent}>
          <Content tab={tab} page={page} state={state} order={order} setOrder={setOrder} commands={commands} open={next => { setDetail({ tab, page: next }) }} t={t} />
        </div>
      </div>
    </div>}
  </Modal>
}
