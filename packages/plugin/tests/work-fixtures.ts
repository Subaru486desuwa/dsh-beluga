/**
 * Work as Harness keeps it: sessions in workspaces, read through the session-query and workspace
 * services Beluga uses. Session filtering runs Harness's own filter function, so a test sees what a
 * profile would return; `reads` lists the sessions whose logs were read.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { filterSessionResults, type SessionRecord, type SessionResultFilter } from '@deepseek-ai/dsh-session-query'
import type { WorkReach } from '../src/host/work-records.ts'

/** 09:00 on 9 November 2026 by the clock tests run under. */
export const MORNING = new Date(2026, 10, 9, 9).getTime()
export const HOUR = 3600000

export interface FakeSession { readonly header: SessionHeader; readonly title?: string; readonly events: readonly SessionEvent[]; readonly unreadable?: boolean }
export interface FakeWorkspace { readonly id: string; readonly title: string; readonly path: string; readonly updatedAt: string }

export const ALPHA: FakeWorkspace = { id: 'w-alpha', title: 'Alpha', path: '/projects/alpha', updatedAt: '2026-11-09T01:00:00.000Z' }
export const BETA: FakeWorkspace = { id: 'w-beta', title: 'Beta', path: '/projects/beta', updatedAt: '2026-11-08T01:00:00.000Z' }

/** @returns a session header in `cwd`, created at `createdAt`. */
export function header(id: string, cwd: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 4, id: brandString<SessionId>(id), createdAt, cwd, isSeeded: false, ...extra } as SessionHeader
}
/** @returns one logged message: the person's, the agent's (optionally with a tool call), or a notice the Harness added. */
export function said(role: 'user' | 'assistant' | 'notice', text: string, time: number, seq: number, toolCall?: string): SessionEvent {
  const content = [{ type: 'text', text }]
  if (role === 'assistant') return { type: 'assistant/message', seq, time, data: { turn: 1, step: 1, message: { id: 'm' + seq, role: 'assistant', content: toolCall ? [...content, { type: 'tool-call', id: 't' + seq, name: toolCall, arguments: '{}' }] : content, source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } } as unknown as SessionEvent
  return { type: 'user/message', seq, time, data: { id: 'm' + seq, role: 'user', content, source: { kind: role === 'user' ? 'user' : 'notice' } } } as unknown as SessionEvent
}

/** @returns services over `sessions`, newest first as Harness lists them, and the workspace registry. */
export function fakeWork(sessions: readonly FakeSession[], workspaces: readonly FakeWorkspace[] = [ALPHA, BETA]): Required<WorkReach> & { readonly reads: string[] } {
  const reads: string[] = []
  const find = (id: SessionId): FakeSession => {
    const session = sessions.find(item => item.header.id === id)
    if (!session) throw new Error('No session ' + id)
    return session
  }
  const records = (): SessionRecord[] => sessions.map(session => ({ header: session.header, live: false, persisted: true })).sort((left, right) => right.header.createdAt - left.header.createdAt)
  const query = {
    filterSessions: async (filters: readonly SessionResultFilter[]) => filterSessionResults(records(), filters),
    readSession: async (id: SessionId) => {
      reads.push(id)
      const session = find(id)
      if (session.unreadable) throw new Error('The log could not be replayed')
      return { session: session.header, inheritedEventCount: 0, events: [...session.events] }
    },
    readTitleSnapshots: async (ids: readonly SessionId[]) => ids.map(id => {
      const session = find(id)
      return { sessionId: id, status: 'fulfilled' as const, value: { session: session.header, ...(session.title ? { title: { title: session.title, eventSeq: 0, updatedAt: 0 } } : {}) } }
    }),
  } as unknown as NonNullable<WorkReach['query']>
  return { query, registry: { list: () => workspaces.map(item => ({ ...item })) } as unknown as NonNullable<WorkReach['registry']>, reads }
}

/** Three sessions in Alpha (one a subagent's), one in Beta. */
export function workday(): FakeSession[] {
  return [
    { header: header('s-login', ALPHA.path, MORNING), title: 'Fix login', events: [said('notice', 'Goal reminder', MORNING, 0), said('user', 'Fix the login token refresh', MORNING + 1000, 1), said('assistant', 'Reading the auth module', MORNING + 2000, 2, 'read_file'), said('assistant', 'Fixed the token refresh and added a test', MORNING + HOUR, 3)] },
    { header: header('s-old', ALPHA.path, MORNING - 48 * HOUR), title: 'Old cleanup', events: [said('user', 'Remove dead code', MORNING - 48 * HOUR, 0), said('assistant', 'Removed it', MORNING - 47 * HOUR, 1)] },
    { header: header('s-helper', ALPHA.path, MORNING + 2 * HOUR, { origin: 'subagent', parentSession: brandString<SessionId>('s-login') }), title: 'Helper', events: [said('user', 'Subagent task about login', MORNING + 2 * HOUR, 0)] },
    { header: header('s-beta', BETA.path, MORNING + HOUR), title: 'Beta plans', events: [said('user', 'Plan the beta login page', MORNING + HOUR, 0)] },
  ]
}
