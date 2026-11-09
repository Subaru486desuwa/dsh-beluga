/**
 * Hand-off to Work: a task brief written from the open chat. The person reads it in a new Work
 * session's composer, picks nothing more, and sends it themselves; Chat never starts Work (ADR 0006).
 */
import { PersonalChatError } from './archive.ts'
import type { Config } from './config.ts'
import type { Conversations } from './conversations.ts'
import type { ModelBridge } from './model-bridge.ts'
import { textOf, type ConversationRecord } from './records.ts'
import type { ConversationId } from '../shared/types.ts'

const BRIEF_INSTRUCTIONS = 'You write task briefs for a coding agent. From the chat below, write the message the user would send to start this task in their code workspace: the goal, what was decided or found, constraints, and open questions. Keep only what concerns the task; leave out personal details and small talk. Write in the language of the user\'s messages, addressed to the agent, in at most 300 words. Reply with the brief only.'
/** Characters of the chat, newest first, a brief request carries. */
const SOURCE_CHARS = 12000
/** How long the person waits for a brief before it is given up. */
const BRIEF_TIMEOUT_MS = 120000

/**
 * @param record - the chat; only its selected branch counts.
 * @returns the newest messages that fit in `chars`, oldest first, each marked with who said it.
 */
export function briefSource(record: ConversationRecord, chars: number): string {
  const branch = record.conversation.branches.find(item => item.id === record.conversation.selectedBranchId)
  const entries = new Map(record.entries.map(entry => [entry.id, entry]))
  const parts: string[] = []
  let used = 0
  for (const id of [...branch?.messageIds ?? []].reverse()) {
    const entry = entries.get(id)
    const role = entry?.message.role
    if (!entry || (role !== 'user' && role !== 'assistant')) continue
    const text = (role === 'user' ? entry.userText ?? textOf(entry.message) : textOf(entry.message)).trim()
    if (!text) continue
    const part = '<' + role + '>\n' + text + '\n</' + role + '>'
    if (used + part.length > chars) {
      if (!parts.length) parts.push('<' + role + '>\n' + Array.from(text).slice(-chars).join('') + '\n</' + role + '>')
      break
    }
    parts.push(part)
    used += part.length
  }
  return parts.reverse().join('\n')
}

/** Writes hand-off briefs; disposing stops a brief being written. */
export class HandOff {
  private readonly controller = new AbortController()

  constructor(private readonly chats: Conversations, private readonly bridge: ModelBridge, private readonly config: Config) {}

  /** @returns a brief from the chat, written by its last route at its least effort. */
  async brief(id: ConversationId): Promise<string> {
    const record = this.chats.record(id)
    const source = briefSource(record, SOURCE_CHARS)
    if (!source) throw new PersonalChatError('empty-chat', 'Send a message before handing this chat to Work')
    const last = record.model ?? this.chats.domain.preferences.get().last
    const route = last && await this.bridge.quiet(last)
    if (!route) throw new PersonalChatError('model-unavailable', 'Select an available configured model')
    const answer = await this.bridge.complete(route, BRIEF_INSTRUCTIONS, source, this.config.maxOutputTokens, AbortSignal.any([this.controller.signal, AbortSignal.timeout(BRIEF_TIMEOUT_MS)]))
    const brief = answer.text.trim()
    if (!brief) throw new PersonalChatError('brief-empty', 'The model returned no brief; try again')
    return brief
  }
  dispose(): void { this.controller.abort() }
}
