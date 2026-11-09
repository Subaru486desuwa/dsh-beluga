// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemorySummary } from '../src/client/MemorySummary.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { ModelChoice } from '../src/shared/models.ts'
import type { MemorySummaryView } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const flash: ModelChoice = { provider: 'deepseek', model: 'flash', name: 'DeepSeek · Flash', images: false, lastUsed: true }
const luna: ModelChoice = { provider: 'personal-inline', model: 'luna', name: 'GPT · Luna', images: true, inline: true }
const view = (extra: Partial<MemorySummaryView> = {}): MemorySummaryView => ({ revision: 3, text: 'You study AI.\n## Projects\nBeluga.', suggestions: ['梳理你的研究', 'Compare tools'], updatedAt: Date.UTC(2026, 10, 8), updating: false, sensitive: false, canUndo: true, ...extra })
function commands(extra: Partial<PersonalCommands> = {}): PersonalCommands {
  return { refreshSummary: vi.fn(async () => true), askSummary: vi.fn(async () => 'Yes, Obsidian.'), editSummary: vi.fn(async () => true), undoSummary: vi.fn(async () => true), clearSummary: vi.fn(async () => true), summaryOptions: vi.fn(async () => true), startChat: vi.fn(async () => true), ...extra } as unknown as PersonalCommands
}
function show(summary = view(), actions = commands(), enabled = true) {
  render(<MemorySummary summary={summary} models={[flash, luna]} enabled={enabled} commands={actions} busy={false} t={t} />)
  return actions
}

describe('memory summary card', () => {
  it('shows the text, when it changed, and prompts that start a chat', () => {
    const actions = show()
    expect(screen.getByRole('heading', { name: 'summaryTitle' })).toBeTruthy()
    expect(screen.getByText(/You study AI\./u)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('summaryUpdated')
    fireEvent.click(screen.getByRole('button', { name: '梳理你的研究' }))
    expect(actions.startChat).toHaveBeenCalledWith('梳理你的研究')
  })
  it('starts blank, says when it is off or updating, and explains a failure', () => {
    show(view({ text: '', suggestions: [], updatedAt: 0, error: 'summary-model', updating: true }), commands(), false)
    expect(screen.getByText('summaryEmpty')).toBeTruthy()
    expect(screen.getByText('summaryOff')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('summaryUpdating')
    expect(screen.getByRole('alert').textContent).toBe('summaryFailed {"reason":"summaryErrorModel"}')
    expect((screen.getByRole('textbox', { name: 'summaryAsk' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.queryByRole('heading', { name: 'summaryDive' })).toBeNull()
  })
  it('asks with Enter, not during IME composition, and shows the answer', async () => {
    const actions = show()
    const input = screen.getByRole('textbox', { name: 'summaryAsk' })
    fireEvent.change(input, { target: { value: '我用什么记笔记？' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(actions.askSummary).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(actions.askSummary).toHaveBeenCalledExactlyOnceWith('我用什么记笔记？'))
    await waitFor(() => expect(screen.getByText('Yes, Obsidian.')).toBeTruthy())
    expect(screen.getByText('我用什么记笔记？')).toBeTruthy()
    expect((input as HTMLTextAreaElement).value).toBe('')
  })
  it('says the summary changed when the model only rewrote it, and keeps a failed request', async () => {
    const changed = show(view(), commands({ askSummary: vi.fn(async () => '') }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Forget Beluga' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(screen.getByText('summaryChanged')).toBeTruthy())
    expect(changed.askSummary).toHaveBeenCalledOnce()
    cleanup()
    show(view(), commands({ askSummary: vi.fn(async () => undefined) }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep me'))
  })
  it('refreshes, toggles sensitive topics, restores, and clears after confirming', () => {
    const actions = show(view({ model: { provider: 'deepseek', model: 'flash' } }))
    const more = () => { fireEvent.click(screen.getByRole('button', { name: 'summaryMore' })); return within(screen.getByRole('menu')) }
    fireEvent.click(more().getByRole('menuitem', { name: 'summaryRefresh' }))
    expect(actions.refreshSummary).toHaveBeenCalledOnce()
    fireEvent.click(more().getByRole('menuitem', { name: 'summarySensitivesummaryOffState' }))
    expect(actions.summaryOptions).toHaveBeenCalledWith({ model: { provider: 'deepseek', model: 'flash' }, sensitive: true })
    fireEvent.click(more().getByRole('menuitem', { name: 'summaryUndo' }))
    expect(actions.undoSummary).toHaveBeenCalledOnce()
    fireEvent.click(more().getByRole('menuitem', { name: 'summaryClear' }))
    expect(actions.clearSummary).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('region', { name: 'summaryClearTitle' })).getByRole('button', { name: 'summaryClear' }))
    expect(actions.clearSummary).toHaveBeenCalledOnce()
  })
  it('chooses the model that writes it, or follows the last chat', () => {
    const actions = show()
    const chip = screen.getByRole('button', { name: 'summaryModel · summaryModelLast' })
    fireEvent.click(chip)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'GPT · Luna' }))
    expect(actions.summaryOptions).toHaveBeenCalledWith({ model: { provider: 'personal-inline', model: 'luna', inline: true }, sensitive: false })
    cleanup()
    const chosen = show(view({ model: { provider: 'personal-inline', model: 'luna', inline: true } }))
    fireEvent.click(screen.getByRole('button', { name: 'summaryModel · Luna' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /summaryModelLast/u }))
    expect(chosen.summaryOptions).toHaveBeenCalledWith({ sensitive: false })
  })
  it('edits the text in place against the revision it started from, and keeps the draft when saving fails', async () => {
    const actions = show()
    fireEvent.click(screen.getByRole('button', { name: 'summaryMore' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'summaryEdit' }))
    const editor = screen.getByRole('textbox', { name: 'summaryEditLabel' }) as HTMLTextAreaElement
    expect(editor.value).toBe('You study AI.\n## Projects\nBeluga.')
    expect(screen.queryByRole('textbox', { name: 'summaryAsk' })).toBeNull()
    fireEvent.change(editor, { target: { value: 'Pasted summary.' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(actions.editSummary).toHaveBeenCalledExactlyOnceWith('Pasted summary.', 3))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'summaryEditLabel' })).toBeNull())
    cleanup()
    show(view(), commands({ editSummary: vi.fn(async () => false) }))
    fireEvent.click(screen.getByRole('button', { name: 'summaryMore' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'summaryEdit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'summaryEditLabel' }), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'summaryEditLabel' }) as HTMLTextAreaElement).value).toBe('Keep me'))
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.getByRole('textbox', { name: 'summaryAsk' })).toBeTruthy()
  })
  it('cannot restore or clear what is not there', () => {
    show(view({ text: '', canUndo: false }))
    fireEvent.click(screen.getByRole('button', { name: 'summaryMore' }))
    const menu = within(screen.getByRole('menu'))
    expect((menu.getByRole('menuitem', { name: 'summaryUndo' }) as HTMLButtonElement).disabled).toBe(true)
    expect((menu.getByRole('menuitem', { name: 'summaryClear' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
