/**
 * Work Records: Chat reads the Work sessions of the workspaces the person allows, read-only
 * (ADR 0006). What it returns is tool output: it is never the person's words, and it never feeds
 * personal memory. Sessions are found by reading their messages for a time and literal text, so no
 * full-text index is needed.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { PersonalChatError } from './archive.ts'
import { normalized } from './memory.ts'
import type { Config } from './config.ts'
import type { AppSettings } from './records.ts'
import type { WorkReference, WorkSessionRef, WorkspaceRef } from '../shared/types.ts'

/** The Harness services Work Records reads through; either is absent when the profile leaves it out. */
export interface WorkReach {
  readonly query?: Pick<SessionQueryEngine, 'filterSessions' | 'readSession' | 'readTitleSnapshots'>
  readonly registry?: Pick<WorkspaceRegistry, 'list'>
}
/** A Work workspace as Chat lists it. */
export interface WorkspaceEntry { readonly id: WorkspaceRef; readonly title: string; readonly path: string }
/** One session a search found. Times are ISO 8601. */
export interface WorkSessionHit { readonly sessionId: string; readonly title: string; readonly workspace: string; readonly createdAt: string; readonly lastActive: string; readonly excerpt: string }
/** `more` says matching sessions were left out to stay within the byte limit; `unreadable` counts sessions that could not be read. */
export interface WorkSearchResult { readonly sessions: readonly WorkSessionHit[]; readonly more?: true; readonly unreadable?: number }
/** One message of a Work session: what the person typed, or what the agent answered. */
export interface WorkMessage { readonly role: 'user' | 'assistant'; readonly time: string; readonly text: string }
/** One page of a session's messages; continue at `nextOffset` when present. */
export interface WorkReadResult { readonly sessionId: string; readonly title: string; readonly workspace: string; readonly createdAt: string; readonly total: number; readonly offset: number; readonly messages: readonly WorkMessage[]; readonly nextOffset?: number }

/** Characters of a matching message a search shows, and how many of them come before the match. */
const EXCERPT_CHARS = 300
const EXCERPT_LEAD = 100
const UNTITLED = 'Untitled'

export const workSearchArgs = z.object({ query: z.string().trim().max(200).optional(), since: z.string().max(40).optional(), until: z.string().max(40).optional() }).strict()
export const workReadArgs = z.object({ sessionId: z.string().min(1).max(200), offset: z.number().int().min(0).optional() }).strict()

const iso = (time: number): string => new Date(time).toISOString()
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const clip = (text: string, chars: number): string => { const all = Array.from(text); return all.length > chars ? all.slice(0, chars).join('') + '…' : text }
/** @returns the text blocks of a message, joined. */
const blockText = (content: readonly { readonly type: string; readonly text?: string }[]): string => content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n').trim()

/**
 * @returns epoch milliseconds for a date or time the model gave, or undefined for none. A date alone is
 * a day on the Host's clock, which is the person's: its start, or its end for `until`.
 */
export function instant(value: string | undefined, end: boolean): number | undefined {
  if (!value?.trim()) return undefined
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value.trim())
  const time = Date.parse(dateOnly ? value.trim() + (end ? 'T23:59:59.999' : 'T00:00:00.000') : value)
  if (Number.isNaN(time)) throw new PersonalChatError('invalid-tool-arguments', 'since and until take a date such as 2026-03-01 or an ISO 8601 time')
  return time
}

/** One message as a search compares it: who said it, when, in epoch milliseconds, and its text. */
interface Spoken { readonly role: WorkMessage['role']; readonly at: number; readonly text: string }
/** @returns the person's and the agent's words from a raw session log, in order; tool calls, reasoning and injected notices are left out. */
function spoken(events: readonly SessionEvent[]): Spoken[] {
  const messages: Spoken[] = []
  for (const event of events) {
    const role = event.type === 'user/message' ? event.data.source.kind === 'user' ? 'user' : undefined : event.type === 'assistant/message' ? 'assistant' : undefined
    const text = role && blockText(event.type === 'user/message' ? event.data.content : event.type === 'assistant/message' ? event.data.message.content : [])
    if (role && text) messages.push({ role, at: event.time, text })
  }
  return messages
}
/** @returns the person's and the agent's words from a raw session log, in order, as read_work gives them. */
export function workMessages(events: readonly SessionEvent[]): WorkMessage[] { return spoken(events).map(({ role, at, text }) => ({ role, time: iso(at), text })) }
/** @returns the part of `text` around the first `query` match, or its start. */
function excerpt(text: string, query: string | undefined): string {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  const start = index > EXCERPT_LEAD ? Array.from(text.slice(0, index)).length - EXCERPT_LEAD : 0
  return (start ? '…' : '') + clip(Array.from(text).slice(start).join(''), EXCERPT_CHARS)
}

/** Reads Work sessions for Chat's search_work and read_work tools. */
export class WorkRecords {
  constructor(private readonly reach: () => WorkReach, private readonly settings: () => AppSettings, private readonly config: Pick<Config, 'maxWorkBytes' | 'maxWorkSessions'>) {}
  /** Whether this Harness can read Work sessions at all. */
  available(): boolean { const { query, registry } = this.reach(); return !!query && !!registry }
  /** @returns every Work workspace, most recently changed first (starting a session there changes it), or none when the registry is absent. */
  workspaces(): WorkspaceEntry[] {
    const listed = [...this.reach().registry?.list() ?? []].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    return listed.map(item => ({ id: brandString<WorkspaceRef>(item.id), title: item.title, path: item.path }))
  }
  /** @returns the workspaces Chat may read now: none unless Work Records is on and available. */
  allowed(): WorkspaceEntry[] {
    const settings = this.settings()
    if (!settings.workRecords || !this.available()) return []
    const ids = new Set<string>(settings.workWorkspaces)
    return this.workspaces().filter(item => ids.has(item.id))
  }
  /** Whether a reply may use the Work tools. */
  on(): boolean { return this.allowed().length > 0 }

  /**
   * Newest top-level sessions of the allowed workspaces first; at most `maxWorkSessions` are read.
   * A session matches when one of its messages from the person or the agent falls in the time range and contains `query`.
   */
  async search(raw: unknown, signal: AbortSignal): Promise<WorkSearchResult> {
    const args = workSearchArgs.parse(raw)
    const { query, workspaces } = this.reachable()
    const from = instant(args.since, false)
    const to = instant(args.until, true)
    const needle = args.query ? normalized(args.query) : ''
    const records = (await query.filterSessions([{ kind: 'cwd', values: [...workspaces.keys()] }], signal)).filter(topLevel).slice(0, this.config.maxWorkSessions)
    const found: { record: SessionRecord; lastActive: number; excerpt: string }[] = []
    let unreadable = 0
    for (const record of records) {
      signal.throwIfAborted()
      if (record.formatStatus === 'migration-required') { unreadable++; continue }
      try {
        const matches = spoken((await query.readSession(record.header.id)).events).filter(item => (from === undefined || item.at >= from) && (to === undefined || item.at <= to) && (!needle || normalized(item.text).includes(needle)))
        if (!matches.length) continue
        const shown = matches.find(item => item.role === 'user') ?? matches[0]!
        found.push({ record, lastActive: matches.at(-1)!.at, excerpt: excerpt(shown.text, args.query) })
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof Error)) throw error
        unreadable++
      }
    }
    const titles = await this.titles(found.map(item => item.record.header.id), signal)
    const sessions: WorkSessionHit[] = []
    let more = false
    for (const { record, lastActive, excerpt } of found) {
      const hit = { sessionId: record.header.id, title: titles.get(record.header.id) ?? UNTITLED, workspace: workspaces.get(record.header.cwd!)!, createdAt: iso(record.header.createdAt), lastActive: iso(lastActive), excerpt }
      if (bytes({ sessions: [...sessions, hit], more: true, unreadable }) > this.config.maxWorkBytes) { more = true; break }
      sessions.push(hit)
    }
    return { sessions, ...(more ? { more: true as const } : {}), ...(unreadable ? { unreadable } : {}) }
  }

  /** One page of a session's messages; a single message longer than a quarter of the limit is cut. */
  async read(raw: unknown, signal: AbortSignal): Promise<WorkReadResult & { readonly reference: WorkReference }> {
    const args = workReadArgs.parse(raw)
    const { query, workspaces } = this.reachable()
    const sessionId = brandString<SessionId>(args.sessionId)
    const [record] = (await query.filterSessions([{ kind: 'id', values: [sessionId] }, { kind: 'cwd', values: [...workspaces.keys()] }], signal)).filter(topLevel)
    if (!record) throw new PersonalChatError('work-session-unavailable', 'No Work session with this id in the workspaces Chat may read; find one with search_work')
    signal.throwIfAborted()
    const all = workMessages((await query.readSession(sessionId)).events)
    const title = (await this.titles([sessionId], signal)).get(sessionId) ?? UNTITLED
    const offset = Math.min(args.offset ?? 0, all.length)
    const page: WorkReadResult = { sessionId, title, workspace: workspaces.get(record.header.cwd!)!, createdAt: iso(record.header.createdAt), total: all.length, offset, messages: [] }
    const messages: WorkMessage[] = []
    const longest = Math.floor(this.config.maxWorkBytes / 4)
    let next = offset
    for (; next < all.length; next++) {
      const message = all[next]!
      const item = Buffer.byteLength(message.text) > longest ? { ...message, text: clip(message.text, Math.floor(longest / 4)) } : message
      if (messages.length && bytes({ ...page, messages: [...messages, item], nextOffset: all.length }) > this.config.maxWorkBytes) break
      messages.push(item)
    }
    return { ...page, messages, ...(next < all.length ? { nextOffset: next } : {}), reference: { sessionId: brandString<WorkSessionRef>(sessionId), title } }
  }

  /** @returns the query service and the allowed workspaces by path; refuses while Work Records is off. */
  private reachable(): { readonly query: NonNullable<WorkReach['query']>; readonly workspaces: ReadonlyMap<string, string> } {
    const query = this.reach().query
    const allowed = this.allowed()
    if (!query || !allowed.length) throw new PersonalChatError('work-records-off', 'Reading Work sessions is turned off')
    return { query, workspaces: new Map(allowed.map(item => [item.path, item.title])) }
  }
  /** @returns titles by session; sessions without one, or whose title cannot be read, are left out. */
  private async titles(ids: readonly SessionId[], signal: AbortSignal): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    if (!ids.length) return titles
    for (const result of await this.reach().query!.readTitleSnapshots(ids, signal)) {
      if (result.status === 'fulfilled' && result.value.title?.title) titles.set(result.sessionId, result.value.title.title)
    }
    return titles
  }
}

/** Sessions the person started: subagent sessions stay out, as they do from Memory Lookup. */
function topLevel(record: SessionRecord): boolean { return record.header.origin !== 'subagent' && record.header.cwd !== undefined }
