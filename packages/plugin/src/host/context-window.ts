import { PersonalChatError } from './archive.ts'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ChatEntry } from './records.ts'

const sizes = new WeakMap<Message, number>()
function serializedBytes(message: Message): number {
  let size = sizes.get(message)
  if (size === undefined) {
    size = Buffer.byteLength(JSON.stringify(message))
    sizes.set(message, size)
  }
  return size
}

/**
 * Choose the newest history that fits one model request. Whole turns leave from the
 * oldest end, so a request always opens on a user message.
 * @param entries - the branch, oldest first; the last turn holds the current input.
 * @param system - system prompt counted against the limit.
 * @param prefix - messages that always accompany the history.
 * @param limit - bytes allowed for the system prompt plus the serialized message array.
 * @returns the retained suffix of `entries`.
 * @throws PersonalChatError when the newest turn alone is over the limit.
 */
export function contextWindow(entries: readonly ChatEntry[], system: string, prefix: readonly Message[], limit: number): readonly ChatEntry[] {
  // A JSON array costs its two brackets plus one comma between items.
  const framed = (message: Message): number => serializedBytes(message) + 1
  let total = Buffer.byteLength(system) + 1
  for (const message of prefix) total += framed(message)
  for (const entry of entries) total += framed(entry.message)
  let start = 0
  while (total > limit) {
    let next = start + 1
    while (next < entries.length && entries[next]!.message.role !== 'user') next++
    if (next >= entries.length) throw new PersonalChatError('context-limit', 'Current input and context exceed maxContextBytes; shorten the input or profile')
    for (; start < next; start++) total -= framed(entries[start]!.message)
  }
  return start ? entries.slice(start) : entries
}
