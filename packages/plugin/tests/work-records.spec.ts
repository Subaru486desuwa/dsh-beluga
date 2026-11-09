import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { instant, workMessages, WorkRecords, type WorkReach } from '../src/host/work-records.ts'
import type { AppSettings } from '../src/host/records.ts'
import type { WorkspaceRef } from '../src/shared/types.ts'
import { ALPHA, BETA, HOUR, MORNING, fakeWork, said, workday, type FakeSession } from './work-fixtures.ts'

const signal = new AbortController().signal
const settings = (change: Partial<AppSettings> = {}): AppSettings => ({ webAuto: true, githubAuto: true, githubApproval: 'ask', workMemory: false, workRecords: true, workWorkspaces: [brandString<WorkspaceRef>(ALPHA.id)], ...change })
function records(options: { sessions?: readonly FakeSession[]; settings?: AppSettings; reach?: WorkReach; maxWorkBytes?: number; maxWorkSessions?: number } = {}) {
  const work = fakeWork(options.sessions ?? workday())
  const reach = options.reach ?? work
  return { work, records: new WorkRecords(() => reach, () => options.settings ?? settings(), { maxWorkBytes: options.maxWorkBytes ?? 24000, maxWorkSessions: options.maxWorkSessions ?? 50 }) }
}

describe('reading Work sessions for Chat', () => {
  it('reads nothing while it is off, unavailable, or no allowed workspace exists', async () => {
    for (const setup of [records({ settings: settings({ workRecords: false }) }), records({ settings: settings({ workWorkspaces: [] }) }), records({ settings: settings({ workWorkspaces: [brandString<WorkspaceRef>('w-gone')] }) }), records({ reach: {} })]) {
      expect(setup.records.on()).toBe(false)
      await expect(setup.records.search({}, signal)).rejects.toMatchObject({ reason: 'work-records-off' })
      await expect(setup.records.read({ sessionId: 's-login' }, signal)).rejects.toMatchObject({ reason: 'work-records-off' })
      expect(setup.work.reads).toEqual([])
    }
  })
  it('lists workspaces most recently changed first, and finds top-level sessions of allowed workspaces only, newest first, with their titles and an excerpt of what the person asked', async () => {
    const { records: work } = records()
    expect(work.workspaces().map(item => item.title)).toEqual(['Alpha', 'Beta'])
    expect(records({ reach: fakeWork(workday(), [BETA, ALPHA]) }).records.workspaces().map(item => item.title)).toEqual(['Alpha', 'Beta'])
    const result = await work.search({}, signal)
    expect(result.sessions.map(hit => hit.title)).toEqual(['Fix login', 'Old cleanup'])
    expect(result.sessions[0]).toEqual({ sessionId: 's-login', title: 'Fix login', workspace: 'Alpha', createdAt: new Date(MORNING).toISOString(), lastActive: new Date(MORNING + HOUR).toISOString(), excerpt: 'Fix the login token refresh' })
    expect(JSON.stringify(result)).not.toMatch(/Beta|Subagent/u)
  })
  it('narrows by words and by the person\'s local day', async () => {
    const { records: work } = records({ settings: settings({ workWorkspaces: [brandString<WorkspaceRef>(ALPHA.id), brandString<WorkspaceRef>(BETA.id)] }) })
    expect((await work.search({ query: 'LOGIN' }, signal)).sessions.map(hit => hit.sessionId)).toEqual(['s-beta', 's-login'])
    expect((await work.search({ since: '2026-11-09', until: '2026-11-09' }, signal)).sessions.map(hit => hit.sessionId)).toEqual(['s-beta', 's-login'])
    expect((await work.search({ until: '2026-11-08' }, signal)).sessions.map(hit => hit.sessionId)).toEqual(['s-old'])
    await expect(work.search({ since: 'yesterday' }, signal)).rejects.toMatchObject({ reason: 'invalid-tool-arguments' })
    const long = { header: workday()[0]!.header, title: 'Long', events: [said('user', 'Context '.repeat(50) + 'the needle sits here' + ' tail'.repeat(100), MORNING, 0)] } as FakeSession
    const [hit] = (await records({ sessions: [long] }).records.search({ query: 'NEEDLE' }, signal)).sessions
    expect(hit!.excerpt).toMatch(/^…/u)
    expect(hit!.excerpt).toContain('the needle sits here')
    expect(Array.from(hit!.excerpt).length).toBeLessThanOrEqual(302)
    expect(instant('2026-11-09', false)).toBe(new Date(2026, 10, 9).getTime())
    expect(instant('2026-11-09', true)).toBe(new Date(2026, 10, 10).getTime() - 1)
    expect(instant('2026-11-09T08:00:00Z', false)).toBe(Date.UTC(2026, 10, 9, 8))
  })
  it('reads only the newest sessions it is allowed, counts the ones it could not read, and stops at the byte limit', async () => {
    const sessions = [...workday(), { header: { ...workday()[0]!.header, id: brandString('s-broken'), createdAt: MORNING + 3 * HOUR }, events: [], unreadable: true } as FakeSession]
    const capped = records({ sessions, maxWorkSessions: 2 })
    expect(await capped.records.search({}, signal)).toEqual({ sessions: [expect.objectContaining({ sessionId: 's-login' })], unreadable: 1 })
    expect(capped.work.reads).toEqual(['s-broken', 's-login'])
    const small = await records({ maxWorkBytes: 1024 }).records.search({}, signal)
    expect(small.sessions.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(1024)
    const many = Array.from({ length: 12 }, (_, index) => ({ header: { ...workday()[0]!.header, id: brandString('s-' + index), createdAt: MORNING + index }, title: 'Session ' + index, events: [said('user', 'Task '.repeat(40) + index, MORNING + index, 0)] }) as FakeSession)
    const more = await records({ sessions: many, maxWorkBytes: 2048 }).records.search({}, signal)
    expect(more.more).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(more))).toBeLessThanOrEqual(2048)
  })
  it('reads what the person and the agent said in one session, page by page, without tool calls or notices', async () => {
    const { records: work } = records()
    const page = await work.read({ sessionId: 's-login' }, signal)
    expect(page.messages).toEqual([
      { role: 'user', time: new Date(MORNING + 1000).toISOString(), text: 'Fix the login token refresh' },
      { role: 'assistant', time: new Date(MORNING + 2000).toISOString(), text: 'Reading the auth module' },
      { role: 'assistant', time: new Date(MORNING + HOUR).toISOString(), text: 'Fixed the token refresh and added a test' },
    ])
    expect(page).toMatchObject({ title: 'Fix login', workspace: 'Alpha', total: 3, offset: 0, reference: { sessionId: 's-login', title: 'Fix login' } })
    expect(page.nextOffset).toBeUndefined()
    const long = { header: workday()[0]!.header, title: 'Long', events: Array.from({ length: 30 }, (_, index) => said(index % 2 ? 'assistant' : 'user', 'Line '.repeat(60) + index, MORNING + index, index)) } as FakeSession
    const paged = records({ sessions: [long], maxWorkBytes: 2048 }).records
    const first = await paged.read({ sessionId: 's-login' }, signal)
    expect(first.nextOffset).toBe(first.messages.length)
    expect(Buffer.byteLength(JSON.stringify({ ...first, reference: undefined }))).toBeLessThanOrEqual(2048)
    const second = await paged.read({ sessionId: 's-login', offset: first.nextOffset }, signal)
    expect(second.offset).toBe(first.nextOffset)
    expect(second.messages[0]!.text).toContain(String(first.nextOffset))
  })
  it('refuses a session in a workspace Chat may not read, or one a subagent ran', async () => {
    const { records: work } = records()
    for (const sessionId of ['s-beta', 's-helper', 's-missing']) await expect(work.read({ sessionId }, signal)).rejects.toMatchObject({ reason: 'work-session-unavailable' })
    await expect(work.read({ sessionId: 's-login', extra: true }, signal)).rejects.toThrow()
  })
  it('keeps the person\'s and the agent\'s text blocks, in order', () => {
    expect(workMessages([said('notice', 'Injected', 1, 0), said('user', '  ', 2, 1), said('user', 'Asked', 3, 2), said('assistant', 'Answered', 4, 3, 'bash')]).map(item => item.text)).toEqual(['Asked', 'Answered'])
  })
})
