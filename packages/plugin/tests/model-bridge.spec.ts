import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelBridge } from '../src/host/model-bridge.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function endpoint(final: boolean) {
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (content: string | null, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] }) + '\n\n'
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
  return { bridge: new ModelBridge(ctx, { baseURL: 'http://127.0.0.1:' + address.port + '/v1', credentialRef: 'TEST_INLINE_KEY', models: ['vision-test'] }), requests }
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
