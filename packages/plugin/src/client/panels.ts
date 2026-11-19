/** Chat's Mode and the sidebar contributions that exist only while it holds one value. */
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** A value contributions follow: its current snapshot and its change notifications. */
export interface Followed<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Whether the sidebar currently serves Chat or Work (GLOSSARY.md: Mode). */
export type Mode = 'chat' | 'work'

/** The two panel-list rows that switch Mode. */
export interface ModePanels { readonly chat: MainPanelId; readonly work: MainPanelId }

/**
 * The Mode a panel selection leaves: the Conversation and Beluga's Work row enter Work, Chat's panel enters Chat, and any other panel keeps `current`.
 * @param active - the selected main panel, or null for the Conversation.
 * @param current - the Mode before this selection.
 * @param panels - Chat's panel and Beluga's Work row.
 * @returns the Mode after it.
 */
export function modeAfter(active: MainPanelId | null, current: Mode, panels: ModePanels): Mode {
  if (active === null || active === panels.work) return 'work'
  return active === panels.chat ? 'chat' : current
}

/**
 * Hold one contribution while `source` equals `value`: `register` runs when it starts to, and its disposer runs when it stops.
 * @param source - the followed value.
 * @param value - the value that holds the contribution.
 * @param register - makes the contribution and returns its disposer.
 * @param left - runs after each disposal caused by a change of `source`.
 * @returns a disposer that stops following `source` and removes a contribution still held.
 */
export function whileValue<T>(source: Followed<T>, value: T, register: () => () => void, left?: () => void): () => void {
  let held: (() => void) | undefined
  const sync = () => {
    const matches = source.getSnapshot() === value
    if (matches && !held) held = register()
    else if (!matches && held) { held(); held = undefined; left?.() }
  }
  sync()
  const stop = source.subscribe(sync)
  return () => { stop(); held?.(); held = undefined }
}
