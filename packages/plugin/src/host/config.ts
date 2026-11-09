import z from '@deepseek-ai/schemastery'
import type { ArchiveLimits } from './archive.ts'
import type { InlineProvider } from '../shared/models.ts'

export interface Config extends ArchiveLimits {
  dataDir: string
  maxStoredArchiveBytes: number
  maxSnapshotBytes: number
  maxContextBytes: number
  maxProfileBytes: number
  maxMemoryEntries: number
  maxSummaryBytes: number
  maxAttachmentBytes: number
  maxAttachmentTextBytes: number
  maxPdfPages: number
  maxToolSteps: number
  maxOutputTokens: number
  previewTtlMs: number
  temporaryIdleMs: number
  autoTitles: boolean
  inlineProvider?: InlineProvider
}
export const Config: z<Config> = z.object({
  dataDir: z.string().required(),
  maxUploadBytes: z.natural().min(1).default(64 * 1024 * 1024),
  maxArchiveBytes: z.natural().min(1).default(256 * 1024 * 1024),
  maxStoredArchiveBytes: z.natural().min(1).default(512 * 1024 * 1024),
  maxConversations: z.natural().min(1).default(10000),
  maxNodes: z.natural().min(1).default(500000),
  maxZipEntries: z.natural().min(1).default(100000),
  maxSnapshotBytes: z.natural().min(1024).default(24000),
  maxContextBytes: z.natural().min(4096).default(512 * 1024).description('Bytes one model request may carry; a route that discloses a smaller context window gets less, and long chats condense their oldest turns to fit'),
  maxProfileBytes: z.natural().min(1).default(24000),
  maxMemoryEntries: z.natural().min(1).default(1000),
  maxSummaryBytes: z.natural().min(1024).default(16000),
  maxAttachmentBytes: z.natural().min(1).default(16 * 1024 * 1024),
  maxAttachmentTextBytes: z.natural().min(1024).default(24000),
  maxPdfPages: z.natural().min(1).default(500),
  maxToolSteps: z.natural().min(1).default(16).description('Model steps with tool calls in one reply; after the last one the model answers without more tools'),
  maxOutputTokens: z.natural().min(1).default(8192),
  previewTtlMs: z.natural().min(1).default(15 * 60 * 1000),
  temporaryIdleMs: z.natural().min(1000).default(60 * 1000),
  autoTitles: z.boolean().default(true).description('After the first reply, the chat model writes a short title from the first exchange, unless the person renamed the chat'),
  inlineProvider: z.union([z.const(undefined), z.object({
    baseURL: z.string().required(),
    credentialRef: z.string().required(),
    models: z.array(z.string()).required(),
  })]),
})
