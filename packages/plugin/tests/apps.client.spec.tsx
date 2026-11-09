// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppsPage } from '../src/client/Apps.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { AppsView } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const apps = (web: Partial<AppsView['web']> = {}): AppsView => ({ web: { available: true, auto: true, ...web } })

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
    expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).disabled)).toEqual([true])
  })
})
