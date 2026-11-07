// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes } from 'react'
import { ChatComposer, ChatMessages } from '../src/client/Chat.tsx'
import type { PersonalState } from '../src/client/model.ts'
import type { PersonalCommands } from '../src/client/contract.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  MarkdownText: () => null, Modal: () => null, writeClipboard: vi.fn(),
}))
afterEach(cleanup)
it('does not submit IME composition or Shift+Enter, but submits ordinary Enter once', async () => {
  const send = vi.fn(async () => true)
  const route = { provider: 'fixture', model: 'echo', name: 'Fixture', images: false }
  const state = { busy: false, models: [route], selectedModel: route, web: false } as PersonalState
  const commands = { send } as unknown as PersonalCommands
  render(<ChatComposer state={state} commands={commands} t={key => key} />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '正在输入中文' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('正在输入中文', []))
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''))
})


it('shows original input and artifact version cards with downloads', () => {
  const file = { id: 'generated', conversationId: 'chat', name: 'Report.docx', bytes: 1024, image: false, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', artifact: { rootId: 'generated', version: 2, summary: 'Second section updated' } }
  const state = { busy: false, detail: { messages: [{ id: 'tool', role: 'tool', text: '{}', time: 0, attachmentIds: ['generated', 'input'], toolNames: [] }], attachments: [file, { ...file, id: 'input', artifact: undefined }], omittedMessages: 0 } } as unknown as PersonalState
  const t = ((key: string, params?: { version?: number }) => key === 'artifactVersion' ? '产物 · 版本 ' + params?.version : key === 'inputFile' ? '输入原件' : key) as never
  render(<ChatMessages state={state} commands={{} as PersonalCommands} t={t} />)
  expect(screen.getByText(/产物 · 版本 2/)).toBeTruthy()
  expect(screen.getByText(/输入原件/)).toBeTruthy()
  expect(screen.getByText('Second section updated')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'download' })).toHaveLength(2)
})

it('explains an output-limit cutoff instead of a generic failure and keeps retry', () => {
  const message = { id: 'user', role: 'user', text: 'Write', time: 0, attachmentIds: [], toolNames: [] }
  const state = { busy: false, detail: { messages: [message], attachments: [], omittedMessages: 0, error: 'max-tokens' } } as unknown as PersonalState
  render(<ChatMessages state={state} commands={{} as PersonalCommands} t={(key => key) as never} />)
  expect(screen.getByRole('status').textContent).toContain('replyTruncated')
  expect(screen.queryByText(/replyError/)).toBeNull()
  expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
})
const detail = (message: object) => ({ conversation: { id: 'chat' }, attachments: [], omittedMessages: 0, messages: [{ id: 'reply', role: 'assistant', text: 'Hello **there**', time: 1, attachmentIds: [], toolNames: [], ...message }] }) as unknown as PersonalState['detail']
it('links each source of a reply in a new tab', () => {
  const state = { busy: false, detail: detail({ sources: [{ url: 'https://example.com/a', title: 'Article' }, { url: 'https://example.org/b' }] }) } as PersonalState
  render(<ChatMessages state={state} commands={{} as PersonalCommands} t={key => key} />)
  const link = screen.getByRole('link', { name: 'Article' })
  expect(link.getAttribute('href')).toBe('https://example.com/a')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noreferrer noopener')
  expect(screen.getByRole('link', { name: 'example.org' })).toBeTruthy()
})
describe('read aloud', () => {
  const synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn() }
  class Utterance { voice?: unknown; onend?: () => void; constructor(readonly text: string) {} }
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('speechSynthesis', synth); vi.stubGlobal('SpeechSynthesisUtterance', Utterance) })
  afterEach(() => vi.unstubAllGlobals())
  const state = { busy: false, detail: detail({}) } as PersonalState
  it('speaks plain text with a local voice and stops on a second press', () => {
    const local = { lang: 'en-US', localService: true }
    synth.getVoices.mockReturnValue([{ lang: 'en-US', localService: false }, local])
    render(<ChatMessages state={state} commands={{} as PersonalCommands} t={key => key} />)
    fireEvent.click(screen.getByRole('button', { name: 'readAloud' }))
    const spoken = synth.speak.mock.calls[0]![0] as Utterance
    expect(spoken.text).toBe('Hello there')
    expect(spoken.voice).toBe(local)
    fireEvent.click(screen.getByRole('button', { name: 'stopReading' }))
    expect(synth.cancel).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'readAloud' })).toBeTruthy()
  })
  it('never falls back to a voice that sends text off the device', () => {
    synth.getVoices.mockReturnValue([{ lang: 'en-US', localService: false }])
    render(<ChatMessages state={state} commands={{} as PersonalCommands} t={key => key} />)
    fireEvent.click(screen.getByRole('button', { name: 'readAloud' }))
    expect(synth.speak).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('speechUnavailable')
  })
})
