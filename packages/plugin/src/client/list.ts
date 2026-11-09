/** Groups the chat list for the sidebar: pinned chats first, then the rest by last activity or by Chat Activity State. */
import type { ChatActivity, ConversationSummary } from '../shared/types.ts'

/** How unpinned chats are ordered: by last activity in date groups, or by how much they need the person. */
export type ChatOrder = 'time' | 'activity'

/** One headed run of chats; months beyond the last 30 days are named by year and month (0-11). */
export type ChatGroup =
  | { readonly kind: 'pinned' | 'today' | 'yesterday' | 'week' | 'recent' | 'running' | 'waiting' | 'replied' | 'rest'; readonly items: readonly ConversationSummary[] }
  | { readonly kind: 'month'; readonly year: number; readonly month: number; readonly items: readonly ConversationSummary[] }

const NEEDS: readonly Exclude<ChatActivity, 'idle'>[] = ['running', 'waiting', 'replied']

/**
 * @param items - the listed chats, in any order.
 * @param order - how to order the chats that are not pinned.
 * @param now - the current time; date groups follow its local calendar days.
 * @returns non-empty groups in display order, each newest first.
 */
export function groupChats(items: readonly ConversationSummary[], order: ChatOrder, now: Date): ChatGroup[] {
  const newest = [...items].sort((a, b) => b.updatedAt - a.updatedAt)
  const groups: ChatGroup[] = [{ kind: 'pinned', items: newest.filter(item => item.pinned) }]
  const rest = newest.filter(item => !item.pinned)
  if (order === 'activity') {
    for (const kind of NEEDS) groups.push({ kind, items: rest.filter(item => item.activity === kind) })
    groups.push({ kind: 'rest', items: rest.filter(item => item.activity === 'idle') })
  } else {
    const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime()
    const bounds = [{ kind: 'today', from: day(0) }, { kind: 'yesterday', from: day(1) }, { kind: 'week', from: day(7) }, { kind: 'recent', from: day(30) }] as const
    for (const { kind, from } of bounds) groups.push({ kind, items: rest.filter(item => item.updatedAt >= from && !bounds.some(bound => bound.from > from && item.updatedAt >= bound.from)) })
    const older = new Map<string, { year: number; month: number; items: ConversationSummary[] }>()
    for (const item of rest.filter(value => value.updatedAt < day(30))) {
      const date = new Date(item.updatedAt)
      const key = `${date.getFullYear()}-${date.getMonth()}`
      const group = older.get(key) ?? { year: date.getFullYear(), month: date.getMonth(), items: [] }
      group.items.push(item)
      older.set(key, group)
    }
    for (const group of older.values()) groups.push({ kind: 'month', ...group })
  }
  return groups.filter(group => group.items.length > 0)
}
