// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppsPage } from '../src/client/Apps.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AppsView, WorkspaceRef } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const apps = (github: Partial<AppsView['github']> = {}, web: Partial<AppsView['web']> = {}, work: Partial<AppsView['work']> = {}): AppsView => ({ web: { available: true, auto: true, ...web }, github: { installed: true, auto: true, approval: 'ask', ...github }, work: { memoryAvailable: true, recordsAvailable: true, memory: false, records: false, workspaces: [], ...work } })
const ws = (id: string, title: string, allowed: boolean) => ({ id: brandString<WorkspaceRef>(id), title, path: '/projects/' + title.toLowerCase(), allowed })
const token = () => screen.getByLabelText('githubToken') as HTMLInputElement

describe('apps page', () => {
  it('says what is missing when an extension is not there', () => {
    render(<AppsPage apps={apps({ installed: false }, { available: false })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('webMissing')).toBeTruthy()
    expect(screen.getByText('githubMissing')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'githubCli' })).toBeNull()
  })
  it('connects with the GitHub CLI sign-in or a pasted token, and clears the token once it is taken', async () => {
    const connectGitHub = vi.fn(async () => true)
    render(<AppsPage apps={apps()} commands={{ connectGitHub } as unknown as PersonalCommands} busy={false} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'githubCli' }))
    expect(connectGitHub).toHaveBeenLastCalledWith({ cli: true })
    expect(token().type).toBe('password')
    const submit = screen.getByRole('button', { name: 'githubConnect' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(token(), { target: { value: '  ghp_example  ' } })
    fireEvent.click(submit)
    expect(connectGitHub).toHaveBeenLastCalledWith({ token: 'ghp_example' })
    await waitFor(() => expect(token().value).toBe(''))
    expect(screen.getByRole('link', { name: 'githubCreateToken' }).getAttribute('href')).toBe('https://github.com/settings/personal-access-tokens/new')
  })
  it('keeps a token the connection refused, so it can be corrected', async () => {
    const connectGitHub = vi.fn(async () => false)
    render(<AppsPage apps={apps()} commands={{ connectGitHub } as unknown as PersonalCommands} busy={false} t={t} />)
    fireEvent.change(token(), { target: { value: 'ghp_typo' } })
    fireEvent.submit(token().form!)
    expect(connectGitHub).toHaveBeenCalledExactlyOnceWith({ token: 'ghp_typo' })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(token().value).toBe('ghp_typo')
  })
  it('shows the account, and changes automatic use and which changes ask first', () => {
    const updateApps = vi.fn(async () => true)
    const disconnectGitHub = vi.fn(async () => true)
    render(<AppsPage apps={apps({ account: 'octo', source: 'gh-cli' })} commands={{ updateApps, disconnectGitHub } as unknown as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('githubConnected {"login":"octo"}')).toBeTruthy()
    expect(screen.getByText('githubSourceCli')).toBeTruthy()
    expect(screen.queryByLabelText('githubToken')).toBeNull()
    expect(screen.getAllByRole('radio').map(radio => (radio as HTMLInputElement).checked)).toEqual([true, false, false])
    fireEvent.click(screen.getByRole('radio', { name: /^approvalLow/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /githubAutoHint/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /webAutoHint/u }))
    expect(updateApps.mock.calls).toEqual([[{ githubApproval: 'low' }], [{ githubAuto: false }], [{ webAuto: false }]])
    fireEvent.click(screen.getByRole('button', { name: 'githubDisconnect' }))
    expect(disconnectGitHub).toHaveBeenCalledOnce()
  })
  it('holds every control while a change is saving', () => {
    render(<AppsPage apps={apps({ account: 'octo', source: 'token', approval: 'all' })} commands={{} as PersonalCommands} busy t={t} />)
    expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).disabled)).toEqual([true, true, true, true])
    expect((screen.getByRole('group', { name: 'approvalLevel' }) as HTMLFieldSetElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'githubDisconnect' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /^approvalAll/u }) as HTMLInputElement).checked).toBe(true)
  })
  it('turns each Work crossing on by itself, and picks the workspaces Chat may read', () => {
    const updateApps = vi.fn(async () => true)
    const { rerender } = render(<AppsPage apps={apps({}, {}, { workspaces: [ws('w1', 'Alpha', true), ws('w2', 'Beta', false)] })} commands={{ updateApps } as unknown as PersonalCommands} busy={false} t={t} />)
    expect(screen.queryByRole('group', { name: 'workWorkspaces' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /workMemoryHint/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /workRecordsHint/u }))
    expect(updateApps.mock.calls).toEqual([[{ workMemory: true }], [{ workRecords: true }]])
    rerender(<AppsPage apps={apps({}, {}, { records: true, workspaces: [ws('w1', 'Alpha', true), ws('w2', 'Beta', false)] })} commands={{ updateApps } as unknown as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByRole('checkbox', { name: /Alpha/u })).toHaveProperty('checked', true)
    expect(screen.getByText('/projects/beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Beta/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Alpha/u }))
    expect(updateApps.mock.calls.slice(2)).toEqual([[{ workWorkspaces: ['w1', 'w2'] }], [{ workWorkspaces: [] }]])
  })
  it('says when Work is missing, and that Chat reads nothing until a workspace is ticked', () => {
    const { rerender } = render(<AppsPage apps={apps({}, {}, { memoryAvailable: false, recordsAvailable: false })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workMissing')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /workMemoryHint/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: /workRecordsHint/u })).toHaveProperty('disabled', true)
    rerender(<AppsPage apps={apps({}, {}, { records: true, workspaces: [ws('w1', 'Alpha', false)] })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workPickWorkspace')).toBeTruthy()
    rerender(<AppsPage apps={apps({}, {}, { records: true })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workNoWorkspaces')).toBeTruthy()
  })
})
