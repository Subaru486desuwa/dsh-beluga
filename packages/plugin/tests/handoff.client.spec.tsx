// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PersonalPage } from '../src/client/Page.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { AppsView, WorkspaceRef } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const route = { provider: 'fixture', model: 'echo', name: 'Fixture', images: false }
const workspace = (id: string, title: string) => ({ id: id as WorkspaceRef, title, path: '/projects/' + title.toLowerCase(), allowed: false })
const apps = (workspaces: AppsView['work']['workspaces']): AppsView => ({ web: { available: false, auto: false }, work: { memoryAvailable: true, recordsAvailable: true, memory: false, records: false, workspaces } })

function page(options: { temporary?: boolean; messages?: number; apps?: AppsView; busy?: boolean; commands?: Partial<PersonalCommands> } = {}) {
  const messages = Array.from({ length: options.messages ?? 2 }, (_, index) => ({ id: 'm' + index, role: index % 2 ? 'assistant' : 'user', text: 'Message ' + index, time: 1, attachmentIds: [], toolNames: [] }))
  const conversation = { id: 'chat', title: 'Parser refactor', temporary: options.temporary ?? false, archived: false, branches: [{ id: 'branch', messageIds: messages.map(item => item.id) }], selectedBranchId: 'branch', archiveRevisions: [] }
  const state = { status: 'ready', results: [], query: '', busy: options.busy ?? false, imports: [], models: [route], selectedModel: route, web: false, apps: options.apps, detail: { conversation, messages, attachments: [] } }
  const commands = { open: vi.fn(), releaseTemporary: vi.fn(), refreshApps: vi.fn(async () => true), handOff: vi.fn(async () => true), ...options.commands }
  const usePersonal = ((select: (value: unknown) => unknown) => select(state)) as never
  const view = (busy = options.busy ?? false) => <PersonalPage {...{ usePersonal: ((select: (value: unknown) => unknown) => select({ ...state, busy })) as never, useStore: (() => null) as never, commands, t } as never} />
  const rendered = render(<PersonalPage {...{ usePersonal, useStore: (() => null) as never, commands, t } as never} />)
  return { commands, rerender: (busy: boolean) => { rendered.rerender(view(busy)) } }
}

describe('handing a chat to Work', () => {
  it('asks for a workspace, then hands the brief to Work and closes', async () => {
    const { commands } = page({ apps: apps([workspace('w-alpha', 'Alpha'), workspace('w-beta', 'Beta')]) })
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'handOff' }))
    expect(commands.refreshApps).toHaveBeenCalledOnce()
    const dialog = screen.getByRole('region', { name: 'handOff' })
    const confirm = within(dialog).getByRole('button', { name: 'handOffConfirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByText('/projects/beta')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /Beta/u }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(commands.handOff).toHaveBeenCalledExactlyOnceWith('w-beta')
    await vi.waitFor(() => { expect(screen.queryByRole('region', { name: 'handOff' })).toBeNull() })
  })
  it('stays open when the hand-off fails, and holds its controls while the brief is written', async () => {
    const { commands, rerender } = page({ apps: apps([workspace('w-alpha', 'Alpha')]), commands: { handOff: vi.fn(async () => false) } })
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'handOff' }))
    fireEvent.click(screen.getByRole('radio', { name: /Alpha/u }))
    fireEvent.click(screen.getByRole('button', { name: 'handOffConfirm' }))
    await vi.waitFor(() => { expect(commands.handOff).toHaveBeenCalledOnce() })
    rerender(true)
    const dialog = screen.getByRole('region', { name: 'handOff' })
    expect(within(dialog).getByRole('button', { name: 'handOffWriting' })).toHaveProperty('disabled', true)
    expect(within(dialog).getByRole('group', { name: 'workspace' })).toHaveProperty('disabled', true)
  })
  it('says when Work has no workspace, and offers nothing for an empty chat', () => {
    page({ apps: apps([]) })
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'handOff' }))
    expect(screen.getByText('handOffNoWorkspace')).toBeTruthy()
    cleanup()
    page({ messages: 0, apps: apps([]) })
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    expect(screen.getByRole('menuitem', { name: 'handOff' })).toHaveProperty('disabled', true)
  })
  it('hands off a Temporary Chat from its header too', () => {
    page({ temporary: true, apps: apps([workspace('w-alpha', 'Alpha')]) })
    fireEvent.click(screen.getByRole('button', { name: 'handOff' }))
    expect(screen.getByRole('region', { name: 'handOff' })).toBeTruthy()
    cleanup()
    page({ temporary: true, messages: 0 })
    expect(screen.getByRole('button', { name: 'handOff' })).toHaveProperty('disabled', true)
  })
})
