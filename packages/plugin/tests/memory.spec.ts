import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConversationId } from '../src/shared/types.ts'
import { candidateReason, evidenceKey, fingerprint } from '../src/host/memory.ts'
import type { MemoryLedger } from '../src/host/storage.ts'
const source = { kind: 'chat' as const, conversationId: brandString<ConversationId>('owned'), messageId: 'm1' }
const ledger: MemoryLedger = { profile: { revision: 0, background: '', instructions: '', autoSaveLowRisk: true, updatedAt: 0 }, memories: [], candidates: [], suppressed: [] }
describe('server memory admission', () => {
  it('autosaves only grounded low-risk preferences or explicit non-sensitive requests', () => {
    expect(candidateReason('I prefer concise answers', 'I prefer concise answers', source, ledger)).toBe('low-risk')
    expect(candidateReason('I prefer tea', 'Remember: I prefer tea', source, ledger)).toBe('explicit')
    expect(candidateReason('I prefer Python', 'I wrote some Python today', source, ledger)).toBe('inference')
    expect(candidateReason('I prefer concise answers; I have HIV', 'Remember I prefer concise answers; I have HIV', source, ledger)).toBe('sensitive')
  })
  it('sensitivity wins over an explicit remember request and cannot be model-overridden', () => {
    expect(candidateReason('my password is secret', 'Remember my password is secret', source, ledger)).toBe('sensitive')
    expect(candidateReason('我有抑郁症', '记住我有抑郁症', source, ledger)).toBe('sensitive')
    expect(candidateReason('I prefer concise answers', 'I prefer concise answers', source, ledger, 'previous')).toBe('conflict')
  })
  it('forgotten evidence cannot be automatically resurrected with a paraphrase', () => {
    const suppressed = { ...ledger, suppressed: [{ text: fingerprint('I prefer tea'), evidence: evidenceKey(source) }] }
    expect(candidateReason('I like tea', 'I like tea', source, suppressed)).toBe('suppressed')
    expect(candidateReason('I prefer tea', 'I prefer tea', { ...source, messageId: 'm2' }, suppressed)).toBe('suppressed')
  })
})
