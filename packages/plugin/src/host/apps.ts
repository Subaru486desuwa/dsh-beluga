import type { Context } from '@deepseek-ai/cordis'
import type { AppSettings } from './records.ts'
import type { PersonalDomain } from './storage.ts'
import type { AppsView } from '../shared/types.ts'

/** Web search: whether the model may use it unasked. */
export class Apps {
  constructor(private readonly ctx: Context, private readonly domain: PersonalDomain) {}
  settings(): AppSettings { return this.domain.apps.get() }
  async view(): Promise<AppsView> {
    return { web: { available: !!this.ctx.get('web'), auto: this.settings().webAuto } }
  }
  /** Save a change. */
  async update(change: Partial<AppSettings>): Promise<void> {
    await this.domain.apps.set({ ...this.settings(), ...change })
  }
  /** @param chosen - the person picked web search for this message from the tools menu. */
  webOn(chosen: boolean): boolean { return (chosen || this.settings().webAuto) && !!this.ctx.get('web') }
}
