import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { PersonalChatError } from './archive.ts'
import type { Config } from './config.ts'
import type { AppSettings } from './records.ts'
import type { PersonalDomain } from './storage.ts'
import { WorkRecords } from './work-records.ts'
import type { AppsView } from '../shared/types.ts'

/** Web search and Work crossings: what the model may use unasked, and what Chat and Work may read of each other. */
export class Apps {
  /** Work sessions Chat may read, by the settings here. */
  readonly work: WorkRecords
  private readonly listeners = new Set<() => void>()

  constructor(private readonly ctx: Context, private readonly domain: PersonalDomain, config: Pick<Config, 'maxWorkBytes' | 'maxWorkSessions'>) {
    this.work = new WorkRecords(() => ({ query: ctx.get('sessionQuery'), registry: ctx.get('workspaceRegistry') }), () => this.settings(), config)
  }
  settings(): AppSettings { return this.domain.apps.get() }
  async view(): Promise<AppsView> {
    const { webAuto, workMemory, workRecords, workWorkspaces } = this.settings()
    const allowed = new Set<string>(workWorkspaces)
    return {
      web: { available: !!this.ctx.get('web'), auto: webAuto },
      work: { memoryAvailable: this.memoryAvailable(), recordsAvailable: this.work.available(), memory: workMemory, records: workRecords, workspaces: this.work.workspaces().map(item => ({ ...item, allowed: allowed.has(item.id) })) },
    }
  }
  /** Whether this Harness runs Work agents that Memory Lookup can be offered to. */
  memoryAvailable(): boolean { return !!this.ctx.get('tools') && !!this.ctx.get('agents') }
  /** Save a change, then tell every watcher. Allowed workspaces must exist in Work; repeats are dropped. */
  async update(change: Partial<AppSettings>): Promise<void> {
    if (change.workWorkspaces) {
      const known = new Set<string>(this.work.workspaces().map(item => item.id))
      if (change.workWorkspaces.some(id => !known.has(id))) throw new PersonalChatError('workspace-not-found', 'Choose workspaces that exist in Work')
      change = { ...change, workWorkspaces: [...new Set(change.workWorkspaces)] }
    }
    await this.domain.apps.set({ ...this.settings(), ...change })
    for (const listener of this.listeners) listener()
  }
  /** @param listener - runs after each saved change. @returns the unsubscribe. */
  watch(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** @param chosen - the person picked web search for this message from the tools menu. */
  webOn(chosen: boolean): boolean { return (chosen || this.settings().webAuto) && !!this.ctx.get('web') }
}
