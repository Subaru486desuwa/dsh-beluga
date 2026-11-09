/** Chat titles a model writes once, from the first exchange, after the first reply. */
import { PersonalChatError } from './archive.ts'
import type { Config } from './config.ts'
import type { Conversations } from './conversations.ts'
import type { ModelBridge } from './model-bridge.ts'
import type { ModelRef } from '../shared/models.ts'
import type { ConversationId } from '../shared/types.ts'

const TITLE_INSTRUCTIONS = 'You title chats. Write a title for the chat below: at most 8 words, or at most 16 characters in Chinese or Japanese, in the language of the user’s message. Name the topic. No quotes, no trailing punctuation, no emoji. Reply with the title only.'
/** Characters of each side of the first exchange a title request carries. */
const EXCERPT_CHARS = 2000
/** Characters a title keeps, as the title a chat starts with does. */
const TITLE_CHARS = 80

const clip = (text: string, chars: number) => Array.from(text).slice(0, chars).join('')

/**
 * @param reply - the model's answer to a title request.
 * @returns its first line without heading marks, wrapping quotes or trailing punctuation, bounded; undefined when nothing is left.
 */
export function parseTitle(reply: string): string | undefined {
  const line = reply.split('\n').map(value => value.trim()).find(Boolean)
  const bare = (text: string) => text.replace(/[\s。.!！?？,，;；:：]+$/u, '')
  const title = line && bare(bare(line.replace(/^#+\s*/u, '')).replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/gu, '')).trim()
  return title ? clip(title, TITLE_CHARS) : undefined
}

/** Titles new chats in the background; a failure leaves the title the chat started with. */
export class Titles {
  private readonly controller = new AbortController()

  constructor(private readonly chats: Conversations, private readonly bridge: ModelBridge, private readonly config: Config, private readonly warn: (message: string) => void) {}

  /**
   * After a reply: title the chat when the reply answered its first message and nobody titled it yet.
   * Chats from before this, imported chats and Temporary Chats keep their titles; a rename before the title arrives wins.
   * @param userId - the message the reply answered.
   * @param reply - the reply's text.
   * @param model - the route that wrote the reply; the title request uses it at its least effort.
   */
  consider(id: ConversationId, userId: string, reply: string, model: ModelRef): void {
    if (!this.config.autoTitles || this.chats.closing) return
    let asked: string
    try {
      const record = this.chats.raw(id)
      const first = record?.entries[0]
      if (!record || !first || first.id !== userId || record.conversation.temporary || record.conversation.titleSource || record.conversation.archiveRevisions.length) return
      asked = first.userText ?? ''
    } catch { return /* Storage is closing; the title the chat started with stays. */ }
    void this.title(id, asked, reply, model).catch((error: unknown) => {
      if (!this.controller.signal.aborted) this.warn('personal-chat: titling a chat failed: ' + (error instanceof PersonalChatError ? error.reason : 'unexpected'))
    })
  }
  dispose(): void { this.controller.abort() }

  private async title(id: ConversationId, asked: string, reply: string, model: ModelRef): Promise<void> {
    const route = await this.bridge.quiet(model)
    if (!route) throw new PersonalChatError('model-unavailable', 'The chat model is not available')
    const input = '<user>\n' + clip(asked, EXCERPT_CHARS) + '\n</user>\n<assistant>\n' + clip(reply, EXCERPT_CHARS) + '\n</assistant>'
    const answer = await this.bridge.complete(route, TITLE_INSTRUCTIONS, input, this.config.maxOutputTokens, this.controller.signal)
    const title = answer.cut ? undefined : parseTitle(answer.text)
    if (!title) throw new PersonalChatError('title-format', 'The model returned no title')
    await this.chats.serial(async () => {
      const current = this.chats.raw(id)
      if (!current || current.deleting || this.chats.deleting.has(id) || current.conversation.titleSource) return
      await this.chats.saveConversation({ ...current.conversation, title, titleSource: 'generated' })
    })
  }
}
