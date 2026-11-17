import { describe, expect, it } from 'vitest'
import { listed, memoryAccess, permit, type Answer, type MemoryFacts } from '../src/host/memory-access.ts'

const USES = ['customInstructions', 'memorySummary', 'savedMemories', 'proposeMemory', 'searchChats', 'feedSummary', 'settings'] as const
const yes = 'allowed', temp = 'temporary', off = 'chats-off', work = 'after-work'
const normal: MemoryFacts = { temporary: false, referenceChats: true, readWork: false }
const temporary: MemoryFacts = { ...normal, temporary: true }
const switchedOff: MemoryFacts = { ...normal, referenceChats: false }
const afterWork: MemoryFacts = { ...normal, readWork: true }
/** One row for each combination of what can hold; the answers follow the order of USES. */
const TABLE: readonly (readonly [string, MemoryFacts, readonly Answer[]])[] = [
  ['a normal chat', normal, [yes, yes, yes, yes, yes, yes, yes]],
  ['a Temporary Chat', temporary, [temp, temp, temp, temp, temp, temp, temp]],
  ['a chat with referencing earlier chats turned off', switchedOff, [yes, off, yes, yes, off, off, yes]],
  ['a reply that read Work', afterWork, [yes, yes, yes, work, yes, work, yes]],
  ['a reply that read Work, with referencing earlier chats turned off', { ...switchedOff, readWork: true }, [yes, off, yes, work, off, off, yes]],
  ['a Temporary Chat with referencing earlier chats turned off', { ...temporary, referenceChats: false }, [temp, temp, temp, temp, temp, temp, temp]],
  ['a Temporary Chat whose reply read Work', { ...temporary, readWork: true }, [temp, temp, temp, temp, temp, temp, temp]],
  ['a Temporary Chat whose reply read Work, with referencing earlier chats turned off', { temporary: true, referenceChats: false, readWork: true }, [temp, temp, temp, temp, temp, temp, temp]],
]

describe('memory access', () => {
  it.each(TABLE)('answers every use for %s', (_situation, facts, answers) => {
    expect(memoryAccess(facts)).toEqual(Object.fromEntries(USES.map((use, index) => [use, answers[index]])))
  })

  it('lists the memory tools and chat search to the model unless the chat or the switch refuses them', () => {
    const tools = (facts: MemoryFacts) => [listed(memoryAccess(facts), 'proposeMemory'), listed(memoryAccess(facts), 'savedMemories'), listed(memoryAccess(facts), 'searchChats')]
    expect(tools(normal)).toEqual([true, true, true])
    expect(tools(temporary)).toEqual([false, false, false])
    expect(tools(switchedOff)).toEqual([true, true, false])
  })

  it('still lists proposing a memory after the reply read Work, so the refusal can say why', () => {
    expect(listed(memoryAccess(afterWork), 'proposeMemory')).toBe(true)
  })

  it('lets an allowed use through', () => {
    for (const use of ['savedMemories', 'proposeMemory', 'searchChats', 'settings'] as const) expect(() => permit(memoryAccess(normal), use)).not.toThrow()
  })

  it('refuses a Temporary Chat every use with the same reason', () => {
    for (const use of ['savedMemories', 'proposeMemory', 'searchChats', 'settings'] as const) expect(() => permit(memoryAccess(temporary), use)).toThrow(expect.objectContaining({ reason: 'memory-forbidden', message: 'Temporary Chat cannot read or write long-term memory' }))
  })

  it('tells the model why chat search and proposing a memory are refused', () => {
    expect(() => permit(memoryAccess(switchedOff), 'searchChats')).toThrow(expect.objectContaining({ reason: 'tool-forbidden', message: 'Searching earlier chats is turned off' }))
    expect(() => permit(memoryAccess(afterWork), 'proposeMemory')).toThrow(expect.objectContaining({ reason: 'memory-after-work', message: 'Nothing is saved to memory in a reply that read Work sessions. If the user wants something remembered, ask them to say it again in a new message.' }))
  })
})
