import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Message, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type * as T from '../shared/types.ts'
import type { ModelRef } from '../shared/models.ts'

const id = z.string().uuid()
const cid = id.transform(brandString<T.ConversationId>)
const bid = id.transform(brandString<T.BranchId>)
const rid = id.transform(brandString<T.ArchiveRevisionId>)
const mid = id.transform(brandString<T.MemoryId>)
const kid = id.transform(brandString<T.CandidateId>)
const batchId = id.transform(brandString<T.ImportBatchId>)
const selection = z.object({ revisionId: rid, nodeId: z.string() })
const model = z.object({ provider: z.string(), model: z.string(), inline: z.literal(true).optional(), effort: z.string().optional() })
const text = z.object({ type: z.literal('text'), text: z.string() })
const reasoning = z.object({ type: z.literal('reasoning'), text: z.string() })
const toolCall = z.object({ type: z.literal('tool-call'), id: z.string().transform(brandString<ToolCallId>), name: z.string(), arguments: z.string() })
const messageId = z.string().transform(brandString<MessageId>)
const message: z.ZodType<Message> = z.discriminatedUnion('role', [
  z.object({ id: messageId, role: z.literal('user'), content: z.array(text), source: z.object({ kind: z.literal('user') }) }),
  z.object({ id: messageId, role: z.literal('assistant'), content: z.array(z.union([text, reasoning, toolCall])), source: z.object({ kind: z.literal('model'), provider: z.string(), model: z.string(), replayState: z.json().optional() }) }),
  z.object({ id: messageId, role: z.literal('tool'), content: z.array(text), source: z.object({ kind: z.literal('tool'), callId: z.string().transform(brandString<ToolCallId>) }), toolCallId: z.string().transform(brandString<ToolCallId>), isError: z.boolean().optional() }),
])
export interface ChatEntry { readonly id: string; readonly message: Message; readonly time: number; readonly attachmentIds: readonly string[]; readonly userText?: string; readonly admissionModel?: ModelRef; readonly admissionWeb?: boolean; readonly originBranchId?: T.BranchId; readonly sources?: readonly T.WebSource[]; readonly thinkingMs?: number; readonly proposed?: readonly T.CandidateId[]; readonly recalled?: readonly T.MemoryId[]; readonly referenced?: readonly T.ConversationId[]; readonly work?: readonly T.WorkReference[] }
/** What one tool call proposed to personal memory or drew on, kept for the list under its reply. */
export type ToolNotes = Pick<ChatEntry, 'proposed' | 'recalled' | 'referenced' | 'work'>
/** Earlier turns of one chat rewritten by a model, which model requests carry in place of those turns. */
export interface Condensed {
  /** The last message it covers; a branch holding this message can use it. */
  readonly throughId: string
  readonly text: string
  readonly time: number
}
/** One conversation as the service uses it. Entries are stored as their own append-only rows. */
export interface ConversationRecord {
  readonly conversation: T.Conversation
  readonly entries: readonly ChatEntry[]
  readonly attachments: readonly T.ChatAttachment[]
  readonly model?: ModelRef
  readonly error?: string
  readonly running?: boolean
  readonly deleting?: boolean
  /** Condensed earlier turns, at most one per branch: the newest that branch can use. */
  readonly condensed?: readonly Condensed[]
}
export type ConversationHead = Omit<ConversationRecord, 'entries'>
const conversation: z.ZodType<T.Conversation> = z.object({
  id: cid, title: z.string(), temporary: z.literal(false), archived: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  branches: z.array(z.object({ id: bid, messageIds: z.array(z.string()), context: z.string().optional(), operation: z.enum(['edit', 'regenerate', 'fork']).optional(), parentBranchId: bid.optional(), sourceMessageId: z.string().optional(), archive: selection.optional(), snapshot: z.object({ omittedNodes: z.number(), includedNodes: z.number(), bytes: z.number() }).optional(), createdAt: z.number() })),
  selectedBranchId: bid.optional(), archiveRevisions: z.array(rid), selectedArchive: selection.optional(), pinned: z.boolean().optional(), titleSource: z.enum(['generated', 'renamed']).optional(), archiveWithdrawn: z.boolean(),
})
const attachment: z.ZodType<T.ChatAttachment> = z.object({ id, conversationId: cid, name: z.string(), mediaType: z.string(), bytes: z.number(), image: z.boolean(), artifact: z.object({ rootId: id, parentId: id.optional(), version: z.number().int().positive(), summary: z.string() }).optional() })
/** Only web addresses may become links in the page. */
export function isWebUrl(value: string): boolean { return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol) }
export const chatEntry: z.ZodType<ChatEntry> = z.object({ id: z.string(), message, time: z.number(), attachmentIds: z.array(z.string()), userText: z.string().optional(), admissionModel: model.optional(), admissionWeb: z.boolean().optional(), originBranchId: bid.optional(), sources: z.array(z.object({ url: z.string().refine(isWebUrl), title: z.string().optional() })).optional(), thinkingMs: z.number().int().nonnegative().optional(), proposed: z.array(kid).optional(), recalled: z.array(mid).optional(), referenced: z.array(cid).optional(), work: z.array(z.object({ sessionId: z.string().min(1).transform(brandString<T.WorkSessionRef>), title: z.string() })).optional() })
export const conversationHead: z.ZodType<ConversationHead> = z.object({ conversation, attachments: z.array(attachment), model: model.optional(), error: z.string().optional(), running: z.boolean().optional(), deleting: z.boolean().optional(), condensed: z.array(z.object({ throughId: z.string(), text: z.string(), time: z.number() })).optional() })
/** Identities are unique and every reference stays inside the record. */
export function consistent(record: ConversationRecord): boolean {
  const entries = new Set(record.entries.map(entry => entry.id))
  const assets = new Set(record.attachments.map(asset => asset.id))
  const branches = new Set(record.conversation.branches.map(branch => branch.id))
  return entries.size === record.entries.length && assets.size === record.attachments.length && branches.size === record.conversation.branches.length
    && record.attachments.every(asset => asset.conversationId === record.conversation.id)
    && record.entries.every(entry => entry.attachmentIds.every(id => assets.has(id)))
    && record.conversation.branches.every(branch => branch.messageIds.every(id => entries.has(id)))
    && (record.conversation.selectedBranchId === undefined || branches.has(record.conversation.selectedBranchId))
}
export const textOf = (message: Message): string => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const source: z.ZodType<T.MemorySource> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), conversationId: cid, messageId: z.string() }),
  z.object({ kind: z.literal('archive'), revisionId: rid, nodeId: z.string() }),
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('imported-text'), fileName: z.string() }),
])
const profile: z.ZodType<T.PersonalProfile> = z.object({ revision: z.number(), background: z.string(), source: z.object({ fileName: z.string(), kind: z.enum(['profile', 'custom-instructions', 'agents']), scope: z.literal('personal') }).optional(), instructions: z.string(), autoSaveLowRisk: z.boolean(), referenceChats: z.boolean().default(true), updatedAt: z.number() })
const memory: z.ZodType<T.Memory> = z.object({ id: mid, revision: z.number(), text: z.string(), category: z.enum(['preference', 'fact', 'decision']), scope: z.literal('personal'), source, createdAt: z.number(), updatedAt: z.number(), state: z.enum(['active', 'superseded', 'forgotten']), supersedes: mid.optional() })
const candidate: z.ZodType<T.MemoryCandidate> = z.object({ id: kid, revision: z.number(), text: z.string(), category: z.enum(['preference', 'fact', 'decision']), source, reason: z.enum(['low-risk', 'explicit', 'sensitive', 'inference', 'conflict', 'archive', 'suppressed', 'review']), state: z.enum(['pending', 'saved', 'rejected']), createdAt: z.number(), memoryId: mid.optional(), replaces: mid.optional() })
export const importBatch: z.ZodType<T.ImportBatch> = z.object({ id: batchId, fileName: z.string(), createdAt: z.number(), state: z.enum(['preparing', 'committed', 'withdrawn']), revisionIds: z.array(rid), skipped: z.number() })
export interface ArchiveRecord { readonly id: T.ArchiveRevisionId; readonly batchId: T.ImportBatchId; readonly conversationId: T.ConversationId; readonly sourceId: string; readonly original: Record<string, JsonValue> }
export const archiveRecord: z.ZodType<ArchiveRecord> = z.object({ id: rid, batchId, conversationId: cid, sourceId: z.string(), original: z.record(z.string(), z.json()) })
/** The route and effort of the last sent message, and the effort last sent with each route, keyed by `routeKey`. */
export interface ModelPreferences { readonly last?: ModelRef; readonly efforts: Readonly<Record<string, string>> }
export const modelPreferences: z.ZodType<ModelPreferences> = z.object({ last: model.optional(), efforts: z.record(z.string(), z.string()) })
/**
 * Whether the model may use web search unasked,
 * and which Work crossings are on. Settings stored before a field existed read it as off or empty.
 */
export interface AppSettings { readonly webAuto: boolean; readonly workMemory: boolean; readonly workRecords: boolean; readonly workWorkspaces: readonly T.WorkspaceRef[] }
export const appSettings: z.ZodType<AppSettings> = z.object({ webAuto: z.boolean(), workMemory: z.boolean().default(false), workRecords: z.boolean().default(false), workWorkspaces: z.array(z.string().min(1).transform(brandString<T.WorkspaceRef>)).default([]) })
export interface MemoryLedger { readonly profile: T.PersonalProfile; readonly memories: readonly T.Memory[]; readonly candidates: readonly T.MemoryCandidate[]; readonly suppressed: readonly { readonly text: string; readonly evidence: string }[] }
export const memoryLedger: z.ZodType<MemoryLedger> = z.object({ profile, memories: z.array(memory), candidates: z.array(candidate), suppressed: z.array(z.object({ text: z.string(), evidence: z.string() })) })
export interface SummaryVersion { readonly text: string; readonly suggestions: readonly string[]; readonly updatedAt: number }
/** The Memory Summary, its earlier versions, and how far it has read each chat. */
export interface SummaryRecord extends SummaryVersion {
  readonly revision: number
  /** Earlier versions, newest first. */
  readonly history: readonly SummaryVersion[]
  /** How many stored entries of each chat, by conversation id, the summary has already read. */
  readonly progress: Readonly<Record<string, number>>
  /** Chats changed before this time hold nothing the summary has not read. */
  readonly collectedAt: number
  /** When the last update, automatic or requested, started; spaces automatic ones. */
  readonly lastRunAt: number
  readonly error?: string
  readonly model?: ModelRef
  readonly sensitive: boolean
}
const summaryVersion = z.object({ text: z.string(), suggestions: z.array(z.string()), updatedAt: z.number() })
export const summaryRecord: z.ZodType<SummaryRecord> = summaryVersion.extend({ revision: z.number(), history: z.array(summaryVersion), progress: z.record(z.string(), z.number().int().nonnegative()), collectedAt: z.number(), lastRunAt: z.number(), error: z.string().optional(), model: model.optional(), sensitive: z.boolean() })
