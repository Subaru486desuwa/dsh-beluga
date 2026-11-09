// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatMessages } from '../src/client/Chat.tsx'
import { Composer, useTray } from '../src/client/Composer.tsx'
import { ModelPicker } from '../src/client/ModelPicker.tsx'
import type { PersonalState } from '../src/client/model.ts'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { ModelChoice } from '../src/shared/models.ts'
import type { AppsView, CandidateId, ChatMessageView, ConversationDetail, ConversationId, MemoryCandidate, MemoryId, MemoryState, PendingAction, WorkSessionRef } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const text: ModelChoice = { provider: 'fixture', model: 'echo', name: 'Fixture · Echo', images: false }
const vision: ModelChoice = { provider: 'personal-inline', model: 'eye', name: 'Eye', images: true, inline: true }

function Harness({ state, commands, imagesNeeded = false }: { state: PersonalState; commands: PersonalCommands; imagesNeeded?: boolean }) {
  const tray = useTray(commands, 1024)
  return <Composer state={state} commands={commands} tray={tray} imagesNeeded={imagesNeeded} uploadable t={t} />
}
const composerState = (extra: Partial<PersonalState> = {}) => ({ busy: false, models: [text, vision], selectedModel: text, web: false, ...extra }) as PersonalState
const send = () => screen.getByRole('button', { name: 'send' }) as HTMLButtonElement

describe('composer', () => {
  it('does not submit IME composition or Shift+Enter, but submits ordinary Enter once', async () => {
    const commands = { send: vi.fn(async () => true) } as unknown as PersonalCommands
    render(<Harness state={composerState()} commands={commands} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '正在输入中文' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(commands.send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(commands.send).toHaveBeenCalledExactlyOnceWith('正在输入中文', []))
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''))
  })
  it('turns into a stop control while a reply is being written', () => {
    const stop = vi.fn(async () => true)
    render(<Harness state={composerState({ detail: { live: { id: 'turn' } } as unknown as ConversationDetail })} commands={{ stop } as unknown as PersonalCommands} />)
    expect(screen.queryByRole('button', { name: 'send' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    expect(stop).toHaveBeenCalledOnce()
  })
  it('uploads pasted files one at a time, keeps a failed one in place, and sends the rest', async () => {
    let finish!: () => void
    const upload = vi.fn((file: File) => file.name === 'bad.txt' ? Promise.resolve(undefined) : new Promise(resolve => { finish = () => resolve({ id: 'id-' + file.name, name: file.name, image: false }) }))
    const commands = { upload, send: vi.fn(async () => true) } as unknown as PersonalCommands
    render(<Harness state={composerState()} commands={commands} />)
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'bad.txt'), new File(['x'.repeat(2048)], 'big.txt')]
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files } })
    const tray = screen.getByRole('list', { name: 'attachments' })
    expect(within(tray).getAllByRole('listitem')).toHaveLength(3)
    expect(within(tray).getAllByRole('status', { name: 'uploading' })).toHaveLength(3)
    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    expect(send().disabled).toBe(true)
    await act(async () => { finish() })
    await waitFor(() => expect(within(tray).getAllByRole('alert').map(item => item.textContent)).toEqual(['uploadFailed', 'fileLimit']))
    expect(upload).toHaveBeenCalledTimes(2)
    fireEvent.click(send())
    await waitFor(() => expect(commands.send).toHaveBeenCalledWith('', ['id-a.txt']))
  })
  it('says on an Office file, before sending, that it cannot be read without the Office extension', () => {
    const commands = { upload: vi.fn(() => new Promise(() => {})) } as unknown as PersonalCommands
    const paste = () => fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['a'], '申请表.docx'), new File(['b'], 'notes.txt')] } })
    const view = render(<Harness state={composerState({ limits: { office: false } as PersonalState['limits'] })} commands={commands} />)
    paste()
    expect(within(screen.getByRole('list', { name: 'attachments' })).getAllByText(/officeNeeded/u).map(item => item.textContent)).toEqual(['officeNeeded · kindDocument'])
    view.unmount()
    render(<Harness state={composerState({ limits: { office: true } as PersonalState['limits'] })} commands={commands} />)
    paste()
    expect(screen.queryByText(/officeNeeded/u)).toBeNull()
  })
  it('will not send an image to a route that cannot read it, and offers one that can', async () => {
    const chooseModel = vi.fn()
    const commands = { upload: vi.fn(async (file: File) => ({ id: 'img', name: file.name, image: true })), chooseModel } as unknown as PersonalCommands
    const { rerender } = render(<Harness state={composerState()} commands={commands} />)
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['p'], 'photo.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('imageMismatch'))
    expect(send().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /switchModel.*Eye/u }))
    expect(chooseModel).toHaveBeenCalledWith(vision)
    rerender(<Harness state={composerState({ selectedModel: vision })} commands={commands} />)
    expect(screen.queryByText(/imageMismatch/u)).toBeNull()
    expect(send().disabled).toBe(false)
  })
  it('also holds back a chat whose history has images', () => {
    render(<Harness state={composerState()} commands={{} as PersonalCommands} imagesNeeded />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'More' } })
    expect(send().disabled).toBe(true)
  })
})

const apps = (github: Partial<AppsView['github']>, web = true): AppsView => ({ web: { available: web, auto: true }, github: { installed: true, auto: true, approval: 'ask', ...github }, work: { memoryAvailable: false, recordsAvailable: false, memory: false, records: false, workspaces: [] } })
describe('tools menu', () => {
  const open = () => { fireEvent.click(screen.getByRole('button', { name: 'tools' })); return screen.getAllByRole('menuitem').map(item => item.textContent) }
  it('offers GitHub once an account is connected, and shows a picked one as a chip', () => {
    const setGitHub = vi.fn()
    const commands = { setGitHub } as unknown as PersonalCommands
    const connected = apps({ account: 'octo', source: 'token' })
    const { rerender } = render(<Harness state={composerState({ apps: connected })} commands={commands} />)
    expect(open()).toEqual(['addFiles', 'webSearch', 'github'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'github' }))
    expect(setGitHub).toHaveBeenCalledWith(true)
    rerender(<Harness state={composerState({ github: true, apps: connected })} commands={commands} />)
    fireEvent.click(screen.getByRole('button', { name: 'removeGitHub' }))
    expect(setGitHub).toHaveBeenLastCalledWith(false)
  })
  it('leads to the Apps settings before an account is connected, and leaves out what is not installed', () => {
    const openSettings = vi.fn(async () => {})
    const commands = { openSettings } as unknown as PersonalCommands
    const view = render(<Harness state={composerState({ github: true, apps: apps({}) })} commands={commands} />)
    expect(open()).toEqual(['addFiles', 'webSearch', 'connectGitHub'])
    expect(screen.queryByRole('button', { name: 'removeGitHub' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'connectGitHub' }))
    expect(openSettings).toHaveBeenCalledWith('apps')
    view.unmount()
    render(<Harness state={composerState({ apps: apps({ installed: false }, false) })} commands={commands} />)
    expect(open()).toEqual(['addFiles'])
  })
})

describe('route and effort', () => {
  const reasoning: ModelChoice = { ...text, efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' }
  const picker = (state: Partial<PersonalState>, commands: Partial<PersonalCommands>, imagesNeeded = false) => <ModelPicker state={composerState(state)} commands={commands as PersonalCommands} imagesNeeded={imagesNeeded} disabled={false} t={t} />
  it('names the route and its effort, and moves the effort one stop at a time on a slider', () => {
    const chooseEffort = vi.fn()
    const { rerender } = render(picker({ models: [reasoning, vision], selectedModel: text }, { chooseEffort }))
    fireEvent.click(screen.getByRole('button', { name: 'chooseModel · Echo · effortMedium' }))
    const panel = screen.getByRole('dialog', { name: 'effortTitle' })
    const slider = within(panel).getByRole('slider', { name: 'effortTitle' }) as HTMLInputElement
    expect(document.activeElement).toBe(slider)
    expect(slider.getAttribute('aria-valuetext')).toBe('effortMedium')
    expect((within(panel).getByRole('button', { name: 'effortReset' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(slider, { target: { value: '2' } })
    expect(chooseEffort).toHaveBeenLastCalledWith('high')
    rerender(picker({ models: [reasoning, vision], selectedModel: { ...text, effort: 'high' } }, { chooseEffort }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'effortReset' }))
    expect(chooseEffort).toHaveBeenLastCalledWith(undefined)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('opens the route list from the route name, keeping routes that cannot read the chat’s images out', () => {
    const chooseModel = vi.fn()
    render(picker({ models: [reasoning, { ...vision, efforts: [{ id: 'high', name: 'High' }] }], selectedModel: vision }, { chooseModel }))
    // A route with one effort has nothing to slide, so the chip opens the list at once.
    fireEvent.click(screen.getByRole('button', { name: 'chooseModel · Eye' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Echo/u }))
    expect(chooseModel).toHaveBeenCalledWith(reasoning)
    cleanup()
    render(picker({ models: [reasoning, vision], selectedModel: text }, { chooseModel }, true))
    fireEvent.click(screen.getByRole('button', { name: /chooseModel · Echo/u }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'chooseModel · Echo' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('menuitem', { name: /Echo/u }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Eye' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

const message = (id: string, role: ChatMessageView['role'], body = '', extra: Partial<ChatMessageView> = {}): ChatMessageView => ({ id, role, text: body, time: 1, attachmentIds: [], toolNames: [], ...extra })
const thread = (messages: ChatMessageView[], extra: Partial<ConversationDetail> = {}) => ({ busy: false, detail: { conversation: { id: 'chat', branches: [], archiveRevisions: [] }, attachments: [], messages, ...extra } }) as unknown as PersonalState

describe('a turn', () => {
  const steps = (status: 'in_progress' | 'completed') => [message('u', 'user', 'Report'), message('a1', 'assistant', '', { toolNames: ['todo_write'], reasoning: 'Plan it', thinkingMs: 4200, todos: [{ content: 'Search', status: 'completed' }, { content: 'Write', status }] }), message('t1', 'tool', '{"saved":true}')]
  it('shows the list open while it works, ticking items, and hides the tool result', () => {
    render(<ChatMessages state={thread(steps('in_progress'), { live: { id: 'turn', branchId: 'b' as never, text: '', reasoning: '', tool: 'web_search', stepElapsedMs: 0 } })} commands={{} as PersonalCommands} t={t} />)
    expect(screen.getByRole('button', { name: /todoProgress.*"done":1.*"total":2/u }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Write')).toBeTruthy()
    expect(screen.queryByText('{"saved":true}')).toBeNull()
    expect(screen.queryByText(/toolWebSearch/u)).toBeNull()
    expect(screen.getByText(/thoughtFor.*"seconds":4/u)).toBeTruthy()
  })
  it('folds the list once the reply is done', () => {
    render(<ChatMessages state={thread([...steps('completed'), message('a2', 'assistant', 'Done.')])} commands={{} as PersonalCommands} t={t} />)
    const head = screen.getByRole('button', { name: /todoDone.*"count":2/u })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Write')).toBeNull()
    expect(screen.getByText('Done.')).toBeTruthy()
  })
  it('leaves unfinished items open and marked stopped when the reply did not finish', () => {
    render(<ChatMessages state={thread(steps('in_progress'), { error: 'stopped' })} commands={{} as PersonalCommands} t={t} />)
    expect(screen.getByRole('button', { name: /todoStopped/u }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Write').closest('li')!.getAttribute('data-status')).toBe('in_progress')
  })
  it('says what a tool is doing when there is no list', () => {
    render(<ChatMessages state={thread([message('u', 'user', 'Look it up')], { live: { id: 'turn', branchId: 'b' as never, text: '', reasoning: '', tool: 'web_search', stepElapsedMs: 0 } })} commands={{} as PersonalCommands} t={t} />)
    expect(screen.getByText('toolWebSearch')).toBeTruthy()
  })
  it('shows thinking as it streams, and its text on request', () => {
    render(<ChatMessages state={thread([message('u', 'user', 'Why?')], { live: { id: 'turn', branchId: 'b' as never, text: '', reasoning: 'Because of', stepElapsedMs: 0 } })} commands={{} as PersonalCommands} t={t} />)
    const toggle = screen.getByRole('button', { name: /thinkingFor.*"seconds":0/u })
    expect(screen.queryByText('Because of')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Because of')).toBeTruthy()
  })
  it('counts every second from where the Host says the step began, and keeps the count when output starts', () => {
    vi.useFakeTimers({ now: 100_000 })
    try {
      const view = (live: object) => <ChatMessages state={thread([message('u', 'user', 'Why?')], { live: { id: 'turn', branchId: 'b' as never, text: '', reasoning: 'Because of', stepElapsedMs: 2500, ...live } })} commands={{} as PersonalCommands} t={t} />
      const { rerender } = render(view({}))
      expect(screen.getByRole('button', { name: /thinkingFor.*"seconds":2/u })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.getByRole('button', { name: /thinkingFor.*"seconds":3/u })).toBeTruthy()
      // A later Host view of the same step re-bases to the same start instead of restarting the count.
      rerender(view({ stepElapsedMs: 3100 }))
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: /thinkingFor.*"seconds":4/u })).toBeTruthy()
      rerender(view({ stepElapsedMs: 3100, text: 'It is' }))
      expect(screen.getByRole('button', { name: /thoughtFor.*"seconds":4/u })).toBeTruthy()
    } finally { vi.useRealTimers() }
  })
})

describe('what a reply proposed to memory and drew on', () => {
  const cid = (id: string) => id as CandidateId
  const mid = (id: string) => id as MemoryId
  const candidate = (id: string, extra: Partial<MemoryCandidate>): MemoryCandidate => ({ id: cid(id), revision: 1, text: id + ' text', category: 'preference', source: { kind: 'chat', conversationId: 'chat' as ConversationId, messageId: 'u' }, reason: 'review', state: 'pending', createdAt: 1, updatedAt: 1, ...extra }) as MemoryCandidate
  const saved = { id: mid('m1'), revision: 1, text: 'Prefers tea', category: 'preference', scope: 'personal', source: { kind: 'manual' }, createdAt: 1, updatedAt: 1, state: 'active' } as MemoryState['memories'][number]
  const memory = { memories: [saved, { ...saved, id: mid('m2'), text: 'Lives by the sea' }], candidates: [candidate('k1', {}), candidate('k2', { state: 'saved', memoryId: mid('m1'), reason: 'low-risk' }), candidate('k3', { state: 'rejected' })] } as unknown as MemoryState
  const replied = [message('u', 'user', 'Tea?'), message('a1', 'assistant', '', { toolNames: ['memory_propose'] }), message('t1', 'tool', '{}', { proposed: [cid('k1'), cid('k2'), cid('k3')] }), message('a2', 'assistant', 'Noted.', { recalled: [mid('m2'), mid('gone')], referenced: [{ conversationId: 'old' as ConversationId, title: 'Trip plan' }], sources: [{ url: 'https://example.com/tea', title: 'Tea guide' }] })]
  it('saves or dismisses a waiting memory under the reply, and undoes one saved on its own', () => {
    const commands = { decide: vi.fn(async () => true), forget: vi.fn(async () => true) } as unknown as PersonalCommands
    render(<ChatMessages state={{ ...thread(replied), memory }} commands={commands} t={t} />)
    const card = screen.getByRole('region', { name: 'memoryTitle' })
    const waiting = within(card).getByText('k1 text').closest('div')!
    fireEvent.click(within(waiting).getByRole('button', { name: 'confirm' }))
    expect(commands.decide).toHaveBeenCalledWith(memory.candidates[0], 'confirm')
    fireEvent.click(within(waiting).getByRole('button', { name: 'reject' }))
    expect(commands.decide).toHaveBeenLastCalledWith(memory.candidates[0], 'reject')
    const done = within(card).getByText('Prefers tea').closest('div')!
    expect(within(done).getByText('memoryUpdated')).toBeTruthy()
    fireEvent.click(within(done).getByRole('button', { name: 'memoryUndo' }))
    expect(commands.forget).toHaveBeenCalledWith(saved)
    expect(within(card).queryByText('k3 text')).toBeNull()
  })
  it('lists pages, Saved Memories and earlier chats as sources, and opens a chat from there', () => {
    const commands = { open: vi.fn(async () => true) } as unknown as PersonalCommands
    render(<ChatMessages state={{ ...thread(replied), memory }} commands={commands} t={t} />)
    const sources = screen.getByRole('navigation', { name: 'sources' })
    expect(within(sources).getByRole('link', { name: 'Tea guide' }).getAttribute('href')).toBe('https://example.com/tea')
    expect(within(sources).getByText('Lives by the sea')).toBeTruthy()
    expect(within(sources).queryByText(/gone/u)).toBeNull()
    fireEvent.click(within(sources).getByRole('button', { name: /Trip plan/u }))
    expect(commands.open).toHaveBeenCalledWith('old')
  })
  it('lists the Work sessions a reply found or read once each, and opens one in Work', () => {
    const work = [{ sessionId: 's-1' as WorkSessionRef, title: 'Fix login' }]
    const openWork = vi.fn()
    render(<ChatMessages state={thread([message('u', 'user', 'Today?'), message('t1', 'tool', '{}', { work }), message('t2', 'tool', '{}', { work }), message('a', 'assistant', 'You fixed login.')])} commands={{ openWork } as unknown as PersonalCommands} t={t} />)
    const sources = screen.getByRole('navigation', { name: 'sources' })
    const session = within(sources).getByRole('button', { name: 'sourceWorkFix login' })
    expect(within(sources).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(session)
    expect(openWork).toHaveBeenCalledWith('s-1')
  })
  it('shows neither before memory has loaded', () => {
    render(<ChatMessages state={thread(replied)} commands={{} as PersonalCommands} t={t} />)
    expect(screen.queryByRole('region', { name: 'memoryTitle' })).toBeNull()
    expect(screen.queryByText('Lives by the sea')).toBeNull()
    expect(screen.getByRole('link', { name: 'Tea guide' })).toBeTruthy()
  })
})

describe('an action waiting for the person', () => {
  const action: PendingAction = { id: 'act', tool: 'merge_pull_request', risk: 'high', target: 'o/r#3', details: '{\n  "pullNumber": 3\n}' }
  const live = (extra: object) => ({ id: 'turn', branchId: 'b' as never, text: '', reasoning: '', tool: 'github__merge_pull_request', ...extra })
  it('shows what will be sent in place of the status, and passes the answer on', () => {
    const decideAction = vi.fn(async () => true)
    render(<ChatMessages state={thread([message('u', 'user', 'Merge it')], { live: live({ approval: action }) })} commands={{ decideAction } as unknown as PersonalCommands} t={t} />)
    const card = screen.getByRole('region', { name: 'approvalTitle' })
    expect(within(card).getByText('riskHigh').getAttribute('data-risk')).toBe('high')
    expect(within(card).getByText('merge pull request')).toBeTruthy()
    expect(within(card).getByText('o/r#3')).toBeTruthy()
    expect(within(card).getByText(/"pullNumber": 3/u)).toBeTruthy()
    expect(screen.queryByText('toolGitHub')).toBeNull()
    expect(screen.queryByRole('status', { name: 'loading' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'decline' }))
    fireEvent.click(within(card).getByRole('button', { name: 'allow' }))
    expect(decideAction.mock.calls).toEqual([['act', false], ['act', true]])
  })
  it('says GitHub is working while a GitHub tool runs', () => {
    render(<ChatMessages state={thread([message('u', 'user', 'List them')], { live: live({ tool: 'github__list_issues' }) })} commands={{} as PersonalCommands} t={t} />)
    expect(screen.getByText('toolGitHub')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'approvalTitle' })).toBeNull()
  })
})

describe('versions and edits', () => {
  const branch = (id: string, messageIds: string[], operation?: 'edit' | 'regenerate') => ({ id, messageIds, createdAt: 1, ...operation ? { operation } : {} })
  const versioned = (operation: 'edit' | 'regenerate') => {
    const messages = [message('u1', 'user', 'Hi'), message('a1', 'assistant', 'Hello')]
    const state = thread(messages)
    return { ...state, detail: { ...state.detail!, conversation: { ...state.detail!.conversation, branches: [branch('main', ['u1', 'a1']), branch('other', ['u2', 'a2'], operation)], selectedBranchId: 'main' } } } as PersonalState
  }
  it('switches between edited versions under the message', () => {
    const selectBranch = vi.fn(async () => true)
    render(<ChatMessages state={versioned('edit')} commands={{ selectBranch } as unknown as PersonalCommands} t={t} />)
    const next = screen.getByRole('button', { name: 'nextVersion' })
    expect(next.closest('[class]')!.parentElement!.textContent).toContain('versionCount')
    fireEvent.click(next)
    expect(selectBranch).toHaveBeenCalledWith('other')
    expect((screen.getByRole('button', { name: 'previousVersion' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('puts the switch under the reply when the other versions were regenerated', () => {
    render(<ChatMessages state={versioned('regenerate')} commands={{} as PersonalCommands} t={t} />)
    expect(screen.getByRole('button', { name: 'nextVersion' }).closest('article')!.querySelector('[class*=replyActions]')!.contains(screen.getByRole('button', { name: 'nextVersion' }))).toBe(true)
  })
  it('edits a message in place and sends it as a new version', async () => {
    const branchCommand = vi.fn(async () => true)
    render(<ChatMessages state={thread([message('u1', 'user', 'Hi'), message('a1', 'assistant', 'Hello')])} commands={{ branch: branchCommand } as unknown as PersonalCommands} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'edit' }))
    const box = screen.getByRole('textbox', { name: 'edit' })
    fireEvent.change(box, { target: { value: 'Hi again' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(branchCommand).toHaveBeenCalledWith('u1', 'edit', 'Hi again'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'edit' })).toBeNull())
  })
})

it('shows original input and artifact version cards with downloads', () => {
  const file = { id: 'generated', conversationId: 'chat', name: 'Report.docx', bytes: 1024, image: false, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', artifact: { rootId: 'generated', version: 2, summary: 'Second section updated' } }
  const state = { busy: false, detail: { conversation: { id: 'chat' }, messages: [message('tool', 'tool', '{}', { attachmentIds: ['generated', 'input'] })], attachments: [file, { ...file, id: 'input', artifact: undefined }] } } as unknown as PersonalState
  render(<ChatMessages state={state} commands={{} as PersonalCommands} t={t} />)
  expect(screen.getByText(/artifactVersion.*"version":2/u)).toBeTruthy()
  expect(screen.getByText(/inputFile/u)).toBeTruthy()
  expect(screen.getByText('Second section updated')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'download' })).toHaveLength(2)
})

it('explains an output-limit cutoff instead of a generic failure and keeps retry', () => {
  const state = { busy: false, detail: { conversation: { id: 'chat' }, messages: [message('user', 'user', 'Write')], attachments: [], error: 'max-tokens' } } as unknown as PersonalState
  render(<ChatMessages state={state} commands={{} as PersonalCommands} t={t} />)
  expect(screen.getByRole('status').textContent).toContain('replyTruncated')
  expect(screen.queryByText(/replyError/)).toBeNull()
  expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
})
const reply = (extra: Partial<ChatMessageView>) => thread([message('reply', 'assistant', 'Hello **there**', extra)])
it('links each source of a reply in a new tab', () => {
  render(<ChatMessages state={reply({ sources: [{ url: 'https://example.com/a', title: 'Article' }, { url: 'https://example.org/b' }] })} commands={{} as PersonalCommands} t={t} />)
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
  it('speaks plain text with a local voice and stops on a second press', () => {
    const local = { lang: 'en-US', localService: true }
    synth.getVoices.mockReturnValue([{ lang: 'en-US', localService: false }, local])
    render(<ChatMessages state={reply({})} commands={{} as PersonalCommands} t={t} />)
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
    render(<ChatMessages state={reply({})} commands={{} as PersonalCommands} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'readAloud' }))
    expect(synth.speak).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('speechUnavailable')
  })
})
