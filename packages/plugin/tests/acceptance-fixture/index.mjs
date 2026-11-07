/** Deterministic local model for isolated browser acceptance; never calls a provider. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setTimeout as sleep } from 'node:timers/promises'
export const inject = ['llm']
export function apply(ctx) {
  class Fixture extends LlmAdapter {
    providerInfo() { return { id: 'personal-fixture', name: 'Local acceptance' } }
    async listModels() { return [{ provider: 'personal-fixture', id: 'fixture', name: 'No external calls', inputModalities: ['text'] }] }
    async *stream(options) {
      if (options.sessionId !== undefined) throw new Error('Personal Chat unexpectedly created a Work Session')
      const last = options.messages.at(-1)
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
