/** Deterministic local model for isolated browser acceptance; never calls a provider. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setTimeout as sleep } from 'node:timers/promises'
export const inject = ['llm']
export function apply(ctx) {
  class Fixture extends LlmAdapter {
    providerInfo() { return { id: 'personal-fixture', name: 'Local acceptance' } }
    async listModels() { return [{ provider: 'personal-fixture', id: 'fixture', name: 'No external calls', inputModalities: ['text'] }] }
    async resolveModel(provider, id) { return { provider, id, name: 'No external calls', inputModalities: ['text'], reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } }
    async *stream(options) {
      if (options.sessionId !== undefined) throw new Error('Personal Chat unexpectedly created a Work Session')
      const last = options.messages.at(-1)
      const asked = options.messages.findLast(message => message.role === 'user')
      const question = asked.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      // The memory summary: return only the parts that change, or answer on the summary page.
      if (options.system?.startsWith('You maintain a memory summary')) {
        const told = [...question.matchAll(/^User: (.*)$/gmu)].map(match => match[1].slice(0, 80))
        const message = /<message>\n([\s\S]*)\n<\/message>/u.exec(question)?.[1]
        const suggestions = '<suggestions>\n梳理你的验收流程从准备到部署的完整步骤。\n对比隔离环境和日常服务的配置差异。\n串联你的测试脚本、截图和报告安排。\n</suggestions>'
        const text = message === undefined
          ? `<overview>\n你最近在 Beluga 里聊过 ${told.length} 件事，主要围绕验收和日常安排。\n</overview>\n<sections>\n## 最近提到的事\n${told.join('；')}。\n\n## 工作方式\n你习惯先在隔离环境里验收，再部署到日常服务。\n</sections>\n${suggestions}`
          : /[?？]/u.test(message) ? '<reply>摘要里记着：你在用 Beluga 做验收。</reply>'
            : `<reply>已按你的要求更新。</reply>\n<sections>\n## 最近的更正\n${message}\n</sections>\n${suggestions}`
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // Condensing a long chat lists the start of each message it read, after what was condensed before.
      if (options.system?.startsWith('You condense')) {
        const read = [...question.matchAll(/^User: (.{0,40})/gmu)].map(match => '- ' + match[1])
        const previous = /<condensed_so_far>\n([\s\S]*?)\n<\/condensed_so_far>/u.exec(question)?.[1] ?? ''
        yield { type: 'text-delta', index: 0, text: '<condensed>\n## Earlier in this chat\n' + read.join('\n') + (previous.startsWith('(nothing') ? '' : '\n' + previous) + '\n</condensed>' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // `CONTEXT` reports what this request carried of the chat.
      if (last.role === 'user' && question.startsWith('CONTEXT')) {
        const sent = JSON.stringify(options.messages)
        const turns = options.messages.filter(message => message.role === 'user' && !message.content.some(block => block.type === 'text' && block.text.startsWith('Context supplied'))).length
        yield { type: 'text-delta', index: 0, text: 'Context: ' + turns + ' turns sent as written; condensed earlier turns: ' + (sent.includes('<earlier_in_this_chat>') ? 'yes' : 'no') + '.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // `PLAN` walks a to-do list through its steps, one tool call per step, then answers.
      if (question.startsWith('PLAN')) {
        const step = options.messages.length - 1 - options.messages.lastIndexOf(asked)
        const lists = [[['Search the sources', 'in_progress'], ['Draft the answer', 'pending'], ['Check the figures', 'pending']], [['Search the sources', 'completed'], ['Draft the answer', 'in_progress'], ['Check the figures', 'pending']], [['Search the sources', 'completed'], ['Draft the answer', 'completed'], ['Check the figures', 'completed']]]
        const index = Math.floor(step / 2)
        yield { type: 'reasoning-delta', index: 0, text: 'Step ' + index + ': deciding what comes next.' }
        try { await sleep(1200, undefined, { signal: options.signal }) } catch { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped' } } }; return }
        if (index < lists.length) {
          yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: randomUUID(), name: 'todo_write', arguments: JSON.stringify({ todos: lists[index].map(([content, status]) => ({ content, status })) }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', index: 1, text: 'All three steps are done. The figures check out.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // `LOOP` keeps looking things up, one step at a time, until told the reply's tool budget is spent.
      if (question.startsWith('LOOP')) {
        if (options.system?.includes('used its tool budget')) yield { type: 'text-delta', index: 0, text: 'Budget spent after ' + options.messages.filter(message => message.role === 'tool').length + ' results; answering from what I found.' }
        else yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'memory_recall', arguments: JSON.stringify({ query: 'step ' + options.messages.length }) } }
        yield { type: 'finish', reason: { kind: options.system?.includes('used its tool budget') ? 'stop' : 'tool-calls' } }
        return
      }
      // `GITHUB <tool> <arguments>` loads that GitHub tool, calls it, then reports what came back.
      const github = /^GITHUB (\w+) (\{.*\})$/u.exec(question.split('\n')[0])
      if (github) {
        const step = options.messages.length - 1 - options.messages.lastIndexOf(asked)
        const call = step === 0 ? { name: 'use_github', arguments: { tools: [github[1]] } } : step === 2 ? { name: 'github__' + github[1], arguments: JSON.parse(github[2]) } : undefined
        if (call) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'GitHub answered: `' + JSON.stringify(last.content).slice(0, 160) + '`' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // `THINK` streams reasoning before the answer, as a reasoning model does.
      if (last.role === 'user' && question.startsWith('THINK')) {
        for (const part of ['Weighing ', 'the question ', 'from both sides.']) { yield { type: 'reasoning-delta', index: 0, text: part }; await sleep(400) }
        yield { type: 'text-delta', index: 1, text: 'Effort: ' + (options.reasoningEffort ?? 'default') + '. Thought it through.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      // `TOOL {"name":…,"arguments":…}` on the first line asks for one tool call, as a real model would.
      const scripted = last.role === 'user' && /^TOOL (.+)$/mu.exec(text.split('\n')[0])
      if (scripted) {
        const { name, arguments: input } = JSON.parse(scripted[1])
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(input) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const result = text.startsWith('WAIT') ? 'Partial response — stop this turn.' : '## Local acceptance\n\nYour message: ' + text + '\n\n| Capability | State |\n| --- | --- |\n| Streaming | Ready |\n| Personal history | Separate from Work |\n\n```python\nprint("hello")\n```\n\nInline math: $a^2+b^2=c^2$.\n\n![External image](https://example.invalid/never-fetch.png)'
      for (const token of result.match(/.{1,12}/gs) ?? []) {
        if (options.signal?.aborted) break
        yield { type: 'text-delta', index: 0, text: token }
        try { await sleep(text.startsWith('WAIT') ? 500 : 35, undefined, { signal: options.signal }) } catch { break }
      }
      if (options.signal?.aborted) yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped' } } }
      else yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['personal-fixture'], new Fixture())
}
