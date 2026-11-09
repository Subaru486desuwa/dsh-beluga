/** Reuse configured Harness text routes; an explicit inline route never stores images. */
import OpenAI from 'openai'
import type { Context } from '@deepseek-ai/cordis'
import { attributionHeaders, BlockAssembler, createUserMessage, type GenerateOptions, type ReasoningEffortId, type RequestMessage, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { sameRoute, type EffortChoice, type InlineProvider, type ModelChoice, type ModelRef } from '../shared/models.ts'
import { PersonalChatError } from './archive.ts'
import { textOf } from './records.ts'

const INLINE_PROVIDER = 'personal-inline'
/** Block positions in one inline response: reasoning, then text, then tool calls. */
const REASONING_INDEX = 0
const TEXT_INDEX = 1
const FIRST_TOOL_INDEX = 2
/** Harness names the effort that turns reasoning off `off`; OpenAI-compatible endpoints spell it `none`. */
const EFFORT_WIRE: Readonly<Record<string, string>> = { off: 'none' }
/** Bounds what one background answer may stream. */
const STREAM_BYTES = 512 * 1024
/**
 * A provider failure code safe to show and log; anything else becomes `MODEL_ERROR`.
 * @param code the failure's provider-neutral code.
 * @returns `code` when it is 1-64 upper-case letters, digits, `_` or `-`.
 */
export function safeCode(code: string): string { return /^[A-Z0-9_-]{1,64}$/u.test(code) ? code : 'MODEL_ERROR' }
type Reasoning = Pick<ModelChoice, 'efforts' | 'defaultEffort'>
type ReasoningDelta = { readonly reasoning_content?: string | null; readonly reasoning?: string | null }
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
  /**
   * List every usable route; a provider whose catalog fails is skipped, not fatal. A model the
   * inline route serves is listed once, as that route, under the Harness name and efforts.
   */
  async models(): Promise<readonly ModelChoice[]> {
    const inline = this.inline?.models ?? []
    const host = await this.hostChoices()
    const choices = host.map(choice => inline.includes(choice.model) ? this.inlineChoice(choice.model, choice) : choice)
    for (const model of inline) if (!host.some(choice => choice.model === model)) choices.push(this.inlineChoice(model))
    return choices
  }
  private inlineChoice(model: string, twin?: ModelChoice): ModelChoice {
    return { provider: INLINE_PROVIDER, model, inline: true, name: twin?.name ?? model, images: true, ...(twin?.efforts ? { efforts: twin.efforts } : {}), ...(twin?.defaultEffort ? { defaultEffort: twin.defaultEffort } : {}) }
  }
  private async hostChoices(): Promise<ModelChoice[]> {
    const providers = [...this.ctx.llm.listProviders()]
    const catalogs = await Promise.allSettled(providers.map(async provider => this.ctx.llm.listModels(provider.id)))
    const listed = providers.flatMap((provider, index) => {
      const catalog = catalogs[index]!
      if (catalog.status === 'fulfilled') return catalog.value.map(model => ({ provider, model }))
      this.catalogFailed(provider.id, catalog.reason)
      return []
    })
    const reasoning = await Promise.all(listed.map(({ provider, model }) => this.reasoning(provider.id, model.id)))
    return listed.map(({ provider, model }, index) => ({ provider: provider.id, model: model.id, name: provider.name + ' · ' + model.name, images: false, ...(model.inputModalities?.includes('image') ? { imageNote: 'Configure the plugin inline image route to avoid the host attachment store.' } : {}), ...reasoning[index] }))
  }
  /** Efforts the owning adapter offers; a failed lookup only hides the control. */
  private async reasoning(provider: string, model: string): Promise<Reasoning> {
    try {
      const info = (await this.ctx.llm.resolveModelInfo(provider, model)).reasoning
      if (!info?.efforts.length) return {}
      const efforts: EffortChoice[] = info.efforts.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }))
      return { efforts, ...(info.defaultEffort ? { defaultEffort: info.defaultEffort } : {}) }
    } catch (error) { this.catalogFailed(provider, error); return {} }
  }
  /** Check one route against its own catalog, so an unrelated broken provider cannot block it. */
  async available(model: ModelRef): Promise<boolean> {
    if (model.inline) return model.provider === INLINE_PROVIDER && this.inline?.models.includes(model.model) === true
    try { return (await this.ctx.llm.listModels(model.provider)).some(choice => choice.id === model.model) }
    catch (error) { this.catalogFailed(model.provider, error); return false }
  }
  /** Whether the route offers the effort sent with it. An inline route offers what the Harness route for the same model offers. */
  async takesEffort(model: ModelRef): Promise<boolean> {
    if (model.effort === undefined) return true
    let reasoning: Reasoning = {}
    if (!model.inline) reasoning = await this.reasoning(model.provider, model.model)
    else for (const provider of this.ctx.llm.listProviders()) {
      const listed = await this.ctx.llm.listModels(provider.id).then(models => models.some(item => item.id === model.model), () => false)
      if (listed) { reasoning = await this.reasoning(provider.id, model.model); break }
    }
    return reasoning.efforts?.some(effort => effort.id === model.effort) === true
  }
  /** Tokens the route accepts for one request and its reply together, when its adapter discloses them. */
  async contextWindow(model: ModelRef): Promise<number | undefined> {
    if (model.inline) return undefined
    try { return (await this.ctx.llm.resolveModelInfo(model.provider, model.model)).context?.contextWindow }
    catch (error) { this.catalogFailed(model.provider, error); return undefined }
  }
  /** The route at its least effort above off, for background work; undefined when the route is not offered. */
  async quiet(target: ModelRef): Promise<ModelRef | undefined> {
    const choice = (await this.models()).find(item => sameRoute(item, target))
    if (!choice) return undefined
    const effort = choice.efforts?.find(item => item.id !== 'off')?.id
    return { provider: choice.provider, model: choice.model, ...(choice.inline ? { inline: true as const } : {}), ...(effort ? { effort } : {}) }
  }
  /**
   * One text answer to one input, without tools, for work the person does not wait on.
   * @returns the text, and whether the output limit cut it off.
   * @throws PersonalChatError when the request stops, fails or streams more than 512 KiB; a failure names its code and is logged.
   */
  async complete(model: ModelRef, system: string, input: string, maxTokens: number, signal: AbortSignal): Promise<{ readonly text: string; readonly cut: boolean }> {
    const assembler = new BlockAssembler()
    let received = 0
    const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input }] })]
    for await (const chunk of this.stream(model, { messages, system, maxTokens, signal }, new Map())) {
      received += Buffer.byteLength(JSON.stringify(chunk))
      if (received > STREAM_BYTES) throw new PersonalChatError('response-limit', 'Response exceeded the 512 KiB stream limit')
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish.kind === 'aborted') throw new PersonalChatError('stopped', 'The request stopped')
    if (finish.kind === 'error') {
      const code = safeCode(finish.failure.code)
      this.ctx.logger.warn(`personal-chat: background model request to ${model.provider}/${model.model} failed: ${code}${finish.failure.status ? ' (HTTP ' + finish.failure.status + ')' : ''}`)
      throw new PersonalChatError('model-error', 'Model request failed: ' + code)
    }
    return { text: textOf(assembler.message({ provider: model.provider, model: model.model })), cut: finish.kind === 'max-tokens' }
  }
  private catalogFailed(provider: string, reason: unknown): void {
    this.ctx.logger.warn('personal-chat: model catalog failed for provider ' + provider)
    this.ctx.logger.warn(reason)
  }
  /** Stream one admitted route; admission owns the availability check. */
  async *stream(model: ModelRef, options: Omit<GenerateOptions, 'provider' | 'model' | 'sessionId' | 'reasoningEffort'>, images: ReadonlyMap<string, readonly InlineImage[]>): AsyncIterable<StreamChunk> {
    if (!model.inline) {
      if (images.size) throw new PersonalChatError('image-route-required', 'This conversation contains images. Select the configured inline image route.')
      yield* this.ctx.llm.stream({ ...options, provider: model.provider, model: model.model, ...(model.effort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(model.effort) }) })
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
      ...(model.effort === undefined ? {} : { reasoning_effort: (EFFORT_WIRE[model.effort] ?? model.effort) as OpenAI.Chat.Completions.ChatCompletionCreateParams['reasoning_effort'] }),
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    }, { signal: options.signal })
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let finish: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
    let finished = false
    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      // Compatible endpoints that expose reasoning name the field either way; OpenAI itself sends none.
      const delta = choice.delta as typeof choice.delta & ReasoningDelta
      const thought = delta.reasoning_content ?? delta.reasoning
      if (thought) yield { type: 'reasoning-delta', index: REASONING_INDEX, text: thought }
      if (delta.content) yield { type: 'text-delta', index: TEXT_INDEX, text: delta.content }
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' }
        if (part.id) call.id = part.id
        if (part.function?.name) call.name = part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
        calls.set(part.index, call)
      }
      if (choice.finish_reason !== null) finished = true
      if (choice.finish_reason === 'content_filter') throw new PersonalChatError('model-filtered', 'The provider stopped this response')
      if (choice.finish_reason === 'tool_calls') finish = 'tool-calls'
      if (choice.finish_reason === 'length') finish = 'max-tokens'
    }
    if (!finished) throw new PersonalChatError('incomplete-stream', 'The provider stream ended before its final status')
    for (const [index, call] of calls) {
      if (!call.id || !call.name) throw new PersonalChatError('invalid-model-stream', 'Provider returned an incomplete tool call')
      yield { type: 'block-end', index: index + FIRST_TOOL_INDEX, block: { type: 'tool-call', id: brandString<ToolCallId>(call.id), name: call.name, arguments: call.arguments } }
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
