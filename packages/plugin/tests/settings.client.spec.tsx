// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PersonalSettings } from '../src/client/Settings.tsx'
import type { PersonalCommands, SettingsProps } from '../src/client/contract.ts'
import type { PersonalState } from '../src/client/model.ts'
import type { ConversationId, ConversationSummary, MemoryState } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const memory = (profile: Partial<MemoryState['profile']> = {}): MemoryState => ({
  profile: { revision: 1, background: 'Student', instructions: 'Be brief', autoSaveLowRisk: true, referenceChats: true, updatedAt: 1, ...profile },
  memories: [], candidates: [],
  summary: { revision: 0, text: '', suggestions: [], updatedAt: 0, updating: false, sensitive: false, canUndo: false } as MemoryState['summary'],
})
const shelved: ConversationSummary = { id: 'old' as ConversationId, title: 'Shelved plan', updatedAt: 1, pinned: false, archived: true, activity: 'idle' }

function setup(state: Partial<PersonalState>) {
  const commands = {
    openSettings: vi.fn(async () => true), closeSettings: vi.fn(), updateProfile: vi.fn(async () => true),
    open: vi.fn(async () => true), restore: vi.fn(async () => true), remove: vi.fn(async () => true),
  } as unknown as PersonalCommands
  const setOrder = vi.fn()
  const props = (value: Partial<PersonalState>) => ({ usePersonal: (select: (current: PersonalState) => unknown) => select({ busy: false, models: [], imports: [], ...value } as PersonalState), commands, useStore: (select: (current: { order: 'time' | 'activity' }) => unknown) => select({ order: 'time' }), setOrder, t }) as unknown as SettingsProps
  const view = render(<PersonalSettings {...props(state)} />)
  return { commands, setOrder, rerender: (value: Partial<PersonalState>) => { view.rerender(<PersonalSettings {...props(value)} />) } }
}

describe('Settings dialog', () => {
  it('shows nothing while closed, then the page list beside the open page', () => {
    const closed = setup({ settings: undefined })
    expect(screen.queryByRole('navigation', { name: 'settings' })).toBeNull()
    closed.rerender({ settings: 'general' })
    const pages = screen.getByRole('navigation', { name: 'settings' })
    expect(within(pages).getByRole('button', { name: 'settingsGeneral' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(pages).getByRole('button', { name: 'settingsData' }))
    expect(closed.commands.openSettings).toHaveBeenCalledWith('data')
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(closed.commands.closeSettings).toHaveBeenCalled()
  })
  it('changes how the chat list is ordered from General', () => {
    const { setOrder } = setup({ settings: 'general' })
    fireEvent.click(screen.getByRole('radio', { name: /orderActivity/ }))
    expect(setOrder).toHaveBeenCalledWith('activity')
  })
  it('saves a memory switch at once and keeps unsaved instruction text', () => {
    const { commands, rerender } = setup({ settings: 'personalization', memory: memory() })
    const instructions = screen.getByRole('textbox', { name: 'instructions' })
    fireEvent.change(instructions, { target: { value: 'Be brief and warm' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /autoSave/ }))
    expect(commands.updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ autoSaveLowRisk: false, instructions: 'Be brief' }))
    rerender({ settings: 'personalization', memory: memory({ revision: 2, autoSaveLowRisk: false }) })
    expect((screen.getByRole('textbox', { name: 'instructions' }) as HTMLTextAreaElement).value).toBe('Be brief and warm')
    fireEvent.click(screen.getByRole('button', { name: 'customInstructionsSave' }))
    expect(commands.updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, autoSaveLowRisk: false, instructions: 'Be brief and warm' }))
  })
  it('opens the Memory Summary inside Personalization and goes back', () => {
    setup({ settings: 'personalization', memory: memory() })
    fireEvent.click(screen.getByRole('button', { name: /summaryTitle/ }))
    expect(screen.getByRole('heading', { name: 'summaryTitle' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'instructions' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /settingsBack/ }))
    expect(screen.getByRole('textbox', { name: 'instructions' })).toBeTruthy()
  })
  it('keeps memory and data closed during a Temporary Chat', () => {
    const temporary = { conversation: { temporary: true } } as PersonalState['detail']
    const { rerender } = setup({ settings: 'personalization', memory: memory(), detail: temporary })
    expect(screen.getByText('temporarySettings')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'instructions' })).toBeNull()
    rerender({ settings: 'data', detail: temporary, archivedChats: [shelved] })
    expect(screen.getByText('temporarySettings')).toBeTruthy()
  })
  it('lists archived chats in Data controls to open, unarchive or delete', () => {
    const { commands } = setup({ settings: 'data', archivedChats: [shelved] })
    fireEvent.click(screen.getByRole('button', { name: /archivedChats/ }))
    const row = screen.getByText('Shelved plan').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'openChat' }))
    expect(commands.open).toHaveBeenCalledWith('old')
    fireEvent.click(within(row).getByRole('button', { name: 'restore' }))
    expect(commands.restore).toHaveBeenCalledWith('old')
    fireEvent.click(within(row).getByRole('button', { name: 'delete' }))
    expect(commands.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'confirmDelete' }))
    expect(commands.remove).toHaveBeenCalledWith('old')
  })
})
