import { describe, expect, it } from 'vitest'
import { turnsOf, variantsOf } from '../src/client/turns.ts'
import type { BranchId, ChatBranch, ChatMessageView, Conversation, ConversationId } from '../src/shared/types.ts'

const message = (id: string, role: ChatMessageView['role'], text = '', extra: Partial<ChatMessageView> = {}): ChatMessageView => ({ id, role, text, time: 1, attachmentIds: [], toolNames: [], ...extra })

describe('turns', () => {
  it('folds tool steps into one reply with its files, list, sources and thinking time', () => {
    const turns = turnsOf([
      message('u1', 'user', 'Make a report'),
      message('a1', 'assistant', 'Planning.', { reasoning: 'First', thinkingMs: 1200, toolNames: ['todo_write'], todos: [{ content: 'Search', status: 'in_progress' }] }),
      message('t1', 'tool', '{"saved":true}'),
      message('a2', 'assistant', '', { toolNames: ['create_document'], sources: [{ url: 'https://a.example/' }] }),
      message('t2', 'tool', '{}', { attachmentIds: ['doc'] }),
      message('a3', 'assistant', 'Here it is.', { reasoning: 'Then', thinkingMs: 800, todos: [{ content: 'Search', status: 'completed' }], sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] }),
      message('u2', 'user', 'Thanks'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ key: 'u1', index: 0, text: 'Planning.\n\nHere it is.', reasoning: 'First\n\nThen', thinkingMs: 2000, todos: [{ content: 'Search', status: 'completed' }], attachmentIds: ['doc'], sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] })
    expect(turns[0]!.replies.map(reply => reply.id)).toEqual(['a1', 'a2', 'a3'])
    expect(turns[1]).toMatchObject({ key: 'u2', index: 6, text: '', replies: [] })
    expect(turns[1]).not.toHaveProperty('thinkingMs')
  })
  it('keeps a reply with no message before it', () => {
    expect(turnsOf([message('a', 'assistant', 'Hello')])).toMatchObject([{ key: 'a', index: 0, text: 'Hello' }])
  })
})

describe('versions of a position', () => {
  const branch = (id: string, messageIds: string[], extra: Partial<ChatBranch> = {}): ChatBranch => ({ id: id as BranchId, messageIds, createdAt: 1, ...extra })
  const conversation = (branches: ChatBranch[], selected: string): Conversation => ({ id: 'c' as ConversationId, title: '', temporary: false, archived: false, createdAt: 1, updatedAt: 1, branches, selectedBranchId: selected as BranchId, archiveRevisions: [], archiveWithdrawn: false })

  it('counts edits under the edited message and regenerations under the reply', () => {
    const branches = [
      branch('main', ['u1', 'a1', 'u2', 'a2']),
      branch('edit', ['u1', 'a1', 'u2e', 'a2e'], { operation: 'edit', parentBranchId: 'main' as BranchId }),
      branch('regen', ['u1b', 'a1b'], { operation: 'regenerate', parentBranchId: 'main' as BranchId }),
    ]
    const fromMain = variantsOf(conversation(branches, 'main'))
    expect([...fromMain.keys()]).toEqual([0, 2])
    expect(fromMain.get(0)).toEqual({ current: 0, targets: ['main', 'regen'], onReply: true })
    expect(fromMain.get(2)).toEqual({ current: 0, targets: ['main', 'edit'], onReply: false })
    expect(variantsOf(conversation(branches, 'edit')).get(2)).toEqual({ current: 1, targets: ['main', 'edit'], onReply: false })
  })
  it('opens the newest branch that holds a version, and ignores other imported starting points', () => {
    const branches = [
      branch('main', ['u1', 'a1']),
      branch('edit', ['u1e', 'a1e'], { operation: 'edit' }),
      branch('later', ['u1e', 'a1e', 'u2']),
      branch('import', ['x'], { archive: { revisionId: 'r' as never, nodeId: 'n' } }),
    ]
    expect(variantsOf(conversation(branches, 'main')).get(0)).toEqual({ current: 0, targets: ['main', 'later'], onReply: false })
    expect(variantsOf(conversation(branches, 'import')).size).toBe(0)
  })
})
