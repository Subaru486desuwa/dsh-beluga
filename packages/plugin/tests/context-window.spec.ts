import { describe, expect, it, vi } from 'vitest'
import { contextWindow } from '../src/host/context-window.ts'
import type { ChatEntry } from '../src/host/records.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

let next = 0
function entry(role: 'user' | 'assistant', text: string): ChatEntry {
  const id = 'id-' + next++
  const message = role === 'user'
    ? { id, role, content: [{ type: 'text', text }], source: { kind: 'user' } }
    : { id, role, content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } }
  return { id, time: 1, attachmentIds: [], message: message as Message }
}
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
})
