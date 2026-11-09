import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { archiveSnapshot, branchNodes, canonical, parseExport } from '../src/host/archive.ts'
import type { ArchiveRevisionId } from '../src/shared/types.ts'
const limits = { maxUploadBytes: 100000, maxArchiveBytes: 100000, maxConversations: 10, maxNodes: 100, maxZipEntries: 10 }
import { currentExport, fixture } from './fixtures/chatgpt.ts'
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

describe('official exports split into shards, with edges only on parent', () => {
  const json = (value: unknown) => strToU8(JSON.stringify(value))
  const shard = (id: string) => json([{ ...currentExport[0]!, id }])
  it('derives children from parent and keeps the source object as exported', () => {
    const parsed = parseExport(json(currentExport), 'conversations-000.json', limits)[0]!
    expect(parsed.original).toEqual(currentExport[0])
    expect(parsed.nodes.find(node => node.id === 'question')!.children).toEqual(['thought', 'retry'])
    expect(parsed.nodes.filter(node => !node.children.length).map(node => node.id)).toEqual(['answer', 'retry'])
    expect(branchNodes(parsed, 'retry').map(node => node.id)).toEqual(['root', 'question', 'retry'])
  })
  it('still refuses dangling parents, cycles and partly declared children', () => {
    const dangling = structuredClone(currentExport)
    dangling[0]!.mapping.answer.parent = 'missing'
    expect(() => parseExport(json(dangling), 'x.json', limits)).toThrow('missing or inconsistent parent')
    const cycle = structuredClone(currentExport)
    Object.assign(cycle[0]!.mapping.root, { parent: 'answer' })
    expect(() => parseExport(json(cycle), 'x.json', limits)).toThrow('cycle')
    const partial = structuredClone(currentExport)
    Object.assign(partial[0]!.mapping.answer, { children: [] })
    expect(() => parseExport(json(partial), 'x.json', limits)).toThrow('invalid children')
  })
  it('merges numbered shards in order wherever the ZIP lists them', () => {
    const zip = zipSync({ 'conversations-001.json': shard('second'), 'file-media.dat': new Uint8Array(10), 'conversations-000.json': shard('first') })
    expect(parseExport(zip, 'export.zip', limits).map(archive => archive.sourceId)).toEqual(['first', 'second'])
    expect(parseExport(zipSync({ 'conversations-000.json': strToU8('[]'), 'conversations-001.json': shard('only') }), 'export.zip', limits).map(archive => archive.sourceId)).toEqual(['only'])
  })
  it('refuses a member set that could hide conversations', () => {
    const parse = (files: Record<string, Uint8Array>) => () => parseExport(zipSync(files), 'export.zip', limits)
    expect(parse({ 'conversations-000.json': shard('a'), 'conversations-002.json': shard('c') })).toThrow('missing conversations-001.json')
    expect(parse({ 'conversations-001.json': shard('b') })).toThrow('missing conversations-000.json')
    expect(parse({ 'a/conversations-000.json': shard('a'), 'b/conversations-000.json': shard('b') })).toThrow('multiple conversations-000.json')
    expect(parse({ 'conversations.json': shard('a'), 'conversations-000.json': shard('b') })).toThrow('both conversations.json and numbered shards')
    expect(parse({ 'conversations-000.json': shard('same'), 'conversations-001.json': shard('same') })).toThrow('Duplicate conversation id')
    expect(parse({ 'conversations-000.json': strToU8('{}') })).toThrow('array')
    expect(parse({ 'conversations-000.json': strToU8('[]') })).toThrow('non-empty')
    expect(parse({ 'file-media.dat': new Uint8Array(10) })).toThrow('requires conversations.json or conversations-NNN.json')
  })
  it('bounds extracted JSON across every shard together', () => {
    const zip = zipSync({ 'conversations-000.json': shard('a'), 'conversations-001.json': shard('b') })
    expect(() => parseExport(zip, 'export.zip', { ...limits, maxArchiveBytes: shard('a').length + 10 })).toThrow('maxArchiveBytes')
  })
  it('treats reasoning as working material, not messages or missing media', () => {
    const parsed = parseExport(json(currentExport), 'conversations-000.json', limits)[0]!
    expect(parsed.nodes.filter(node => node.reasoning).map(node => node.id)).toEqual(['thought', 'recap'])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain('question')
    const snapshot = archiveSnapshot(parsed, 'revision' as ArchiveRevisionId, 'answer', 2000)
    expect(JSON.parse(snapshot.text.slice(snapshot.text.indexOf('{'))).nodes.map((node: { id: string }) => node.id)).toEqual(['question', 'answer'])
    expect(snapshot).toMatchObject({ includedNodes: 2, omittedNodes: 0 })
    expect(archiveSnapshot(parsed, 'revision' as ArchiveRevisionId, 'answer', snapshot.bytes - 1)).toMatchObject({ includedNodes: 1, omittedNodes: 1 })
  })
  it('reads a voice message from its transcription, which also reaches the model', () => {
    const voice = (role: string, text: string, parent: string) => ({ id: role, parent, message: { author: { role }, create_time: 1, content: { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription', text, direction: 'in', decoding_id: null }] } } })
    const mapping = { root: { id: 'root', parent: null, message: null }, user: voice('user', 'SPOKEN_QUESTION', 'root'), assistant: voice('assistant', 'SPOKEN_ANSWER', 'user') }
    const parsed = parseExport(json([{ id: 'voice', title: 'Voice', current_node: 'assistant', mapping }]), 'conversations-000.json', limits)[0]!
    expect(parsed.nodes.filter(node => !node.structural).map(node => node.text)).toEqual(['SPOKEN_QUESTION', 'SPOKEN_ANSWER'])
    expect(parsed.warnings).toEqual([])
    expect(archiveSnapshot(parsed, 'revision' as ArchiveRevisionId, 'assistant', 2000).text).toContain('SPOKEN_ANSWER')
  })
  it('still flags media that sits next to a transcription', () => {
    const mapping = { root: { id: 'root', parent: null, message: null }, user: { id: 'user', parent: 'root', message: { author: { role: 'user' }, create_time: 1, content: { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription', text: 'SPOKEN' }, { content_type: 'audio_asset_pointer' }] } } } }
    const parsed = parseExport(json([{ id: 'voice', title: 'Voice', current_node: 'user', mapping }]), 'conversations-000.json', limits)[0]!
    expect(parsed.nodes.at(-1)!.text).toBe('SPOKEN')
    expect(parsed.warnings).toHaveLength(1)
  })
})
