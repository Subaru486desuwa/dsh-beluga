import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PersonalChatError } from './archive.ts'
import { candidateReason, evidenceKey, fingerprint, normalized } from './memory.ts'
import type { Config } from './config.ts'
import type { Conversations } from './conversations.ts'
import type { MemoryLedger } from './records.ts'
import type { CandidateId, CandidateInput, Conversation, ConversationId, Memory, MemoryCandidate, MemoryId, MemorySource, MemoryState, PersonalProfile, ProfileImportSource } from '../shared/types.ts'

/** The user's profile and confirmed facts. Temporary Chat can neither read nor write them. */
export class PersonalMemory {
  constructor(private readonly chats: Conversations, private readonly config: Config) {}
  guard(conversationId?: ConversationId): void {
    if (conversationId !== undefined && this.chats.find(conversationId).temporary) throw new PersonalChatError('memory-forbidden', 'Temporary Chat cannot read or write long-term memory')
  }
  /** A pending candidate cannot outlive the conversation it came from. */
  async releaseConversation(id: ConversationId): Promise<void> {
    const ledger = this.chats.domain.global.get()
    const candidates = ledger.candidates.filter(candidate => !(candidate.state === 'pending' && candidate.source.kind === 'chat' && candidate.source.conversationId === id))
    if (candidates.length !== ledger.candidates.length) await this.saveLedger({ ...ledger, candidates })
  }
  async state(request: { readonly conversationId?: ConversationId }): Promise<MemoryState> {
    this.guard(request.conversationId)
    const { profile, memories, candidates } = this.chats.domain.global.get()
    const active = memories.filter(memory => memory.state === 'active')
    return { profile, memories: active, candidates: candidates.filter(candidate => candidate.state === 'pending' || (candidate.state === 'saved' && active.some(memory => memory.id === candidate.memoryId))) }
  }
  async updateProfile(request: { readonly conversationId?: ConversationId; readonly expectedRevision: number; readonly background: string; readonly instructions: string; readonly autoSaveLowRisk: boolean; readonly referenceChats: boolean; readonly source?: ProfileImportSource }): Promise<PersonalProfile> {
    this.guard(request.conversationId)
    if (Buffer.byteLength(request.background) + Buffer.byteLength(request.instructions) > this.config.maxProfileBytes) throw new PersonalChatError('profile-limit', 'Profile and instructions exceed maxProfileBytes')
    return this.chats.serial(async () => {
      this.guard(request.conversationId)
      const ledger = this.chats.domain.global.get()
      this.revision(ledger.profile.revision, request.expectedRevision)
      const profile: PersonalProfile = { ...(request.source ? { source: request.source } : {}), revision: ledger.profile.revision + 1, background: request.background, instructions: request.instructions, autoSaveLowRisk: request.autoSaveLowRisk, referenceChats: request.referenceChats, updatedAt: Date.now() }
      await this.saveLedger({ ...ledger, profile })
      return profile
    })
  }
  private revision(actual: number, expected: number): void {
    if (actual !== expected) throw new PersonalChatError('stale-revision', 'This item changed; refresh before editing or approving it')
  }
  private async saveLedger(ledger: MemoryLedger): Promise<void> { await this.chats.domain.global.set(ledger); this.chats.changed('memory') }
  private memoryText(text: string): string {
    const value = text.trim()
    if (/-----BEGIN .{0,30}PRIVATE KEY|(?:api[_ -]?key|password|密码|密钥|令牌)\s*[:=：]/iu.test(value)) throw new PersonalChatError('secret-memory', 'Credentials and private keys cannot be stored as memory')
    if (!value || Buffer.byteLength(value) > 2000) throw new PersonalChatError('memory-limit', 'Memory text must be 1–2000 UTF-8 bytes')
    return value
  }
  private async evidence(conversation: Conversation | undefined, source: MemorySource): Promise<string> {
    if (source.kind === 'manual' || source.kind === 'imported-text') return ''
    if (!conversation || conversation.temporary) throw new PersonalChatError('source-forbidden', 'Evidence requires a normal personal conversation')
    if (source.kind === 'archive') {
      if (!conversation.archiveRevisions.includes(source.revisionId)) throw new PersonalChatError('source-forbidden', 'Archive evidence belongs to another chat')
      const node = this.chats.readArchive(source.revisionId).nodes.find(item => item.id === source.nodeId)
      if (!node || node.structural || node.role !== 'user') return ''
      return node.text
    }
    if (source.conversationId !== conversation.id) throw new PersonalChatError('source-forbidden', 'Evidence belongs to another chat')
    const entry = this.chats.record(conversation.id).entries.find(item => item.id === source.messageId && item.message.role === 'user')
    if (!entry) throw new PersonalChatError('source-unavailable', 'The original user message is unavailable')
    return entry.userText ?? ''
  }
  async propose(request: CandidateInput): Promise<MemoryCandidate> {
    this.guard(request.conversationId)
    return this.chats.serial(async () => {
      this.guard(request.conversationId)
      const conversation = request.conversationId === undefined ? undefined : this.chats.find(request.conversationId)
      const text = this.memoryText(request.text)
      const evidence = await this.evidence(conversation, request.source)
      const ledger = this.chats.domain.global.get()
      const duplicate = ledger.candidates.find(candidate => (candidate.state === 'pending' || (candidate.state === 'saved' && ledger.memories.some(memory => memory.id === candidate.memoryId && memory.state === 'active'))) && normalized(candidate.text) === normalized(text) && evidenceKey(candidate.source) === evidenceKey(request.source))
      if (duplicate) return duplicate
      if (ledger.candidates.filter(item => item.state === 'pending').length >= this.config.maxMemoryEntries || ledger.memories.filter(item => item.state === 'active').length >= this.config.maxMemoryEntries) throw new PersonalChatError('memory-capacity', 'Memory capacity reached; manage existing entries before saving more')
      if (request.replaces && !ledger.memories.some(memory => memory.id === request.replaces && memory.state === 'active')) throw new PersonalChatError('memory-not-found', 'The memory to correct is unavailable')
      const reason = candidateReason(text, evidence, request.source, ledger, request.replaces)
      let candidate: MemoryCandidate = { id: brandString<CandidateId>(randomUUID()), revision: 1, text, category: request.category, source: request.source, reason, state: 'pending', createdAt: Date.now(), ...(request.replaces ? { replaces: request.replaces } : {}) }
      let memories = ledger.memories
      if (reason === 'explicit' || (reason === 'low-risk' && ledger.profile.autoSaveLowRisk)) {
        const memory = this.newMemory(candidate)
        memories = [...memories, memory]
        candidate = { ...candidate, state: 'saved', memoryId: memory.id }
      }
      await this.saveLedger({ ...ledger, memories, candidates: [...ledger.candidates, candidate] })
      return candidate
    })
  }
  private newMemory(candidate: MemoryCandidate): Memory {
    return { id: brandString<MemoryId>(randomUUID()), revision: 1, text: candidate.text, category: candidate.category, scope: 'personal', source: candidate.source, createdAt: Date.now(), updatedAt: Date.now(), state: 'active', ...(candidate.replaces ? { supersedes: candidate.replaces } : {}) }
  }
  async decide(request: { readonly conversationId?: ConversationId; readonly candidateId: CandidateId; readonly expectedRevision: number; readonly decision: 'confirm' | 'reject' }): Promise<MemoryCandidate> {
    this.guard(request.conversationId)
    return this.chats.serial(async () => {
      this.guard(request.conversationId)
      const ledger = this.chats.domain.global.get()
      const candidate = ledger.candidates.find(value => value.id === request.candidateId)
      if (!candidate) throw new PersonalChatError('candidate-not-found', 'Memory candidate is unavailable')
      this.revision(candidate.revision, request.expectedRevision)
      if (request.decision === 'confirm' && candidate.state !== 'pending') throw new PersonalChatError('candidate-settled', 'This candidate is no longer pending')
      let memories = ledger.memories
      let suppressed = ledger.suppressed
      let updated: MemoryCandidate
      if (request.decision === 'confirm') {
        if (candidate.replaces && !ledger.memories.some(value => value.id === candidate.replaces && value.state === 'active')) throw new PersonalChatError('stale-revision', 'The memory being corrected changed; review a new candidate')
        if (ledger.memories.filter(item => item.state === 'active').length - (candidate.replaces ? 1 : 0) >= this.config.maxMemoryEntries) throw new PersonalChatError('memory-capacity', 'Memory capacity reached')
        const memory = this.newMemory(candidate)
        memories = [...memories.map(value => value.id === candidate.replaces ? { ...value, state: 'superseded' as const, revision: value.revision + 1, updatedAt: Date.now() } : value), memory]
        updated = { ...candidate, state: 'saved', memoryId: memory.id, revision: candidate.revision + 1 }
      } else {
        if (candidate.state === 'rejected') return candidate
        memories = memories.map(value => value.id === candidate.memoryId ? { ...value, text: '', state: 'forgotten' as const, revision: value.revision + 1, updatedAt: Date.now() } : value)
        suppressed = [...suppressed, { text: fingerprint(candidate.text), evidence: evidenceKey(candidate.source) }]
        updated = { ...candidate, text: '', state: 'rejected', revision: candidate.revision + 1 }
      }
      await this.saveLedger({ ...ledger, memories, suppressed, candidates: ledger.candidates.map(value => value.id === updated.id ? updated : value) })
      return updated
    })
  }
  async edit(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number; readonly text: string }): Promise<Memory> {
    this.guard(request.conversationId)
    return this.chats.serial(async () => {
      this.guard(request.conversationId)
      const ledger = this.chats.domain.global.get()
      const memory = ledger.memories.find(value => value.id === request.memoryId)
      if (!memory || memory.state !== 'active') throw new PersonalChatError('memory-not-found', 'Active memory is unavailable')
      this.revision(memory.revision, request.expectedRevision)
      const replacement: Memory = { ...memory, id: brandString<MemoryId>(randomUUID()), revision: 1, text: this.memoryText(request.text), source: { kind: 'manual' }, supersedes: memory.id, createdAt: Date.now(), updatedAt: Date.now() }
      await this.saveLedger({ ...ledger, memories: [...ledger.memories.map(value => value.id === memory.id ? { ...value, state: 'superseded' as const, revision: value.revision + 1, updatedAt: Date.now() } : value), replacement], suppressed: [...ledger.suppressed, { text: fingerprint(memory.text), evidence: evidenceKey(memory.source) }] })
      return replacement
    })
  }
  async forget(request: { readonly conversationId?: ConversationId; readonly memoryId: MemoryId; readonly expectedRevision: number }): Promise<Memory> {
    this.guard(request.conversationId)
    return this.chats.serial(async () => {
      this.guard(request.conversationId)
      const ledger = this.chats.domain.global.get()
      const memory = ledger.memories.find(value => value.id === request.memoryId)
      if (!memory) throw new PersonalChatError('memory-not-found', 'Memory is unavailable')
      this.revision(memory.revision, request.expectedRevision)
      if (memory.state === 'forgotten') return memory
      const family = new Set<MemoryId>([memory.id])
      let parent = memory.supersedes
      while (parent && !family.has(parent)) { family.add(parent); parent = ledger.memories.find(item => item.id === parent)?.supersedes }
      const removed = ledger.memories.filter(item => family.has(item.id))
      const updated: Memory = { ...memory, text: '', state: 'forgotten', revision: memory.revision + 1, updatedAt: Date.now() }
      await this.saveLedger({ ...ledger,
        memories: ledger.memories.map(item => family.has(item.id) ? { ...item, text: '', state: 'forgotten' as const, revision: item.revision + 1, updatedAt: Date.now() } : item),
        candidates: ledger.candidates.map(item => item.memoryId && family.has(item.memoryId) ? { ...item, text: '', state: 'rejected' as const, revision: item.revision + 1 } : item),
        suppressed: [...ledger.suppressed, ...removed.map(item => ({ text: fingerprint(item.text), evidence: evidenceKey(item.source) }))],
      })
      this.chats.domain.checkpoint()
      return updated
    })
  }
  context(conversation: Conversation, query: string): string {
    if (conversation.temporary) return ''
    const ledger = this.chats.domain.global.get()
    const tokens: string[] = normalized(query).match(/[\p{L}\p{N}]{2,}/gu) ?? []
    for (const phrase of query.match(/[\p{Script=Han}]+/gu) ?? []) for (let i = 0; i + 1 < phrase.length; i++) tokens.push(phrase.slice(i, i + 2))
    const memories: Memory[] = []
    for (const memory of ledger.memories) if (memory.state === 'active' && tokens.some(token => normalized(memory.text).includes(token))) {
      if (Buffer.byteLength(JSON.stringify([...memories, memory])) <= this.config.maxSnapshotBytes) memories.push(memory)
    }
    return JSON.stringify({ profile: { background: ledger.profile.background }, relatedMemories: memories })
  }
}
