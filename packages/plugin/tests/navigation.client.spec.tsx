// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatNavigation } from '../src/client/Navigation.tsx'
import type { NavigationProps, PersonalCommands } from '../src/client/contract.ts'
import type { PersonalState } from '../src/client/model.ts'
import type { ChatActivity, ConversationId, ConversationSummary } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const chat = (id: string, activity: ChatActivity = 'idle', pinned = false, archived = false): ConversationSummary => ({ id: id as ConversationId, title: id, updatedAt: Date.now(), pinned, archived, activity })

function show(results: readonly ConversationSummary[], extra: Partial<NavigationProps> = {}, more: Partial<PersonalState> = {}) {
  const commands = { create: vi.fn(async () => true), open: vi.fn(async () => true), search: vi.fn(), openSettings: vi.fn(async () => true), retry: vi.fn() } as unknown as PersonalCommands
  const state = { busy: false, status: 'ready', results, query: '', ...more } as unknown as PersonalState
  const setOrder = vi.fn()
  const props = { wide: true, expandSidebar: vi.fn(), usePersonal: (select: (value: PersonalState) => unknown) => select(state), commands, useStore: (select: (value: { order: 'time' | 'activity' }) => unknown) => select({ order: 'time' }), setOrder, t, ...extra } as unknown as NavigationProps
  render(<ChatNavigation {...props} />)
  return { commands, setOrder, props }
}

describe('Chat sidebar region', () => {
  it('heads pinned chats and today, marks what needs the person, and opens a chat', () => {
    const { commands } = show([chat('Pinned plan', 'idle', true), chat('Drafting', 'running'), chat('Merge?', 'waiting'), chat('Answered', 'replied'), chat('Quiet')])
    expect(within(screen.getByRole('region', { name: 'groupPinned' })).getByText('Pinned plan')).toBeTruthy()
    const today = screen.getByRole('region', { name: 'groupToday' })
    expect(within(today).getByRole('img', { name: 'activityRunning' })).toBeTruthy()
    expect(within(today).getByRole('img', { name: 'activityWaiting' })).toBeTruthy()
    expect(within(today).getByRole('img', { name: 'activityReplied' })).toBeTruthy()
    expect(within(screen.getByText('Quiet').closest('button')!).queryByRole('img')).toBeNull()
    expect(screen.getAllByText('Drafting')[0]!.closest('button')!.querySelector('[data-shimmer]')).not.toBeNull()
    expect(screen.getByText('Answered').closest('button')!.querySelector('[data-shimmer]')).toBeNull()
    fireEvent.click(screen.getByText('Answered'))
    expect(commands.open).toHaveBeenCalledWith('Answered')
  })
  it('tags archived chats that search finds, and searches with the typed text only', () => {
    const { commands } = show([chat('Shelved', 'idle', false, true), chat('Current')], {}, { query: 'e' })
    expect(within(screen.getByText('Shelved').closest('button')!).getByText('archived')).toBeTruthy()
    expect(within(screen.getByText('Current').closest('button')!).queryByText('archived')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'search' }), { target: { value: 'shel' } })
    expect(commands.search).toHaveBeenCalledWith('shel')
    expect(screen.queryByRole('button', { name: 'archived' })).toBeNull()
  })
  it('opens Settings from its one button, which counts memories awaiting approval', () => {
    const memory = { candidates: [{ state: 'pending' }, { state: 'pending' }, { state: 'saved' }] }
    const { commands } = show([chat('One')], {}, { memory } as unknown as Partial<PersonalState>)
    const settings = screen.getByRole('button', { name: /^settings/ })
    expect(within(settings).getByText('2')).toBeTruthy()
    fireEvent.click(settings)
    expect(commands.openSettings).toHaveBeenCalledWith('general')
  })
  it('remembers the order the person picks', () => {
    const { setOrder } = show([chat('One')])
    fireEvent.click(screen.getByRole('button', { name: 'listOrder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'orderActivity' }))
    expect(setOrder).toHaveBeenCalledWith('activity')
  })
  it('keeps only New chat and search on the folded rail, and search unfolds the sidebar', () => {
    const expandSidebar = vi.fn()
    const { commands } = show([chat('One')], { wide: false, expandSidebar } as Partial<NavigationProps>)
    expect(screen.queryByText('One')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'search' }))
    expect(expandSidebar).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'newChat' }))
    expect(commands.create).toHaveBeenCalledWith(false)
  })
})
