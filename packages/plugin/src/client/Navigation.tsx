/** Chat's sidebar region, shown in place of the workspace browser while Chat is open (ADR 0005). */
import { useState } from 'react'
import { IconCodeOutlineRegular, IconEditOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular, Menu, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSummary } from '../shared/types.ts'
import type { NavigationProps } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import { groupChats, type ChatGroup, type ChatOrder } from './list.ts'
import { pendingCandidates } from './Settings.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

const GROUP_LABEL: Record<Exclude<ChatGroup['kind'], 'month'>, PersonalChatKey> = {
  pinned: 'groupPinned', today: 'groupToday', yesterday: 'groupYesterday', week: 'groupWeek', recent: 'groupRecent',
  running: 'groupRunning', waiting: 'groupWaiting', replied: 'groupReplied', rest: 'groupRest',
}
const ACTIVITY_LABEL: Record<Exclude<ConversationSummary['activity'], 'idle'>, PersonalChatKey> = { running: 'activityRunning', waiting: 'activityWaiting', replied: 'activityReplied' }
const ORDERS: readonly { readonly id: ChatOrder; readonly label: PersonalChatKey }[] = [{ id: 'time', label: 'orderTime' }, { id: 'activity', label: 'orderActivity' }]

/** Panel-list glyph for the row that returns to Work. @param props - Sidebar icon dimensions. @returns the code glyph. */
export function WorkPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconCodeOutlineRegular size={size} /> }

function groupLabel(group: ChatGroup, t: T): string {
  return group.kind === 'month' ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(new Date(group.year, group.month, 1)) : t(GROUP_LABEL[group.kind])
}

/**
 * New chat and search, then pinned chats and the rest grouped by time or by Chat Activity State, with Settings at the foot.
 * Search also finds archived chats, which are tagged.
 * On the folded rail only New chat and a search button that unfolds the sidebar remain.
 * @param props - Sidebar fold state, the shared Chat state and commands, and the remembered order.
 * @returns the Chat sidebar region.
 */
export function ChatNavigation({ wide, expandSidebar, usePersonal, commands, useStore, setOrder, t }: NavigationProps) {
  const state = usePersonal(value => value)
  const order = useStore(value => value.order)
  const [orderOpen, setOrderOpen] = useState(false)
  if (!wide) return <div className={css.navRail}>
    <button type="button" className={css.navIcon} aria-label={t('newChat')} disabled={state.busy} onClick={() => { void commands.create(false) }}><IconEditOutlineRegular size={20} /></button>
    <button type="button" className={css.navIcon} aria-label={t('search')} onClick={expandSidebar}><IconSearchOutlineRegular size={20} /></button>
  </div>
  const open = state.detail?.conversation
  const candidates = pendingCandidates(state.memory)
  return <nav className={css.nav} aria-label={t('history')}>
    <div className={css.navActions}>
      <button type="button" className={css.navAction} disabled={state.busy} onClick={() => { void commands.create(false) }}><IconEditOutlineRegular size={18} /><span>{t('newChat')}</span></button>
      <button type="button" className={css.navAction} disabled={state.busy} onClick={() => { void commands.create(true) }}><span className={css.navActionGap} aria-hidden />{t('temporary')}</button>
    </div>
    <div className={css.navSearch}>
      <input className={css.search} type="search" aria-label={t('search')} placeholder={t('search')} value={state.query} onChange={event => { commands.search(event.target.value) }} />
      <Menu open={orderOpen} onClose={() => { setOrderOpen(false) }} portal align="end" autoFocus selection="check" selectedId={order}
        anchor={<button type="button" className={css.navIcon} aria-label={t('listOrder')} aria-haspopup="menu" aria-expanded={orderOpen} onClick={() => { setOrderOpen(value => !value) }}><IconSlidersTwoOutlineRegular size={18} /></button>}
        items={ORDERS.map(item => ({ id: item.id, label: t(item.label) }))}
        onSelect={id => { setOrderOpen(false); setOrder(id === 'activity' ? 'activity' : 'time') }} />
    </div>
    <div className={css.navRows}>
      {state.status === 'loading' ? <div className={css.skeleton} aria-label={t('loading')} />
        : state.status === 'failed' ? <div className={css.loadError}><p>{t('loadFailed')}</p><button type="button" className={css.navFilter} onClick={commands.retry}>{t('retry')}</button></div>
          : state.results.length === 0 ? <p className={css.muted}>{t('noResults')}</p>
            : groupChats(state.results, order, new Date()).map(group => <section key={group.kind === 'month' ? `${group.year}-${group.month}` : group.kind} className={css.navGroup} aria-label={groupLabel(group, t)}>
              <h3 className={css.navGroupLabel}>{groupLabel(group, t)}</h3>
              {group.items.map(item => <button key={item.id} type="button" className={css.navRow} data-activity={item.activity} aria-current={item.id === open?.id ? 'page' : undefined} disabled={state.busy} onClick={() => { void commands.open(item.id) }}>
                <span className={css.navTitle}><TextShimmer active={item.activity === 'running'}>{item.title || t('newChat')}</TextShimmer></span>
                {item.archived && <span className={css.navTag}>{t('archived')}</span>}
                {item.activity !== 'idle' && <span className={css.navMark} data-activity={item.activity} role="img" aria-label={t(ACTIVITY_LABEL[item.activity])} />}
              </button>)}
            </section>)}
    </div>
    <div className={css.navFoot}>
      <button type="button" className={css.navAction} disabled={state.busy} onClick={() => { void commands.openSettings('general') }}><IconSettingsOutlineRegular size={18} /><span>{t('settings')}</span>{candidates > 0 && <span className={css.settingsBadge} aria-label={t('candidatesCount', { count: candidates })}>{candidates}</span>}</button>
    </div>
  </nav>
}
