import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { lookupRefusal, MEMORY_LOOKUP, memoryLookup, memoryLookupTool, offerMemoryLookup } from '../src/host/work-memory.ts'
import type { Memory, MemoryId } from '../src/shared/types.ts'

const memory = (text: string, index: number): Memory => ({ id: brandString<MemoryId>('m' + index), revision: 1, text, category: 'preference', scope: 'personal', source: { kind: 'manual' }, createdAt: index, updatedAt: index, state: 'active' })
const agent = (origin?: 'subagent') => ({ session: { header: origin ? { origin } : {} } })
const execution = (fields: Partial<Record<'name' | 'agent' | 'parent', unknown>>) => ({ name: MEMORY_LOOKUP, ...fields }) as unknown as ToolExecution

describe('Memory Lookup for Work', () => {
  it('gives the newest memories that fit beside the summary, and says how many it left out', () => {
    const memories = Array.from({ length: 40 }, (_, index) => memory('Preference number ' + index + ' '.padEnd(40, 'x'), index))
    const result = memoryLookup(memories, 'S'.repeat(5000), 2048)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048)
    expect(result.summary).toHaveLength(1024)
    expect(result.memories[0]!.text).toContain('number 39')
    expect(result.omitted).toBe(40 - result.memories.length)
    expect(memoryLookup([memory('Short', 1)], '', 2048)).toEqual({ memories: [{ text: 'Short', category: 'preference' }], summary: '' })
    expect(memoryLookup([], '记'.repeat(1000), 1024).summary).toHaveLength(170)
  })
  it('answers only the main agent of a Work session calling it directly', () => {
    const root = agent()
    const agents = { roots: () => [root] } as never
    expect(lookupRefusal(execution({ agent: root }), agents)).toBeUndefined()
    expect(lookupRefusal(execution({ name: 'bash', agent: agent() }), agents)).toBeUndefined()
    expect(lookupRefusal(execution({ agent: root, parent: {} }), agents)).toMatch(/not from code/u)
    expect(lookupRefusal(execution({}), agents)).toMatch(/main agent/u)
    expect(lookupRefusal(execution({ agent: agent() }), agents)).toMatch(/main agent/u)
    const resumed = agent('subagent')
    expect(lookupRefusal(execution({ agent: resumed }), { roots: () => [resumed] } as never)).toMatch(/main agent/u)
  })
  it('reads memories and the summary at each call, never anything else', async () => {
    const saved = vi.fn((query: string) => query ? [memory('Prefers tabs', 1)] : [memory('Prefers tabs', 1), memory('Lives in Shanghai', 2)])
    const tool = memoryLookupTool({ saved, summary: () => 'You write TypeScript.' }, 24000)
    expect(tool.name).toBe(MEMORY_LOOKUP)
    expect(await tool.execute({}, {} as never)).toEqual({ memories: [{ text: 'Lives in Shanghai', category: 'preference' }, { text: 'Prefers tabs', category: 'preference' }], summary: 'You write TypeScript.' })
    expect(await tool.execute({ query: 'tabs' }, {} as never)).toEqual({ memories: [{ text: 'Prefers tabs', category: 'preference' }], summary: 'You write TypeScript.' })
    expect(saved.mock.calls).toEqual([[''], ['tabs']])
    await expect(tool.execute({ query: 'x', path: '/etc' }, {} as never)).rejects.toThrow()
    expect(tool.output.render({}, { memories: [], summary: '' })).toEqual([{ type: 'text', text: '{"memories":[],"summary":""}' }])
  })
  it('is registered exactly while the setting is on, and removed with its scope', async () => {
    const registered = new Map<string, ToolDefinition>()
    const guards = new Set<unknown>()
    const tools = { register: vi.fn((definition: ToolDefinition) => { registered.set(definition.name, definition); return () => { registered.delete(definition.name) } }), guard: vi.fn((guard: unknown) => { guards.add(guard); return () => { guards.delete(guard) } }) }
    const ctx = new Context()
    ctx.provide('tools', tools as never)
    ctx.provide('agents', { roots: () => [] } as never)
    let on = false
    const listeners = new Set<() => void>()
    const fiber = ctx.inject(['tools', 'agents'], scope => { offerMemoryLookup(scope, { saved: () => [], summary: () => '' }, 24000, () => on, listener => { listeners.add(listener); return () => { listeners.delete(listener) } }) })
    await fiber
    expect(registered.size).toBe(0)
    on = true
    for (const listener of listeners) listener()
    expect([...registered.keys()]).toEqual([MEMORY_LOOKUP])
    expect(guards.size).toBe(1)
    for (const listener of listeners) listener()
    expect(tools.register).toHaveBeenCalledOnce()
    on = false
    for (const listener of listeners) listener()
    await vi.waitFor(() => { expect(registered.size).toBe(0) })
    expect(guards.size).toBe(0)
    on = true
    for (const listener of listeners) listener()
    expect(registered.size).toBe(1)
    await fiber.dispose()
    expect(registered.size).toBe(0)
    expect(guards.size).toBe(0)
    expect(listeners.size).toBe(0)
  })
})
