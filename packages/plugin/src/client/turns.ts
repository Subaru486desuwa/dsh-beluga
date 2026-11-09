/**
 * A chat reads as turns: one message from the person and everything the assistant did to
 * answer it. Tool calls and results stay in the history the model sees, but a person sees
 * only the reply, its files, its to-do list, how long it thought, and what it drew on or proposed to memory.
 */
import type { BranchId, CandidateId, ChatBranch, ChatMessageView, ChatReference, Conversation, MemoryId, TodoItem, WebSource, WorkReference } from '../shared/types.ts'

export interface ChatTurn {
  readonly key: string
  /** Position of the turn's first message in the branch, where its variants are counted. */
  readonly index: number
  readonly user?: ChatMessageView
  /** Assistant messages in order; the last one is the answer actions act on. */
  readonly replies: readonly ChatMessageView[]
  readonly text: string
  readonly reasoning: string
  readonly thinkingMs?: number
  readonly todos?: readonly TodoItem[]
  /** Files the turn produced, on the reply or on a tool result. */
  readonly attachmentIds: readonly string[]
  readonly sources: readonly WebSource[]
  /** Memory candidates the turn proposed, noted on its tool results. */
  readonly proposed: readonly CandidateId[]
  /** Saved Memories the turn was given as context or looked up. */
  readonly recalled: readonly MemoryId[]
  /** Earlier chats the turn found. */
  readonly referenced: readonly ChatReference[]
  /** Work sessions the turn found or read. */
  readonly work: readonly WorkReference[]
}

/** @returns the first value for each key, in first-seen order. */
function unique<V, K>(values: readonly V[], key: (value: V) => K): V[] {
  const kept = new Map<K, V>()
  for (const value of values) if (!kept.has(key(value))) kept.set(key(value), value)
  return [...kept.values()]
}

/** @param messages - one branch in order. @returns its turns, a reply with no message before it standing alone. */
export function turnsOf(messages: readonly ChatMessageView[]): ChatTurn[] {
  const turns: { index: number; user?: ChatMessageView; rest: ChatMessageView[] }[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user' || !turns.length) turns.push({ index, ...(message.role === 'user' ? { user: message } : {}), rest: message.role === 'user' ? [] : [message] })
    else turns.at(-1)!.rest.push(message)
  })
  return turns.map(({ index, user, rest }) => {
    const replies = rest.filter(message => message.role === 'assistant')
    const timed = replies.filter(message => message.thinkingMs !== undefined)
    const todos = replies.findLast(message => message.todos)?.todos
    return {
      key: user?.id ?? rest[0]!.id, index, ...(user ? { user } : {}), replies,
      text: replies.map(message => message.text.trim()).filter(Boolean).join('\n\n'),
      reasoning: replies.map(message => message.reasoning?.trim() ?? '').filter(Boolean).join('\n\n'),
      ...(timed.length ? { thinkingMs: timed.reduce((sum, message) => sum + message.thinkingMs!, 0) } : {}),
      ...(todos ? { todos } : {}),
      attachmentIds: rest.flatMap(message => message.attachmentIds),
      sources: unique(replies.flatMap(message => message.sources ?? []), source => source.url),
      proposed: unique(rest.flatMap(message => message.proposed ?? []), id => id),
      recalled: unique(rest.flatMap(message => message.recalled ?? []), id => id),
      referenced: unique(rest.flatMap(message => message.referenced ?? []), chat => chat.conversationId),
      work: unique(rest.flatMap(message => message.work ?? []), session => session.sessionId),
    }
  })
}

/** Other versions of one position in the branch, reached by editing or regenerating. */
export interface Variants {
  /** Zero-based position of the selected version. */
  readonly current: number
  /** The branch to open for each version, in the order they were made. */
  readonly targets: readonly BranchId[]
  /** Every other version came from regenerating, so the switch belongs under the reply. */
  readonly onReply: boolean
}

const sameStart = (left: ChatBranch, right: ChatBranch) => left.archive?.revisionId === right.archive?.revisionId && left.archive?.nodeId === right.archive?.nodeId

/**
 * Branches share their messages up to where an edit or a regeneration cut them, so the
 * versions of a position are the distinct messages there among branches that agree before it.
 * @param conversation - all branches, in the order they were made.
 * @returns versions by message position, only where there is more than one.
 */
export function variantsOf(conversation: Conversation): ReadonlyMap<number, Variants> {
  const result = new Map<number, Variants>()
  const selected = conversation.branches.find(branch => branch.id === conversation.selectedBranchId)
  if (!selected) return result
  let peers = conversation.branches.filter(branch => sameStart(branch, selected))
  for (const [index, messageId] of selected.messageIds.entries()) {
    const groups = new Map<string, ChatBranch[]>()
    for (const branch of peers) if (branch.messageIds.length > index) {
      const id = branch.messageIds[index]!
      groups.set(id, [...groups.get(id) ?? [], branch])
    }
    if (groups.size > 1) {
      const versions = [...groups.entries()]
      result.set(index, {
        current: versions.findIndex(([id]) => id === messageId),
        targets: versions.map(([id, branches]) => id === messageId ? selected.id : branches.at(-1)!.id),
        onReply: versions.slice(1).every(([, branches]) => branches[0]!.operation === 'regenerate'),
      })
    }
    peers = peers.filter(branch => branch.messageIds[index] === messageId)
  }
  return result
}
