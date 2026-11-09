import { describe, expect, it } from 'vitest'
import { CONDENSED_BYTES, condenseInput, condensePlan, condensedFor, keptCondensed, parseCondensed } from '../src/host/condense.ts'
import { clearedBytes } from '../src/host/context-window.ts'
import type { ChatEntry, Condensed } from '../src/host/records.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

let next = 0
function entry(message: object): ChatEntry {
  const id = 'id-' + next++
  return { id, time: 1, attachmentIds: [], message: { id, ...message } as unknown as Message }
}
const user = (text: string) => entry({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const answer = (text: string) => entry({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } })
const call = (name: string, args: object, thought = 'Considering it') => entry({ role: 'assistant', content: [{ type: 'reasoning', text: thought }, { type: 'tool-call', id: 'call-' + name, name, arguments: JSON.stringify(args) }], source: { kind: 'model', provider: 'p', model: 'm' } })
const result = (name: string, text: string) => entry({ role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'call-' + name }, toolCallId: 'call-' + name })
const chat = (turns: number, size = 1000) => Array.from({ length: turns }, (_, index) => [user('Turn ' + index + ' ' + 'x'.repeat(size)), answer('Reply ' + index)]).flat()
const condensed = (throughId: string, text: string): Condensed => ({ throughId, text, time: 1 })

describe('condensed history', () => {
  it('uses the newest condensed text whose last message is on the branch', () => {
    const list = [condensed('b', 'up to b'), condensed('d', 'up to d'), condensed('x', 'other branch')]
    expect(condensedFor(list, ['a', 'b', 'c', 'd', 'e'])).toEqual({ text: 'up to d', after: 4 })
    expect(condensedFor(list, ['a', 'b', 'c'])).toEqual({ text: 'up to b', after: 2 })
    expect(condensedFor(list, ['a'])).toBeUndefined()
    expect(condensedFor(undefined, ['a'])).toBeUndefined()
  })
  it('keeps for each branch only the newest condensed text it can use', () => {
    const [b, d, x] = [condensed('b', 'up to b'), condensed('d', 'up to d'), condensed('x', 'gone')]
    expect(keptCondensed([b, d, x], [{ messageIds: ['a', 'b', 'c', 'd', 'e'] }, { messageIds: ['a', 'b', 'f'] }])).toEqual([b, d])
    expect(keptCondensed([b, d, x], [{ messageIds: ['a', 'b', 'c', 'd'] }])).toEqual([d])
  })
  it('condenses whole turns, keeping the newest that fit a quarter of the budget', () => {
    const history = chat(8)
    const plan = condensePlan(history, 16000)
    expect(plan.fold).toBeGreaterThan(0)
    expect(history[plan.fold]!.message.role).toBe('user')
    expect(clearedBytes(history.slice(plan.fold))).toBeLessThanOrEqual(16000 / 4)
    expect(clearedBytes(history.slice(plan.fold - 2))).toBeGreaterThan(16000 / 4)
    expect(plan.transcript).toContain('User: Turn 0 ')
    expect(plan.transcript).not.toContain('Turn ' + (history.length / 2 - 1) + ' ')
  })
  it('keeps at least the newest turn, and condenses nothing in a chat of one turn', () => {
    expect(condensePlan(chat(1), 100).fold).toBe(0)
    const history = [...chat(2), user('Turn big ' + 'y'.repeat(8000)), answer('Done')]
    expect(condensePlan(history, 16000).fold).toBe(4)
  })
  it('reads the words, calls and clipped results of a turn, never its reasoning', () => {
    const history = [user('Plan the trip'), call('web_search', { query: 'Kyoto in spring' }, 'PRIVATE THOUGHT'), result('web_search', 'R'.repeat(6000)), answer('Here is the plan'), user('Thanks')]
    const plan = condensePlan(history, 100000)
    expect(plan.fold).toBe(4)
    expect(plan.transcript).toContain('User: Plan the trip')
    expect(plan.transcript).toContain('web_search')
    expect(plan.transcript).toContain('Kyoto in spring')
    expect(plan.transcript).toContain('Assistant: Here is the plan')
    expect(plan.transcript).not.toContain('PRIVATE THOUGHT')
    expect(plan.transcript).toContain('R'.repeat(1000))
    expect(plan.transcript).not.toContain('R'.repeat(3000))
  })
  it('reads at most half the budget at once and leaves the newer turns for the next pass', () => {
    const history = chat(12)
    const plan = condensePlan(history, 6000)
    expect(Buffer.byteLength(plan.transcript)).toBeLessThanOrEqual(3000)
    expect(plan.fold).toBeGreaterThan(0)
    expect(history[plan.fold]!.message.role).toBe('user')
    expect(clearedBytes(history.slice(plan.fold))).toBeGreaterThan(6000 / 4)
  })
  it('gives the model the condensed text so far with the part to fold into it', () => {
    const input = condenseInput('Earlier facts', 'User: more')
    expect(input).toContain('<condensed_so_far>\nEarlier facts\n</condensed_so_far>')
    expect(input).toContain('<transcript>\nUser: more\n</transcript>')
    expect(condenseInput(undefined, 'User: first')).toContain('(nothing yet)')
  })
  it('takes the condensed text from its tags and bounds it', () => {
    expect(parseCondensed('Sure.\n<condensed>\nAll of it\n</condensed>')).toBe('All of it')
    expect(parseCondensed('No tags at all')).toBeUndefined()
    expect(parseCondensed('<condensed>\n  \n</condensed>')).toBeUndefined()
    expect(Buffer.byteLength(parseCondensed('<condensed>\n' + '## Part\n' + '甲'.repeat(20000) + '\n</condensed>')!)).toBeLessThanOrEqual(CONDENSED_BYTES)
  })
})
