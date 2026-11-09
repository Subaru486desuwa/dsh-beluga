/** Web search, connected apps and Work: whether the model uses them unasked, the GitHub account, which GitHub changes ask first, and what Chat and Work may read of each other. */
import { useState, type ReactNode } from 'react'
import { Button, IconCodeOutlineRegular, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppsView, ApprovalLevel } from '../shared/types.ts'
import type { PersonalCommands } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import { GitHubGlyph } from './icons.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>
const LEVELS: readonly { readonly level: ApprovalLevel; readonly label: PersonalChatKey; readonly hint: PersonalChatKey }[] = [
  { level: 'ask', label: 'approvalAsk', hint: 'approvalAskHint' },
  { level: 'low', label: 'approvalLow', hint: 'approvalLowHint' },
  { level: 'all', label: 'approvalAll', hint: 'approvalAllHint' },
]
/** Where GitHub makes a fine-grained token. */
const NEW_TOKEN = 'https://github.com/settings/personal-access-tokens/new'

function AppHead({ id, icon, title, body }: { id: string; icon: ReactNode; title: string; body: string }) {
  return <div className={css.appHead}><span className={css.appIcon}>{icon}</span><div><h3 id={id}>{title}</h3><p className={css.muted}>{body}</p></div></div>
}
/** A checkbox with a label and a hint under it. @param props - state, copy and change handler. @returns the labelled checkbox. */
export function Check({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled: boolean; label: string; hint: string; onChange: (checked: boolean) => void }) {
  return <label className={css.appCheck}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => { onChange(event.target.checked) }} /><span>{label}<small>{hint}</small></span></label>
}

/** @param props - Host apps view and commands. @returns the Apps settings. */
export function AppsPage({ apps, commands, busy, t }: { apps: AppsView; commands: PersonalCommands; busy: boolean; t: T }) {
  const [token, setToken] = useState('')
  const { web, github, work } = apps
  const allowed = work.workspaces.filter(item => item.allowed).map(item => item.id)
  const connect = () => { const value = token.trim(); if (value) void commands.connectGitHub({ token: value }).then(ok => { if (ok) setToken('') }) }
  return <>
    <section className={css.appCard} aria-labelledby="personal-app-web">
      <AppHead id="personal-app-web" icon={<IconGlobeOutlineRegular size={20} />} title={t('webSearch')} body={t('webBody')} />
      {!web.available && <p className={css.appNote}>{t('webMissing')}</p>}
      <Check checked={web.auto} disabled={busy} label={t('appsAuto')} hint={t('webAutoHint')} onChange={webAuto => { void commands.updateApps({ webAuto }) }} />
    </section>
    <section className={css.appCard} aria-labelledby="personal-app-github">
      <AppHead id="personal-app-github" icon={<GitHubGlyph size={20} />} title={t('github')} body={t('githubBody')} />
      {!github.installed ? <p className={css.appNote}>{t('githubMissing')}</p>
        : !github.account ? <div className={css.appConnect}>
          <Button variant="primary" disabled={busy} onClick={() => { void commands.connectGitHub({ cli: true }) }}>{t('githubCli')}</Button>
          <form className={css.appToken} onSubmit={event => { event.preventDefault(); connect() }}>
            <label>{t('githubToken')}<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => { setToken(event.target.value) }} /></label>
            <Button type="submit" disabled={busy || !token.trim()}>{t('githubConnect')}</Button>
          </form>
          <p className={css.muted}>{t('githubTokenHint')} <a href={NEW_TOKEN} target="_blank" rel="noreferrer noopener">{t('githubCreateToken')}</a></p>
        </div>
          : <>
            <div className={css.appAccount}>
              <span><strong>{t('githubConnected', { login: github.account })}</strong><small>{t(github.source === 'gh-cli' ? 'githubSourceCli' : 'githubSourceToken')}</small></span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void commands.disconnectGitHub() }}>{t('githubDisconnect')}</Button>
            </div>
            <Check checked={github.auto} disabled={busy} label={t('appsAuto')} hint={t('githubAutoHint')} onChange={githubAuto => { void commands.updateApps({ githubAuto }) }} />
            <fieldset className={css.appLevels} disabled={busy}>
              <legend>{t('approvalLevel')}</legend>
              {LEVELS.map(({ level, label, hint }) => <label key={level} className={css.appCheck}><input type="radio" name="personal-github-approval" checked={github.approval === level} onChange={() => { void commands.updateApps({ githubApproval: level }) }} /><span>{t(label)}<small>{t(hint)}</small></span></label>)}
            </fieldset>
          </>}
    </section>
    <section className={css.appCard} aria-labelledby="personal-app-work">
      <AppHead id="personal-app-work" icon={<IconCodeOutlineRegular size={20} />} title={t('workApp')} body={t('workBody')} />
      {!work.memoryAvailable && !work.recordsAvailable && <p className={css.appNote}>{t('workMissing')}</p>}
      <Check checked={work.memory} disabled={busy || !work.memoryAvailable} label={t('workMemory')} hint={t('workMemoryHint')} onChange={workMemory => { void commands.updateApps({ workMemory }) }} />
      <Check checked={work.records} disabled={busy || !work.recordsAvailable} label={t('workRecords')} hint={t('workRecordsHint')} onChange={workRecords => { void commands.updateApps({ workRecords }) }} />
      {work.records && <fieldset className={css.appLevels} disabled={busy}>
        <legend>{t('workWorkspaces')}</legend>
        {work.workspaces.length ? work.workspaces.map(item => <label key={item.id} className={css.appCheck}>
          <input type="checkbox" checked={item.allowed} onChange={event => { void commands.updateApps({ workWorkspaces: event.target.checked ? [...allowed, item.id] : allowed.filter(id => id !== item.id) }) }} />
          <span>{item.title}<small>{item.path}</small></span>
        </label>) : <p className={css.muted}>{t('workNoWorkspaces')}</p>}
        {work.workspaces.length > 0 && !allowed.length && <p className={css.appNote}>{t('workPickWorkspace')}</p>}
      </fieldset>}
    </section>
  </>
}
