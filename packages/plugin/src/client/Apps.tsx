/** Web search: whether the model uses it unasked. */
import type { ReactNode } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppsView } from '../shared/types.ts'
import type { PersonalCommands } from './contract.ts'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

function AppHead({ id, icon, title, body }: { id: string; icon: ReactNode; title: string; body: string }) {
  return <div className={css.appHead}><span className={css.appIcon}>{icon}</span><div><h3 id={id}>{title}</h3><p className={css.muted}>{body}</p></div></div>
}
/** A checkbox with a label and a hint under it. @param props - state, copy and change handler. @returns the labelled checkbox. */
export function Check({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled: boolean; label: string; hint: string; onChange: (checked: boolean) => void }) {
  return <label className={css.appCheck}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => { onChange(event.target.checked) }} /><span>{label}<small>{hint}</small></span></label>
}

/** @param props - Host apps view and commands. @returns the Apps settings. */
export function AppsPage({ apps, commands, busy, t }: { apps: AppsView; commands: PersonalCommands; busy: boolean; t: T }) {
  const { web } = apps
  return <section className={css.appCard} aria-labelledby="personal-app-web">
    <AppHead id="personal-app-web" icon={<IconGlobeOutlineRegular size={20} />} title={t('webSearch')} body={t('webBody')} />
    {!web.available && <p className={css.appNote}>{t('webMissing')}</p>}
    <Check checked={web.auto} disabled={busy} label={t('appsAuto')} hint={t('webAutoHint')} onChange={webAuto => { void commands.updateApps({ webAuto }) }} />
  </section>
}
