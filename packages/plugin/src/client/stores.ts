/** Browser navigation remembers only a durable conversation identity and how the list is ordered, never chat content. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ConversationId } from '../shared/types.ts'
import type { ChatOrder } from './list.ts'

type PersonalView = { conversationId: ConversationId | null }
type PersonalViewActions = { select: (draft: PersonalView, id: ConversationId | null) => void }

/** @returns registered root navigation store; temporary chats always select null. */
export function createPersonalViewStore(): EngineStoreHandle<PersonalView, PersonalViewActions> {
  return defineStore({ init: (): PersonalView => ({ conversationId: null }), persist: 'dsh.personal-chat.navigation',
    actions: { select: (draft, id: ConversationId | null) => { draft.conversationId = id } },
  })
}

type PersonalList = { order: ChatOrder }
type PersonalListActions = { setOrder: (draft: PersonalList, order: ChatOrder) => void }

/** @returns the sidebar list's remembered order, by time unless the person chose otherwise. */
export function createPersonalListStore(): EngineStoreHandle<PersonalList, PersonalListActions> {
  return defineStore({ init: (): PersonalList => ({ order: 'time' }), persist: 'dsh.personal-chat.list',
    actions: { setOrder: (draft, order: ChatOrder) => { draft.order = order } },
  })
}
