/** Reuse configured Harness text routes; an explicit inline route never stores images. */
import OpenAI from 'openai'
import type { Context } from '@deepseek-ai/cordis'
import { attributionHeaders, type GenerateOptions, type RequestMessage, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { InlineProvider, ModelChoice, ModelRef } from '../shared/models.ts'
import { PersonalChatError } from './archive.ts'

const INLINE_PROVIDER = 'personal-inline'
export interface InlineImage { readonly mediaType: string; readonly base64: string }
export class ModelBridge {
  constructor(private readonly ctx: Context, private readonly inline?: InlineProvider) {
    this.inline = inline ? { ...inline, models: [...inline.models] } : undefined
    if (this.inline) {
      Object.freeze(this.inline.models); Object.freeze(this.inline)
      const url = new URL(this.inline.baseURL)
      if (url.username || url.password || (!['https:'].includes(url.protocol) && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new PersonalChatError('invalid-config', 'Inline endpoint requires HTTPS or an explicit loopback test endpoint, without URL credentials')
      credentialRef(this.inline.credentialRef)
    }
  }
  /** List every usable route; a provider whose catalog fails is skipped, not fatal. */
  async models(): Promise<readonly ModelChoice[]> {
    const providers = [...this.ctx.llm.listProviders()]
    const catalogs = await Promise.allSettled(providers.map(async provider => this.ctx.llm.listModels(provider.id)))
    const choices: ModelChoice[] = []
    for (const [index, provider] of providers.entries()) {
      const catalog = catalogs[index]!
      if (catalog.status === 'rejected') { this.catalogFailed(provider.id, catalog.reason); continue }
      for (const model of catalog.value) choices.push({ provider: provider.id, model: model.id, name: provider.name + ' · ' + model.name, images: false, ...(model.inputModalities?.includes('image') ? { imageNote: 'Configure the plugin inline image route to avoid the host attachment store.' } : {}) })
    }
    if (this.inline) for (const model of this.inline.models) choices.push({ provider: INLINE_PROVIDER, model, inline: true, name: model + ' · Inline images', images: true })
    return choices
  }
  /** Check one route against its own catalog, so an unrelated broken provider cannot block it. */
  async available(model: ModelRef): Promise<boolean> {
    if (model.inline) return model.provider === INLINE_PROVIDER && this.inline?.models.includes(model.model) === true
    try { return (await this.ctx.llm.listModels(model.provider)).some(choice => choice.id === model.model) }
    catch (error) { this.catalogFailed(model.provider, error); return false }
  }
  private catalogFailed(provider: string, reason: unknown): void {
    this.ctx.logger.warn('personal-chat: model catalog failed for provider ' + provider)
    this.ctx.logger.warn(reason)
  }
  /** Stream one admitted route; admission owns the availability check. */
  async *stream(model: ModelRef, options: Omit<GenerateOptions, 'provider' | 'model' | 'sessionId'>, images: ReadonlyMap<string, readonly InlineImage[]>): AsyncIterable<StreamChunk> {
    if (!model.inline) {
      if (images.size) throw new PersonalChatError('image-route-required', 'This conversation contains images. Select the configured inline image route.')
      yield* this.ctx.llm.stream({ ...options, provider: model.provider, model: model.model })
      return
    }
    const configuration = this.inline
    if (!configuration) throw new PersonalChatError('image-route-required', 'Inline image route is not configured')
    const credentials = this.ctx.get('credentials')
    const resolved = await credentials?.resolve(credentialRef(configuration.credentialRef))
    if (!resolved) throw new PersonalChatError('missing-credential', 'Configure the named credential reference in Harness settings')
    const client = new OpenAI({ apiKey: resolved.value, baseURL: configuration.baseURL, defaultHeaders: attributionHeaders(), maxRetries: 0, logLevel: 'off' })
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
    if (options.system) messages.push({ role: 'system', content: options.system })
    for (const message of options.messages) messages.push(convertMessage(message, images))
    const stream = await client.chat.completions.create({
      model: model.model, messages, stream: true,
      ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    }, { signal: options.signal })
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let finish: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
    let finished = false
    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.delta.content) yield { type: 'text-delta', index: 0, text: choice.delta.content }
      for (const delta of choice.delta.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' }
        if (delta.id) call.id = delta.id
        if (delta.function?.name) call.name = delta.function.name
        if (delta.function?.arguments) call.arguments += delta.function.arguments
        calls.set(delta.index, call)
      }
      if (choice.finish_reason !== null) finished = true
      if (choice.finish_reason === 'content_filter') throw new PersonalChatError('model-filtered', 'The provider stopped this response')
      if (choice.finish_reason === 'tool_calls') finish = 'tool-calls'
      if (choice.finish_reason === 'length') finish = 'max-tokens'
    }
    if (!finished) throw new PersonalChatError('incomplete-stream', 'The provider stream ended before its final status')
    for (const [index, call] of calls) {
      if (!call.id || !call.name) throw new PersonalChatError('invalid-model-stream', 'Provider returned an incomplete tool call')
      yield { type: 'block-end', index: index + 1, block: { type: 'tool-call', id: brandString<ToolCallId>(call.id), name: call.name, arguments: call.arguments } }
    }
    yield { type: 'finish', reason: { kind: finish } }
  }
}
function convertMessage(message: RequestMessage, images: ReadonlyMap<string, readonly InlineImage[]>): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (message.role === 'user') {
    const ownImages = 'id' in message && message.id ? images.get(message.id) ?? [] : []
    return { role: 'user', content: [{ type: 'text', text }, ...ownImages.map(image => ({ type: 'image_url' as const, image_url: { url: 'data:' + image.mediaType + ';base64,' + image.base64 } }))] }
  }
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: text }
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function' as const, function: { name: block.name, arguments: block.arguments } }))
    return { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }
  }
  return { role: 'system', content: text }
}
