import { describe, expect, it, vi } from 'vitest'
import { clearedBytes, contextWindow } from '../src/host/context-window.ts'
import type { ChatEntry } from '../src/host/records.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

let next = 0
function result(text: string): ChatEntry {
  const id = 'id-' + next++
  return { id, time: 1, attachmentIds: [], message: { id, role: 'tool', callId: 'call-' + id, isError: false, content: [{ type: 'text', text }] } as unknown as Message }
}
function entry(role: 'user' | 'assistant', text: string): ChatEntry {
  const id = 'id-' + next++
  const message = role === 'user'
    ? { id, role, content: [{ type: 'text', text }], source: { kind: 'user' } }
    : { id, role, content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } }
  return { id, time: 1, attachmentIds: [], message: message as Message }
}
/** A model step that thinks, then calls a tool. */
function call(name: string): ChatEntry {
  const id = 'id-' + next++
  const message = { id, role: 'assistant', content: [{ type: 'reasoning', text: 'Thinking about ' + name }, { type: 'tool-call', id: 'call-' + id, name, arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } }
  return { id, time: 1, attachmentIds: [], message: message as unknown as Message }
}
/** One finished turn whose single tool result is `size` copies of `fill`. */
const turn = (fill: string, size = 4000): ChatEntry[] => [entry('user', 'ask ' + fill), call('lookup'), result(fill.repeat(size)), entry('assistant', 'found ' + fill)]
const text = (item: ChatEntry) => JSON.stringify(item.message.content)
const requestBytes = (system: string, prefix: readonly Message[], entries: readonly ChatEntry[]) =>
  Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify([...prefix, ...entries.map(item => item.message)]))

describe('context window', () => {
  it('keeps everything at the exact byte limit and trims one byte below it', () => {
    const prefix = [entry('user', 'context').message]
    const entries = [entry('user', 'first 你好'), entry('assistant', 'reply'), entry('user', 'second')]
    const limit = requestBytes('system', prefix, entries)
    expect(contextWindow(entries, 'system', prefix, limit)).toEqual(entries)
    expect(contextWindow(entries, 'system', prefix, limit - 1)).toEqual(entries.slice(2))
  })
  it('drops whole turns from the oldest so no reply loses its question', () => {
    const entries = [entry('user', 'a'.repeat(100)), entry('assistant', 'b'.repeat(100)), entry('assistant', 'c'.repeat(100)), entry('user', 'd'), entry('assistant', 'e')]
    const window = contextWindow(entries, '', [], requestBytes('', [], entries.slice(3)))
    expect(window).toEqual(entries.slice(3))
    expect(requestBytes('', [], window)).toBeLessThanOrEqual(requestBytes('', [], entries.slice(3)))
  })
  it('fails when the newest turn alone is over the limit', () => {
    const entries = [entry('user', 'old'), entry('user', 'x'.repeat(1000))]
    expect(() => contextWindow(entries, '', [], 200)).toThrow('maxContextBytes')
  })
  it('serializes each message only once, however many turns it drops', () => {
    const entries = Array.from({ length: 2000 }, (_, index) => entry(index % 2 ? 'assistant' : 'user', 'x'.repeat(50)))
    const stringify = vi.spyOn(JSON, 'stringify')
    const window = contextWindow(entries, '', [], 1000)
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(window.length).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(entries.length)
  })
  it('clears the oldest tool results of the newest turn, keeping the latest step, before failing', () => {
    const entries = [entry('user', 'question'), entry('assistant', 'call one'), result('A'.repeat(400)), entry('assistant', 'call two'), result('B'.repeat(400)), entry('assistant', 'call three'), result('C'.repeat(400))]
    const limit = requestBytes('', [], entries) - 200
    const window = contextWindow(entries, '', [], limit)
    expect(window).toHaveLength(entries.length)
    expect(requestBytes('', [], window)).toBeLessThanOrEqual(limit)
    expect(text(window[2]!)).toContain('cleared to fit')
    expect(text(window[4]!)).toContain('B'.repeat(400))
    expect(text(window[6]!)).toContain('C'.repeat(400))
    expect(window[2]!.message).toMatchObject({ role: 'tool', callId: (entries[2]!.message as { callId: string }).callId })
    expect(text(entries[2]!)).toContain('A'.repeat(400))
  })
  it('still fails when the newest turn does not fit with its latest results', () => {
    const entries = [entry('user', 'question'), entry('assistant', 'call'), result('Z'.repeat(1000))]
    expect(() => contextWindow(entries, '', [], 600)).toThrow('maxContextBytes')
  })
  it('clears the tool results of earlier turns a whole turn at a time, oldest first, freeing at least a quarter of the limit', () => {
    const entries = [...turn('A', 1000), ...turn('B', 1000), ...turn('C', 1000), entry('user', 'now')]
    const limit = requestBytes('', [], entries) - 100
    const window = contextWindow(entries, '', [], limit)
    expect(window).toHaveLength(entries.length)
    expect(text(window[2]!)).toContain('cleared to fit')
    expect(text(window[6]!)).toContain('cleared to fit')
    expect(text(window[10]!)).toContain('C'.repeat(1000))
    expect(requestBytes('', [], entries) - requestBytes('', [], window)).toBeGreaterThanOrEqual(limit / 4)
  })
  it('keeps the reasoning and calls of a turn whose results it clears, as thinking providers require', () => {
    const entries = [...turn('A'), entry('user', 'now')]
    const window = contextWindow(entries, '', [], requestBytes('', [], entries) - 100)
    expect(window[1]).toBe(entries[1])
    expect(text(window[1]!)).toContain('Thinking about lookup')
    expect(window[2]!.message).toMatchObject({ role: 'tool', callId: (entries[2]!.message as { callId: string }).callId })
  })
  it('clears the older results of the current reply before any earlier turn leaves', () => {
    const entries = [entry('user', 'earlier'), entry('assistant', 'answer'), entry('user', 'now'), call('one'), result('X'.repeat(4000)), call('two'), result('Y'.repeat(400))]
    const window = contextWindow(entries, '', [], requestBytes('', [], entries) - 1000)
    expect(window).toHaveLength(entries.length)
    expect(window[0]).toBe(entries[0])
    expect(text(window[4]!)).toContain('cleared to fit')
    expect(text(window[6]!)).toContain('Y'.repeat(400))
  })
  it('clears the same earlier results as the reply grows, so each request starts the same way', () => {
    const entries = [...turn('A'), ...turn('B'), ...turn('C'), entry('user', 'now')]
    const limit = requestBytes('', [], entries) - 100
    const first = contextWindow(entries, '', [], limit)
    const second = contextWindow([...entries, call('more'), result('D'.repeat(200))], '', [], limit)
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first))
  })
  it('measures a history as a request would carry it once its results are cleared', () => {
    const entries = [...turn('A'), entry('user', 'now')]
    const window = contextWindow(entries, '', [], requestBytes('', [], entries) - 100)
    expect(clearedBytes(entries)).toBe(requestBytes('', [], window) - 1)
  })
})
