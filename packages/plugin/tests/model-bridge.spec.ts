import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ModelBridge } from '../src/host/model-bridge.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function endpoint(final: boolean, thought?: string) {
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (content: string | null, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] }) + '\n\n'
      if (thought) response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: { reasoning_content: thought }, finish_reason: null }] }) + '\n\n')
      response.write(chunk('Vision result', null))
      response.end(final ? chunk(null, 'stop') + 'data: [DONE]\n\n' : '')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test address')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.reflect.provide('credentials', { resolve: async (ref: string) => { expect(ref).toBe('TEST_INLINE_KEY'); return { value: 'fixture-not-a-real-key', source: 'test' } } })
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, bridge: new ModelBridge(ctx, { baseURL: 'http://127.0.0.1:' + address.port + '/v1', credentialRef: 'TEST_INLINE_KEY', models: ['vision-test'] }), requests }
}
describe('explicit inline image transport', () => {
  it('admits only configured inline routes', async () => {
    const { bridge } = await endpoint(true)
    expect(await bridge.available({ provider: 'personal-inline', model: 'vision-test', inline: true })).toBe(true)
    expect(await bridge.available({ provider: 'personal-inline', model: 'other', inline: true })).toBe(false)
    expect(await bridge.available({ provider: 'personal-inline', model: 'vision-test' })).toBe(false)
  })
  it('uses a credential reference and sends inline bytes without a host attachment store', async () => {
    const fixture = await endpoint(true)
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read this image' }] })
    const image = { mediaType: 'image/jpeg', base64: Buffer.from('SYNTHETIC_IMAGE_SENTINEL').toString('base64') }
    const output: StreamChunk[] = []
    for await (const chunk of fixture.bridge.stream({ provider: 'personal-inline', model: 'vision-test', inline: true }, { messages: [message] }, new Map([[message.id, [image]]]))) output.push(chunk)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]!.headers.authorization).toBe('Bearer fixture-not-a-real-key')
    expect(fixture.requests[0]!.headers['user-agent']).toContain('deepseek-harness/')
    expect(JSON.stringify(fixture.requests[0]!.body)).toContain('data:image/jpeg;base64,' + image.base64)
    expect(output.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('does not report a premature EOF as a completed answer', async () => {
    const fixture = await endpoint(false)
    const call = async () => { for await (const _ of fixture.bridge.stream({ provider: 'personal-inline', model: 'vision-test', inline: true }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Test' }] }] }, new Map())) {} }
    await expect(call()).rejects.toThrow('final status')
  })
})

/** A Harness route that serves the same model as the inline route, and one it does not. */
class HostRoutes extends LlmAdapter {
  providerInfo(provider: string) { return { id: provider, name: 'Gateway' } }
  async listModels(provider: string) { return [{ provider, id: 'vision-test', name: 'Vision Test' }, { provider, id: 'text-only', name: 'Text Only' }] }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, ...(model === 'vision-test' ? { reasoning: { efforts: [{ id: brandString<ReasoningEffortId>('off'), name: 'Off' }, { id: brandString<ReasoningEffortId>('high'), name: 'High' }] } } : {}) }
  }
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('Never routed by these tests') }
}
/** A Harness route whose every request fails with a rate limit. */
class LimitedRoute extends LlmAdapter {
  providerInfo(provider: string) { return { id: provider, name: 'Gateway' } }
  async listModels(provider: string) { return [{ provider, id: 'text-only', name: 'Text Only' }] }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'Slow down', status: 429 } } } }
}
describe('background requests', () => {
  it('names the failure code in the error and the log', async () => {
    const fixture = await endpoint(true)
    fixture.ctx.llm.registerAdapter(['gateway'], new LimitedRoute())
    const warn = vi.spyOn(fixture.ctx.logger, 'warn')
    await expect(fixture.bridge.complete({ provider: 'gateway', model: 'text-only' }, 'System', 'Input', 100, new AbortController().signal)).rejects.toThrow('Model request failed: RATE_LIMITED')
    expect(warn).toHaveBeenCalledWith('personal-chat: background model request to gateway/text-only failed: RATE_LIMITED (HTTP 429)')
  })
})
describe('inline route beside Harness routes', () => {
  it('lists a model the inline route serves once, under its Harness name and efforts', async () => {
    const fixture = await endpoint(true)
    fixture.ctx.llm.registerAdapter(['gateway'], new HostRoutes())
    expect(await fixture.bridge.models()).toEqual([
      { provider: 'personal-inline', model: 'vision-test', inline: true, name: 'Gateway · Vision Test', images: true, efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
      { provider: 'gateway', model: 'text-only', name: 'Gateway · Text Only', images: false },
    ])
    expect(await fixture.bridge.takesEffort({ provider: 'personal-inline', model: 'vision-test', inline: true, effort: 'high' })).toBe(true)
    expect(await fixture.bridge.takesEffort({ provider: 'personal-inline', model: 'vision-test', inline: true, effort: 'max' })).toBe(false)
    expect(await fixture.bridge.takesEffort({ provider: 'gateway', model: 'text-only', effort: 'high' })).toBe(false)
  })
  it('sends the effort in the endpoint spelling and streams the reasoning it returns', async () => {
    const fixture = await endpoint(true, 'Looking closely')
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Describe' }] })
    const output: StreamChunk[] = []
    for await (const chunk of fixture.bridge.stream({ provider: 'personal-inline', model: 'vision-test', inline: true, effort: 'off' }, { messages: [message] }, new Map())) output.push(chunk)
    for await (const _ of fixture.bridge.stream({ provider: 'personal-inline', model: 'vision-test', inline: true, effort: 'high' }, { messages: [message] }, new Map())) { /* drained */ }
    for await (const _ of fixture.bridge.stream({ provider: 'personal-inline', model: 'vision-test', inline: true }, { messages: [message] }, new Map())) { /* drained */ }
    expect(fixture.requests.map(request => request.body.reasoning_effort)).toEqual(['none', 'high', undefined])
    expect(output.slice(0, 2)).toEqual([{ type: 'reasoning-delta', index: 0, text: 'Looking closely' }, { type: 'text-delta', index: 1, text: 'Vision result' }])
  })
})
