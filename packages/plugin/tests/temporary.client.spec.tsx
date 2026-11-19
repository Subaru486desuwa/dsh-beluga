// @vitest-environment jsdom
/** Temporary Chat's switch in the empty chat's header. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PersonalPage } from '../src/client/Page.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string) => key) as never
const route = { provider: 'fixture', model: 'echo', name: 'Fixture', images: false }

function page(options: { draftTemporary?: boolean; saved?: boolean; busy?: boolean } = {}) {
  const conversation = { id: 'chat', title: 'Parser refactor', temporary: false, archived: false, branches: [], archiveRevisions: [] }
  const state = { status: 'ready', results: [], query: '', busy: options.busy ?? false, imports: [], models: [route], selectedModel: route, web: false, draftTemporary: options.draftTemporary ?? false, navigation: 0,
    detail: options.saved ? { conversation, messages: [], attachments: [] } : undefined }
  const commands = { open: vi.fn(), releaseTemporary: vi.fn(), setTemporary: vi.fn(async () => true) }
  render(<PersonalPage {...{ usePersonal: ((select: (value: unknown) => unknown) => select(state)) as never, useStore: (() => null) as never, commands, t } as never} />)
  return { commands, toggle: () => screen.queryByRole('button', { name: 'temporary' }) }
}

describe('Temporary Chat switch', () => {
  it('turns Temporary Chat on for an empty chat from the header', () => {
    const { commands, toggle } = page()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle()!)
    expect(commands.setTemporary).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('shows the switch on and turns it off again while the chat is still empty', () => {
    const { commands, toggle } = page({ draftTemporary: true })
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('temporary')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle()!)
    expect(commands.setTemporary).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('holds the switch while Chat is busy and offers none for a saved chat', () => {
    const { toggle } = page({ busy: true })
    expect(toggle()).toHaveProperty('disabled', true)
    cleanup()
    expect(page({ saved: true }).toggle()).toBeNull()
  })
})
