// @vitest-environment jsdom
/** Chat's Mode through the client plugin's `apply`, with recording slot, layout, locale, Remote, and primary action services. */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply, inject } from '../src/client/index.ts'
import type { NavigationInjected, PersonalInjected, SidebarPrimaryAction } from '../src/client/contract.ts'
import type { PersonalState } from '../src/client/model.ts'
import type { StartMode } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./primitives-mock.tsx')).primitives())

const CHAT = 'personal-chat' as MainPanelId
const WORK_ROW = 'personal-chat.work' as MainPanelId
const PLUGINS = 'plugins' as MainPanelId
const fibers = new Set<{ dispose(): unknown }>()
afterEach(async () => {
  for (const fiber of fibers) await fiber.dispose()
  fibers.clear()
})

interface Entry { readonly options: { readonly name: string; readonly key?: MainPanelId; readonly id?: MainPanelId; readonly order?: number; readonly inject?: (actions: object) => object } }
/**
 * Live slot registrations, owned by each caller's fiber as Harness's registry owns them. Harness 0.2.1-rc.3 publishes its registry only as a browser
 * loader bundle, so the declared slots here are the ones Chat registers into and every `inject` callback runs at once.
 */
class RecordingSlots extends Service {
  private readonly live: Entry[] = []
  constructor(ctx: Context) { super(ctx, 'slots') }
  inject(key: string, callback: () => () => void): () => void { return this.ctx.effect(callback, `recording slots: ${key}`) }
  register(options: Entry['options']): () => void {
    return this.ctx.effect(() => { const entry = { options }; this.live.push(entry); return () => { this.live.splice(this.live.indexOf(entry), 1) } }, `recording slots: ${options.name}`)
  }
  entries(key: string): readonly Entry[] { return this.live.filter(entry => entry.options.name === key) }
}

/** Work's navigation service as Harness 0.2.1-rc.3 provides it: a Cordis service whose callers each see it through their own proxy. */
class RecordingWork extends Service {
  readonly calls: unknown[][] = []
  constructor(ctx: Context) { super(ctx, 'uiWorkspace') }
  startSession(...args: unknown[]): void { this.calls.push(args) }
}

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
/** Answers Chat's startup reads; `memoryState` is held by `memory` so a test can keep Chat busy. */
function personalRemote(startMode: StartMode, memory: () => Promise<unknown>) {
  const idle = (signal: AbortSignal) => ({ async *[Symbol.asyncIterator]() { await new Promise(resolve => { signal.addEventListener('abort', resolve) }) } })
  const answers: Record<string, () => Promise<unknown>> = {
    startMode: () => ok(startMode), list: () => ok([]), limits: () => ok({ uploadBytes: 1, attachmentBytes: 1, profileBytes: 1, archiveBytes: 1, zipEntries: 1, office: false }),
    models: () => ok([]), apps: () => ok(undefined), memoryState: async () => ({ ok: true, value: await memory() }),
  }
  const memoryState = vi.fn(answers.memoryState!)
  return { memoryState, remote: new Proxy({}, { get: (_, key: string) => key === 'follow' ? idle : key === 'followConversation' ? (_request: unknown, signal: AbortSignal) => idle(signal) : key === 'memoryState' ? memoryState : answers[key] ?? (() => new Promise(() => {})) }) }
}

async function bench(options: { startMode?: StartMode; seat?: boolean; work?: boolean; selected?: MainPanelId | null; memory?: () => Promise<unknown> } = {}) {
  const ctx = new Context()
  const panelInfo = createSnapshotStore<{ activePanelId: MainPanelId | null }>({ activePanelId: null }, { flush: 'sync' })
  const recorder = new RecordingSlots(ctx)
  const slots = () => recorder
  const selectPanel = vi.fn((activePanelId: MainPanelId | null) => {
    if (activePanelId !== null && !slots().entries('main').some(entry => entry.options.key === activePanelId)) throw new Error(`main panel "${activePanelId}" is not registered`)
    panelInfo.set({ activePanelId })
  })
  ctx.provide('layout', { panelInfo, selectPanel } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  const remote = personalRemote(options.startMode ?? 'chat', options.memory ?? (async () => ({ candidates: [] })))
  ctx.provide('remote', { $mount: async () => () => {}, personalChat: remote.remote } as never)
  ctx.provide('remote.personalChat', remote.remote as never)
  const actions: SidebarPrimaryAction[] = []
  if (options.seat ?? true) ctx.provide('sidebarPrimaryAction', { register: (action: SidebarPrimaryAction) => { actions.push(action); return () => { actions.splice(actions.indexOf(action), 1) } } } as never)
  const work = options.work ?? true ? new RecordingWork(ctx) : undefined
  // A Harness panel that is neither Chat nor Work, such as Plugins.
  slots().register({ name: 'main', key: PLUGINS })
  if (options.selected !== undefined) panelInfo.set({ activePanelId: options.selected })
  const fiber = ctx.plugin({ inject, apply })
  fibers.add(fiber)
  await fiber.await()
  const select = (id: MainPanelId | null) => { selectPanel(id); selectPanel.mockClear() }
  const region = () => slots().entries('sidebar.workspaces').length > 0
  const regionFace = () => (slots().entries('sidebar.workspaces')[0]!.options.inject! as (actions: object) => NavigationInjected)({ setOrder: () => {} })
  const state = (): PersonalState => (slots().entries('main').find(entry => entry.options.key === CHAT)!.options.inject! as (actions: object) => PersonalInjected)({ select: () => {} }).hooks.personal.getSnapshot()
  return { ctx, slots, fiber, panelInfo, selectPanel, select, actions, region, regionFace, state, memoryState: remote.memoryState, work }
}

describe('Chat Mode', () => {
  it('lands on Chat once at launch when the start mode is chat, then offers New chat as the primary action', async () => {
    const b = await bench()
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(CHAT)
    expect(b.actions.map(action => action.id)).toEqual(['personal-chat.new'])
    expect(b.region()).toBe(true)
  })

  it('selects nothing at launch when the start mode is work, and Work keeps New Session', async () => {
    const b = await bench({ startMode: 'work' })
    expect(b.selectPanel).not.toHaveBeenCalled()
    expect(b.actions).toEqual([])
    expect(b.region()).toBe(false)
  })

  it('does not pull a page already open at launch into Chat, but serves it in the start mode', async () => {
    const b = await bench({ selected: PLUGINS })
    expect(b.selectPanel).not.toHaveBeenCalled()
    expect(b.actions).toHaveLength(1)
    expect(b.region()).toBe(true)
  })

  it('lists Chat ahead of Work in the panel list', async () => {
    const b = await bench()
    const order = (id: MainPanelId) => b.slots().entries('sidebar.panellist').find(entry => entry.options.id === id)!.options.order!
    expect(order(CHAT)).toBeLessThan(order(WORK_ROW))
  })

  it('leaves Chat Mode for the Conversation or the Work row and keeps it on other pages', async () => {
    const b = await bench()
    b.select(PLUGINS)
    expect(b.actions).toHaveLength(1)
    expect(b.region()).toBe(true)
    b.select(null)
    expect(b.actions).toEqual([])
    expect(b.region()).toBe(false)
    b.select(PLUGINS)
    expect(b.region()).toBe(false)
    b.select(CHAT)
    expect(b.actions).toHaveLength(1)
    b.select(WORK_ROW)
    expect(b.actions).toEqual([])
    expect(b.region()).toBe(false)
  })

  it('returns to Chat\'s page and starts a normal chat when New chat runs from another page', async () => {
    const b = await bench()
    b.select(PLUGINS)
    const before = b.state().navigation
    b.actions[0]!.run()
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(CHAT)
    await vi.waitFor(() => { expect(b.state().busy).toBe(false) })
    expect(b.state()).toMatchObject({ draftTemporary: false, navigation: before + 1 })
    expect(b.memoryState).toHaveBeenCalled()
  })

  it('returns to Chat\'s page when the region opens a chat from another page', async () => {
    const b = await bench()
    b.select(PLUGINS)
    void b.regionFace().commands.create(true)
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(CHAT)
  })

  it('blocks New chat with a reason while Chat is busy', async () => {
    const held: (() => void)[] = []
    const release = () => { for (const resolve of held.splice(0)) resolve() }
    const b = await bench({ memory: () => new Promise(resolve => { held.push(() => { resolve({ candidates: [] }) }) }) })
    const blocked = b.actions[0]!.blocked!
    expect(blocked.getSnapshot()).toBeNull()
    const changed = vi.fn()
    blocked.subscribe(changed)
    b.actions[0]!.run()
    expect(blocked.getSnapshot()).toBe('newChatBusy')
    expect(changed).toHaveBeenCalled()
    // New chat reads memory after an await, so release each read as it arrives.
    await vi.waitFor(() => { release(); expect(blocked.getSnapshot()).toBeNull() })
  })

  it('keeps New chat in the region only while neither the primary action nor New Session carries it', async () => {
    expect((await bench({ seat: false, work: false })).regionFace().hooks.seated.getSnapshot()).toBe(false)
    expect((await bench({ seat: false })).regionFace().hooks.seated.getSnapshot()).toBe(true)
    expect((await bench({ work: false })).regionFace().hooks.seated.getSnapshot()).toBe(true)
  })

  it('starts a normal chat from New Session on Chat\'s page when Harness offers no primary action', async () => {
    const b = await bench({ seat: false })
    const temporary = b.regionFace().commands.create(true)
    await temporary
    const before = b.state().navigation
    // The sidebar's button calls through its own service proxy with an empty workspace; the shortcut calls the instance itself.
    b.ctx.get('uiWorkspace')!.startSession(undefined)
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ busy: false, draftTemporary: false, navigation: before + 1 }) })
    b.work!.startSession()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ busy: false, navigation: before + 2 }) })
    expect(b.work!.calls).toEqual([])
  })

  it('leaves New Session to Work for a target, on other pages, and on a Harness with the primary action', async () => {
    const stock = await bench({ seat: false })
    const target = 'w-alpha'
    stock.work!.startSession(target, { prompt: 'brief' })
    stock.select(PLUGINS)
    stock.work!.startSession()
    expect(stock.work!.calls).toEqual([[target, { prompt: 'brief' }], []])
    const seated = await bench()
    seated.work!.startSession()
    expect(seated.work!.calls).toEqual([[]])
  })

  it('releases its primary action, region, and selection when the plugin is disposed', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(Object.hasOwn(b.work!, 'startSession')).toBe(false)
    expect(b.actions).toEqual([])
    expect(b.region()).toBe(false)
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()
  })
})
