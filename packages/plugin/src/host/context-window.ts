import { PersonalChatError } from './archive.ts'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ChatEntry } from './records.ts'

/**
 * Earlier tool results are cleared in steps of this share of the limit, so the same results
 * stay cleared while the history grows by that much and each request starts the same way.
 */
const STEP = 0.25

const sizes = new WeakMap<Message, number>()
function serializedBytes(message: Message): number {
  let size = sizes.get(message)
  if (size === undefined) {
    size = Buffer.byteLength(JSON.stringify(message))
    sizes.set(message, size)
  }
  return size
}
/** A JSON array costs its two brackets plus one comma between items. */
const framed = (message: Message): number => serializedBytes(message) + 1

/**
 * The entry with its tool result cleared, when that makes it smaller. The call and its
 * result id stay, so the history remains valid; the stored history keeps the result itself.
 */
function cleared(entry: ChatEntry): ChatEntry {
  if (entry.message.role !== 'tool') return entry
  const text = '[This tool result was cleared to fit the context window (' + serializedBytes(entry.message) + ' bytes). Call the tool again if you still need it.]'
  const stub = { ...entry, message: { ...entry.message, content: [{ type: 'text', text }] } as Message }
  return serializedBytes(stub.message) < serializedBytes(entry.message) ? stub : entry
}

/** Bytes `entries` take in a request once every tool result among them is cleared. */
export function clearedBytes(entries: readonly ChatEntry[]): number {
  let total = 0
  for (const entry of entries) total += framed(cleared(entry).message)
  return total
}

/**
 * Choose what of a history one model request carries. While the request is over the limit:
 * earlier turns lose their tool results, a whole turn at a time from the oldest, freeing the
 * overrun rounded up to a step; then the current reply loses its older tool results, never the
 * latest step's; then whole earlier turns leave from the oldest end, so a request still
 * opens on a user message. Reasoning and calls stay in every turn that is carried, because
 * thinking providers refuse a tool history without them.
 * @param entries - the history, oldest first; the last turn holds the current input.
 * @param system - system prompt counted against the limit.
 * @param prefix - messages that always accompany the history.
 * @param limit - bytes allowed for the system prompt plus the serialized message array.
 * @returns the carried suffix of `entries`, with cleared results in place; shorter than `entries` when turns left.
 * @throws PersonalChatError when the current turn is over the limit even with those results cleared.
 */
export function contextWindow(entries: readonly ChatEntry[], system: string, prefix: readonly Message[], limit: number): readonly ChatEntry[] {
  let total = Buffer.byteLength(system) + 1
  for (const message of prefix) total += framed(message)
  for (const entry of entries) total += framed(entry.message)
  if (total <= limit) return entries
  const window = [...entries]
  const clear = (index: number): number => {
    const stub = cleared(window[index]!)
    const freed = framed(window[index]!.message) - framed(stub.message)
    total -= freed
    window[index] = stub
    return freed
  }
  const current = Math.max(0, window.findLastIndex(entry => entry.message.role === 'user'))
  const step = Math.max(1, Math.floor(limit * STEP))
  const needed = Math.ceil((total - limit) / step) * step
  for (let index = 0, freed = 0; index < current && freed < needed;) {
    do freed += clear(index++); while (index < current && window[index]!.message.role !== 'user')
  }
  if (total <= limit) return window
  const latest = window.findLastIndex(entry => entry.message.role === 'assistant')
  for (let index = current; index < latest && total > limit; index++) clear(index)
  let start = 0
  while (total > limit && start < current) {
    do total -= framed(window[start++]!.message); while (start < current && window[start]!.message.role !== 'user')
  }
  if (total > limit) throw new PersonalChatError('context-limit', 'Current input and context exceed maxContextBytes; shorten the input or profile')
  return start ? window.slice(start) : window
}
