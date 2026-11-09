/**
 * The composer's route and reasoning-effort control: a chip naming both, which opens the effort
 * slider above it; the route name there opens the list of routes.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, Menu, MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { routeKey, sameRoute, type EffortChoice, type ModelChoice } from '../shared/models.ts'
import type { PersonalChatKey } from './locales.ts'
import type { PersonalCommands } from './contract.ts'
import type { PersonalState } from './model.ts'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

/** Harness effort ids with product names; an adapter's own id keeps the adapter's name. */
const EFFORT_NAMES: Readonly<Record<string, PersonalChatKey>> = { off: 'effortOff', minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', xhigh: 'effortXhigh', max: 'effortMax' }
/** @param effort - one effort a route offers. @returns its product name. */
export function effortName(effort: EffortChoice, t: T): string { const key = EFFORT_NAMES[effort.id]; return key ? t(key) : effort.name }
/** @param choice - an offered route. @returns the model half of its "Provider · Model" name. */
export function shortName(choice: ModelChoice): string { return choice.name.split(' · ').at(-1) ?? choice.name }
/** @returns the offered route the next message goes with. */
export function selectedChoice(state: PersonalState): ModelChoice | undefined {
  const selected = state.selectedModel
  return selected && state.models.find(item => sameRoute(item, selected))
}
/** Efforts worth a choice: a route with one or none has nothing to pick. */
function choices(choice: ModelChoice | undefined): readonly EffortChoice[] | undefined { return choice?.efforts && choice.efforts.length > 1 ? choice.efforts : undefined }

/** Effort levels as stops on a track, from least to most; arrow keys move one stop. */
function EffortSlider({ efforts, index, onChange, t }: { efforts: readonly EffortChoice[]; index: number; onChange: (effort: EffortChoice) => void; t: T }) {
  const fill = { '--effort-fill': index / (efforts.length - 1) } as CSSProperties
  return <div className={css.effortSlider} style={fill}>
    <span className={css.effortStops} aria-hidden="true">{efforts.map((item, stop) => <i key={item.id} data-passed={stop <= index || undefined} />)}</span>
    <input type="range" min={0} max={efforts.length - 1} step={1} value={index} data-modal-autofocus aria-label={t('effortTitle')} aria-valuetext={effortName(efforts[index]!, t)}
      onChange={event => { onChange(efforts[Number(event.target.value)]!) }} />
  </div>
}

/**
 * The chip names the route and its effort; a route with no effort choice opens the route list at once.
 * Escape or a press outside closes the slider, and the route list closes once a route is picked.
 * @param props.imagesNeeded - the chat already holds images, so only routes that read them can continue it.
 * @returns the chip with whichever panel is open.
 */
export function ModelPicker({ state, commands, imagesNeeded, disabled, t }: { state: PersonalState; commands: PersonalCommands; imagesNeeded: boolean; disabled: boolean; t: T }) {
  const [open, setOpen] = useState<'effort' | 'models' | undefined>()
  const root = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: open === 'effort', anchorRef: root, panelRef: panel, side: 'top', align: 'end', gap: 8, margin: 16 })
  useDismissOnOutsidePointer(root, open === 'effort', value => { if (!value) setOpen(undefined) }, panel)
  // The panel stays hidden until it is first placed, and a hidden control cannot take focus.
  const placed = position !== null
  useEffect(() => { if (open === 'effort' && placed) panel.current?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus() }, [open, placed])
  useEffect(() => { if (disabled) setOpen(undefined) }, [disabled])
  const choice = selectedChoice(state)
  if (!choice) return <span className={css.modelChip} data-empty="true">{t(state.modelsLoading ? 'loading' : 'noModels')}</span>
  const efforts = choices(choice)
  const fallback = efforts?.find(item => item.id === choice.defaultEffort) ?? efforts?.[0]
  const effort = efforts?.find(item => item.id === state.selectedModel?.effort) ?? fallback
  const close = () => { setOpen(undefined); chip.current?.focus() }
  const items: MenuEntry[] = [{ type: 'label', id: 'title', text: t('chooseModel') }, ...state.models.map(model => {
    const blocked = imagesNeeded && !model.images
    return { id: routeKey(model), disabled: blocked, label: <span className={css.menuModel}><span>{shortName(model)}</span>{blocked && <small>{t('historyImages')}</small>}</span> }
  })]
  return <span ref={root} className={css.modelPicker}>
    <Menu open={open === 'models'} onClose={() => { setOpen(undefined) }} portal side="top" align="end" autoFocus selection="check" selectedId={routeKey(choice)} items={items}
      onSelect={id => { const next = state.models.find(model => routeKey(model) === id); if (next) commands.chooseModel(next); setOpen(undefined) }}
      anchor={<button ref={chip} type="button" className={css.modelChip} aria-label={t('chooseModel') + ' · ' + shortName(choice) + (effort ? ' · ' + effortName(effort, t) : '')} aria-haspopup={efforts ? 'dialog' : 'menu'} aria-expanded={open !== undefined} disabled={disabled}
        onClick={() => { setOpen(value => value ? undefined : efforts ? 'effort' : 'models') }}>
        <span>{shortName(choice)}</span>{effort && <span className={css.modelChipEffort}>{effortName(effort, t)}</span>}<IconChevronDownOutlineRegular size={14} />
      </button>} />
    {open === 'effort' && efforts && effort && createPortal(<MenuSurface ref={panel} role="dialog" aria-label={t('effortTitle')} className={css.effortPanel} style={position ?? { visibility: 'hidden' }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div className={css.effortHead}>
        <strong className={css.effortValue}>{effortName(effort, t)}</strong>
        <button type="button" className={css.effortRoute} aria-label={t('chooseModel') + ' · ' + shortName(choice)} onClick={() => { setOpen('models') }}><span>{shortName(choice)}</span><IconChevronRightOutlineRegular size={14} /></button>
        <button type="button" className={css.effortReset} aria-label={t('effortReset')} disabled={effort.id === fallback?.id} onClick={() => { commands.chooseEffort(undefined) }}><IconRefreshOutlineRegular size={16} /></button>
      </div>
      <EffortSlider efforts={efforts} index={efforts.indexOf(effort)} onChange={item => { commands.chooseEffort(item.id) }} t={t} />
    </MenuSurface>, document.body)}
  </span>
}
