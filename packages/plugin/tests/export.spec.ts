import { describe, expect, it } from 'vitest'
import { conversationMarkdown, exportName } from '../src/client/export.ts'
import { speakable } from '../src/client/markdown.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const labels = { user: 'You', assistant: 'Assistant' }
const message = (id: string, role: string, text: string, extra: object = {}) => ({ id, role, text, time: 0, attachmentIds: [], toolNames: [], ...extra })
const detail = (value: object) => ({ conversation: { title: 'Trip plan' }, attachments: [], messages: [], omittedMessages: 0, ...value }) as unknown as ConversationDetail

describe('conversation export', () => {
  it('writes the visible conversation and skips tool output', () => {
    const text = conversationMarkdown(detail({ attachments: [{ id: 'file', name: 'notes.pdf' }], messages: [
      message('a', 'user', 'Plan it', { attachmentIds: ['file'] }),
      message('b', 'tool', '{"secret":true}'),
      message('c', 'assistant', '**Done**', { reasoning: 'hidden thoughts', sources: [{ url: 'https://example.com/a', title: 'Guide' }] }),
    ] }), labels)
    expect(text).toBe('# Trip plan\n\n## You\n\nPlan it\n\nnotes.pdf\n\n## Assistant\n\n**Done**\n\n- [Guide](https://example.com/a)\n')
  })
  it('exports the selected imported branch when the chat has no messages of its own', () => {
    const archive = { branchNodes: [{ role: 'user', text: 'Old question', structural: false }, { role: null, text: '', structural: true }, { role: 'assistant', text: 'Old answer', structural: false }] }
    expect(conversationMarkdown(detail({ archive }), labels)).toBe('# Trip plan\n\n## You\n\nOld question\n\n## Assistant\n\nOld answer\n')
  })
  it('names the file after the title without path characters', () => {
    expect(exportName('a/b: c?')).toBe('a_b_ c_.md')
    expect(exportName('')).toBe('chat.md')
  })
})

describe('read-aloud text', () => {
  it('keeps the words and drops code and markup', () => {
    expect(speakable('# Title\n\nSee **bold** and [a link](https://example.com).\n\n```js\nconst x = 1\n```\n\n- item `code`')).toBe('Title See bold and a link. item code')
  })
})
