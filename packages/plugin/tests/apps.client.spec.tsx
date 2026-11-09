// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppsPage } from '../src/client/Apps.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AppsView, WorkspaceRef } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const apps = (web: Partial<AppsView['web']> = {}, work: Partial<AppsView['work']> = {}): AppsView => ({ web: { available: true, auto: true, ...web }, work: { memoryAvailable: true, recordsAvailable: true, memory: false, records: false, workspaces: [], ...work } })
const ws = (id: string, title: string, allowed: boolean) => ({ id: brandString<WorkspaceRef>(id), title, path: '/projects/' + title.toLowerCase(), allowed })

describe('apps page', () => {
  it('says when Harness has no web search provider', () => {
    render(<AppsPage apps={apps({ available: false })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('webMissing')).toBeTruthy()
  })
  it('turns automatic web search off', () => {
    const updateApps = vi.fn(async () => true)
    render(<AppsPage apps={apps()} commands={{ updateApps } as unknown as PersonalCommands} busy={false} t={t} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /webAutoHint/u }))
    expect(updateApps.mock.calls).toEqual([[{ webAuto: false }]])
  })
  it('holds every control while a change is saving', () => {
    render(<AppsPage apps={apps()} commands={{} as PersonalCommands} busy t={t} />)
    expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).disabled)).toEqual([true, true, true])
  })
  it('turns each Work crossing on by itself, and picks the workspaces Chat may read', () => {
    const updateApps = vi.fn(async () => true)
    const { rerender } = render(<AppsPage apps={apps({}, { workspaces: [ws('w1', 'Alpha', true), ws('w2', 'Beta', false)] })} commands={{ updateApps } as unknown as PersonalCommands} busy={false} t={t} />)
    expect(screen.queryByRole('group', { name: 'workWorkspaces' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /workMemoryHint/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /workRecordsHint/u }))
    expect(updateApps.mock.calls).toEqual([[{ workMemory: true }], [{ workRecords: true }]])
    rerender(<AppsPage apps={apps({}, { records: true, workspaces: [ws('w1', 'Alpha', true), ws('w2', 'Beta', false)] })} commands={{ updateApps } as unknown as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByRole('checkbox', { name: /Alpha/u })).toHaveProperty('checked', true)
    expect(screen.getByText('/projects/beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Beta/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Alpha/u }))
    expect(updateApps.mock.calls.slice(2)).toEqual([[{ workWorkspaces: ['w1', 'w2'] }], [{ workWorkspaces: [] }]])
  })
  it('says when Work is missing, and that Chat reads nothing until a workspace is ticked', () => {
    const { rerender } = render(<AppsPage apps={apps({}, { memoryAvailable: false, recordsAvailable: false })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workMissing')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /workMemoryHint/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: /workRecordsHint/u })).toHaveProperty('disabled', true)
    rerender(<AppsPage apps={apps({}, { records: true, workspaces: [ws('w1', 'Alpha', false)] })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workPickWorkspace')).toBeTruthy()
    rerender(<AppsPage apps={apps({}, { records: true })} commands={{} as PersonalCommands} busy={false} t={t} />)
    expect(screen.getByText('workNoWorkspaces')).toBeTruthy()
  })
})
