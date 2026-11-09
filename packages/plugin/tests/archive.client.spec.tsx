// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ArchiveHistory } from '../src/client/Archive.tsx'
import { PersonalPage } from '../src/client/Page.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { ArchiveNode, ArchiveView, Conversation } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())
afterEach(cleanup)
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const node = (id: string, role: string, text: string, flags: Partial<ArchiveNode> = {}): ArchiveNode => ({ id, parent: null, children: [], role, time: 1, text, structural: false, reasoning: false, unsupportedContent: false, ...flags })
const show = (branchNodes: readonly ArchiveNode[]) => {
  const archive = { revisionId: 'revision', selectedNode: 'answer', sourceId: 'source', title: 'Title', currentNode: 'answer', nodes: branchNodes, branchNodes, original: {}, warnings: [] } as unknown as ArchiveView
  const conversation = { archiveRevisions: ['revision'] } as unknown as Conversation
  render(<ArchiveHistory archive={archive} conversation={conversation} commands={{} as PersonalCommands} busy={false} t={t} />)
}

describe('imported history', () => {
  it('shows what was said and counts the reasoning it leaves out', () => {
    show([node('question', 'user', 'Why?'), node('thought', 'assistant', '', { reasoning: true }), node('recap', 'assistant', '', { reasoning: true }), node('answer', 'assistant', 'Because')])
    expect([...document.querySelectorAll('[data-archive-role]')].map(item => item.getAttribute('data-archive-role'))).toEqual(['user', 'assistant'])
    expect(screen.getByText(/reasoningHiddenShort.*"count":2/u)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'remember' })).toHaveLength(2)
  })
  it('says nothing about reasoning when a chat has none', () => {
    show([node('answer', 'assistant', 'Because')])
    expect(screen.queryByText(/reasoningHidden/u)).toBeNull()
  })
})

describe('a continued import', () => {
  const route = { provider: 'fixture', model: 'echo', name: 'Fixture', images: false }
  const message = { id: 'new', role: 'user', text: 'Carrying on', time: 1, attachmentIds: [], toolNames: [] }
  const archive = { revisionId: 'revision', selectedNode: 'answer', nodes: [], branchNodes: [node('answer', 'assistant', 'Earlier answer')], original: {}, warnings: [] }
  const conversation = { id: 'chat', title: 'Title', branches: [{ id: 'branch', messageIds: ['new'] }], selectedBranchId: 'branch', archiveRevisions: ['revision'], archived: false }
  const state = { status: 'ready', results: [], query: '', settings: undefined, busy: false, imports: [], models: [route], selectedModel: route, web: false, detail: { conversation, archive, messages: [message], attachments: [] } }
  it('reads as one conversation, with history above the new messages', () => {
    const usePersonal = ((select: (value: unknown) => unknown) => select(state)) as never
    const useStore = (() => null) as never
    render(<PersonalPage {...{ usePersonal, useStore, commands: { open: vi.fn() }, t } as never} />)
    const history = screen.getByText('Earlier answer')
    expect(history.closest('details')).toBeNull()
    expect(history.compareDocumentPosition(screen.getByText('Carrying on')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const scroller = screen.getByText('Carrying on').closest('article')!.parentElement!.parentElement!
    expect(scroller.contains(history)).toBe(true)
  })
})
