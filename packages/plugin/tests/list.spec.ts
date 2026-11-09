import { describe, expect, it } from 'vitest'
import { groupChats } from '../src/client/list.ts'
import type { ChatActivity, ConversationId, ConversationSummary } from '../src/shared/types.ts'

const now = new Date(2026, 10, 8, 15, 0)
const at = (days: number, hours = 0) => new Date(2026, 10, 8 - days, 12 + hours).getTime()
const chat = (id: string, updatedAt: number, extra: { pinned?: boolean; activity?: ChatActivity } = {}): ConversationSummary => ({ id: id as ConversationId, title: id, updatedAt, pinned: extra.pinned ?? false, activity: extra.activity ?? 'idle' })
const shape = (items: readonly ConversationSummary[], order: 'time' | 'activity') => groupChats(items, order, now).map(group => [group.kind === 'month' ? `${group.year}-${group.month + 1}` : group.kind, group.items.map(item => item.id)])

describe('chat list groups', () => {
  it('keeps pinned chats on top and groups the rest by calendar day, then by month', () => {
    const items = [chat('older', new Date(2026, 8, 20).getTime()), chat('today', at(0)), chat('pin', at(40), { pinned: true }), chat('yesterday', at(1)), chat('week', at(6)), chat('month', at(20)), chat('october', new Date(2026, 9, 2).getTime()), chat('later today', at(0, 2))]
    expect(shape(items, 'time')).toEqual([['pinned', ['pin']], ['today', ['later today', 'today']], ['yesterday', ['yesterday']], ['week', ['week']], ['recent', ['month']], ['2026-10', ['october']], ['2026-9', ['older']]])
  })
  it('puts running, waiting and replied chats first when ordered by activity, then the rest newest first', () => {
    const items = [chat('idle new', at(0)), chat('replied', at(3), { activity: 'replied' }), chat('running', at(5), { activity: 'running' }), chat('pinned running', at(9), { pinned: true, activity: 'running' }), chat('waiting', at(1), { activity: 'waiting' }), chat('idle old', at(60))]
    expect(shape(items, 'activity')).toEqual([['pinned', ['pinned running']], ['running', ['running']], ['waiting', ['waiting']], ['replied', ['replied']], ['rest', ['idle new', 'idle old']]])
  })
  it('leaves out empty groups', () => {
    expect(shape([], 'time')).toEqual([])
    expect(shape([chat('only', at(0))], 'activity')).toEqual([['rest', ['only']]])
  })
})
