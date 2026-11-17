/**
 * Memory Access: what a Turn may read from and write to Personal Memory, and whether it may
 * search earlier chats. This file only answers; the callers read Custom Instructions, Saved
 * Memories, the Memory Summary and earlier chats themselves, after asking here.
 */
import { PersonalChatError } from './archive.ts'

/** The three things Memory Access depends on, as they stand for the chat and the reply asked about. */
export interface MemoryFacts {
  /** The chat is a Temporary Chat. */
  readonly temporary: boolean
  /** The person's switch for referencing earlier chats, which also keeps the Memory Summary. */
  readonly referenceChats: boolean
  /** The reply, or the assistant text asked about, came after Work sessions were read. */
  readonly readWork: boolean
}
/** Why an answer is no. */
export type Refusal = 'temporary' | 'chats-off' | 'after-work'
/** Whether one use is allowed, and if not, the first reason that refuses it. */
export type Answer = 'allowed' | Refusal

const CAPABILITIES = ['customInstructions', 'memorySummary', 'savedMemories', 'proposeMemory', 'searchChats', 'feedSummary', 'settings'] as const
type Capability = typeof CAPABILITIES[number]
/**
 * One answer for each use:
 * - `customInstructions`, `memorySummary`: the model request carries them.
 * - `savedMemories`: Saved Memories come with the request, and `memory_recall` returns them.
 * - `proposeMemory`: `memory_propose` may add a candidate.
 * - `searchChats`: `search_chats` may read earlier chats.
 * - `feedSummary`: the text is read into the Memory Summary.
 * - `settings`: the person may see and change Personal Memory while this chat is open.
 */
export type MemoryAccess = Readonly<Record<Capability, Answer>>

/** What each reason refuses. A use is allowed only when no reason that holds refuses it. */
const REFUSES: Readonly<Record<Refusal, readonly Capability[]>> = {
  temporary: CAPABILITIES,
  'chats-off': ['memorySummary', 'searchChats', 'feedSummary'],
  // Nothing learns from Work (ADR 0006).
  'after-work': ['proposeMemory', 'feedSummary'],
}

/**
 * @param facts - what holds for the chat, the person's switch and the reply.
 * @returns each use's answer; a refused use names the first reason, in the order temporary, chats-off, after-work.
 */
export function memoryAccess(facts: MemoryFacts): MemoryAccess {
  const holding: Refusal[] = []
  if (facts.temporary) holding.push('temporary')
  if (!facts.referenceChats) holding.push('chats-off')
  if (facts.readWork) holding.push('after-work')
  const answer = (capability: Capability): Answer => holding.find(reason => REFUSES[reason].includes(capability)) ?? 'allowed'
  return { customInstructions: answer('customInstructions'), memorySummary: answer('memorySummary'), savedMemories: answer('savedMemories'), proposeMemory: answer('proposeMemory'), searchChats: answer('searchChats'), feedSummary: answer('feedSummary'), settings: answer('settings') }
}

/** The uses the model reaches through a tool: `memory_recall`, `memory_propose` and `search_chats`. */
type ToolUse = 'savedMemories' | 'proposeMemory' | 'searchChats'

/**
 * @param access - Memory Access for the reply.
 * @param use - the use a tool stands for.
 * @returns whether the model request lists that tool. A tool refused only after Work stays listed: the tool list does not change within a reply, and the refusal tells the model why.
 */
export function listed(access: MemoryAccess, use: ToolUse): boolean { return access[use] === 'allowed' || access[use] === 'after-work' }

/**
 * Throws the refusal the model or the person is shown, and returns when the use is allowed.
 * @param access - Memory Access for the reply, or for the chat open beside the Settings page.
 * @param use - the tool's use, or `settings`.
 */
export function permit(access: MemoryAccess, use: ToolUse | 'settings'): void {
  switch (access[use]) {
    case 'allowed': return
    case 'temporary': throw new PersonalChatError('memory-forbidden', 'Temporary Chat cannot read or write long-term memory')
    case 'chats-off': throw new PersonalChatError('tool-forbidden', 'Searching earlier chats is turned off')
    case 'after-work': throw new PersonalChatError('memory-after-work', 'Nothing is saved to memory in a reply that read Work sessions. If the user wants something remembered, ask them to say it again in a new message.')
  }
}
