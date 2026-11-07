/** Browser navigation remembers only a durable conversation identity, never chat content. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ConversationId } from '../shared/types.ts'

type PersonalView = { conversationId: ConversationId | null }
type PersonalViewActions = { select: (draft: PersonalView, id: ConversationId | null) => void }

/** @returns registered root navigation store; temporary chats always select null. */
export function createPersonalViewStore(): EngineStoreHandle<PersonalView, PersonalViewActions> {
  return defineStore({ init: (): PersonalView => ({ conversationId: null }), persist: 'dsh.personal-chat.navigation',
    actions: { select: (draft, id: ConversationId | null) => { draft.conversationId = id } },
  })
}
