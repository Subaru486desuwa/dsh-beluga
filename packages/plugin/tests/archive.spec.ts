import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { archiveSnapshot, branchNodes, canonical, parseExport } from '../src/host/archive.ts'
import type { ArchiveRevisionId } from '../src/shared/types.ts'
const limits = { maxUploadBytes: 100000, maxArchiveBytes: 100000, maxConversations: 10, maxNodes: 100, maxZipEntries: 10 }
import { fixture } from './fixtures/chatgpt.ts'
describe('synthetic ChatGPT mapping import', () => {
  it('preserves source data and follows current_node parents rather than timestamps', () => {
    const parsed = parseExport(strToU8(JSON.stringify(fixture)), 'conversations.json', limits)[0]!
    expect(parsed.original).toEqual(fixture[0])
    expect(branchNodes(parsed, parsed.currentNode).map(n => n.id)).toEqual(['root', 'b'])
    expect(branchNodes(parsed, 'a')[1]!.text).toBe('OTHER_BRANCH')
    const snapshot = archiveSnapshot(parsed, 'revision' as ArchiveRevisionId, 'b', 1000)
    expect(snapshot.text).toContain('SELECTED_BRANCH')
    expect(snapshot.text).not.toContain('OTHER_BRANCH')
    expect(snapshot.text).toContain('not current authority')
    expect(snapshot.bytes).toBeLessThanOrEqual(1000)
  })
  it('reads ZIP without extracting media or paths', () => {
    const zip = zipSync({ 'conversations.json': strToU8(JSON.stringify(fixture)), 'media.png': new Uint8Array(10) })
    expect(parseExport(zip, 'export.zip', limits)[0]!.original).toEqual(fixture[0])
    expect(() => parseExport(zip, 'export.zip', { ...limits, maxArchiveBytes: 10 })).toThrow('maxArchiveBytes')
    expect(() => parseExport(zipSync({ '../conversations.json': strToU8('[]') }), 'bad.zip', limits)).toThrow('Unsafe ZIP')
  })
  it('rejects broken graphs and unknown containers instead of guessing', () => {
    const broken = structuredClone(fixture)
    broken[0]!.current_node = 'missing'
    expect(() => parseExport(strToU8(JSON.stringify(broken)), 'x.json', limits)).toThrow('current_node')
    expect(() => parseExport(strToU8('{}'), 'x.json', limits)).toThrow('array')
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
  it('rejects cyclic mappings and duplicate archive members', () => {
    const cycle = structuredClone(fixture)
    Object.assign(cycle[0]!.mapping.root, { parent: 'a' })
    Object.assign(cycle[0]!.mapping.a, { children: ['root'] })
    expect(() => parseExport(strToU8(JSON.stringify(cycle)), 'cycle.json', limits)).toThrow('cycle')
    const zip = zipSync({ 'conversations.json': strToU8(JSON.stringify(fixture)), 'nested/conversations.json': strToU8(JSON.stringify(fixture)) })
    expect(() => parseExport(zip, 'multiple.zip', limits)).toThrow('multiple conversations.json')
  })

})
