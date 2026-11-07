/** Reviewed profile, candidate approval, correction and forget controls. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Memory, MemorySource, MemoryCandidate, MemoryState, PersonalProfile } from '../shared/types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalCommands } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import { parseMemoryImport } from './memory-import.ts'
import css from './PersonalChat.module.css'

const reasons: Record<MemoryCandidate['reason'], PersonalChatKey> = { review: 'reasonReview', 'low-risk': 'reasonLowRisk', explicit: 'reasonExplicit', sensitive: 'reasonSensitive', inference: 'reasonInference', conflict: 'reasonConflict', archive: 'reasonArchive', suppressed: 'reasonSuppressed' }

function ProfileForm({ profile, commands, busy, t }: { profile: PersonalProfile; commands: PersonalCommands; busy: boolean; t: TranslateNS<'personalChat'> }) {
  const [draft, setDraft] = useState(profile)
  const [fileError, setFileError] = useState(false)
  const [importTarget, setImportTarget] = useState<'background' | 'instructions'>('instructions')
  return <form className={css.profileForm} onSubmit={event => { event.preventDefault(); void commands.updateProfile(draft) }}>
    <h2>{t('profile')}</h2>
    <label>{t('background')}<textarea className={css.textarea} value={draft.background} onChange={event => { setDraft({ ...draft, background: event.target.value }) }} /></label>
    <label>{t('instructions')}<textarea className={css.textarea} value={draft.instructions} onChange={event => { setDraft({ ...draft, instructions: event.target.value }) }} /></label>
    <label>{t('importEntry')}<select value={importTarget} onChange={event => { setImportTarget(event.target.value as 'background' | 'instructions') }}><option value="instructions">{t('instructions')}</option><option value="background">{t('background')}</option></select></label>
    <label className={css.filePicker}>{t('importInstructions')}<input type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file === undefined) return
      if (file.size > 1024 * 1024) { setFileError(true); return }
      setFileError(false)
      void file.text().then(text => { setDraft(current => ({ ...current, [importTarget]: text, source: { fileName: file.name, kind: file.name.toLowerCase() === 'agents.md' ? 'agents' : importTarget === 'background' ? 'profile' : 'custom-instructions', scope: 'personal' } })) }).catch(() => { setFileError(true) })
    }} /></label>
    {draft.source?.kind === 'agents' && <p className={css.notice}>{t('agentsReview')}</p>}
    {draft.source && <p className={css.muted}>{t('importedFrom', { name: draft.source.fileName })} · {t('personalScope')}</p>}
    {fileError && <p role="alert" className={css.notice}>{t('failed')}</p>}
    <label className={css.check}><input type="checkbox" checked={draft.autoSaveLowRisk} onChange={event => { setDraft({ ...draft, autoSaveLowRisk: event.target.checked }) }} />{t('autoSave')}</label>
    <label className={css.check}><input type="checkbox" checked={draft.referenceChats} onChange={event => { setDraft({ ...draft, referenceChats: event.target.checked }) }} />{t('referenceChats')}</label>
    <Button type="submit" variant="primary" disabled={busy}>{t('profileSave')}</Button>
  </form>
}

/** Show authoritative revisions; sensitive and inferred candidates always need an explicit action. @param props - Host memory snapshot and commands. @returns management page. */
export function MemoryPage({ memory, commands, busy, canAdd, t }: { canAdd: boolean; memory: MemoryState; commands: PersonalCommands; busy: boolean; t: TranslateNS<'personalChat'> }) {
  const [addition, setAddition] = useState<{ text: string; category: Memory['category']; source: MemorySource } | undefined>()
  const [imported, setImported] = useState<readonly { text: string; category: Memory['category'] }[]>([])
  const [importError, setImportError] = useState(false)
  const [importIndex, setImportIndex] = useState(0)
  const [editing, setEditing] = useState<{ memory: Memory; text: string } | undefined>()
  const candidates = memory.candidates.filter(candidate => candidate.state === 'pending')
  const active = memory.memories.filter(item => item.state === 'active')
  return <div className={css.management}>
    <ProfileForm key={memory.profile.revision} profile={memory.profile} commands={commands} busy={busy} t={t} />
    {candidates.length > 0 && <section><h2>{t('candidates')}</h2><ul className={css.recordList}>{candidates.map(candidate => <li key={candidate.id}>
      <p className={css.messageText}>{candidate.text}</p>{candidate.replaces && <blockquote>{t('replaces')}: {memory.memories.find(item => item.id === candidate.replaces)?.text ?? candidate.replaces}</blockquote>}
      <p className={css.muted}>{t('candidateReason', { reason: t(reasons[candidate.reason]) })}</p>
      <div className={css.rowActions}><Button size="sm" variant="outline" disabled={busy} onClick={() => { void commands.decide(candidate, 'confirm') }}>{t('confirm')}</Button><Button size="sm" disabled={busy} onClick={() => { void commands.decide(candidate, 'reject') }}>{t('reject')}</Button></div>
    </li>)}</ul></section>}
    <section><div className={css.historyHead}><h2>{t('memories')}</h2>{canAdd && <Button size="sm" disabled={busy} onClick={() => { setAddition({ text: '', category: 'fact', source: { kind: 'manual' } }); setImported([]); setImportError(false) }}>{t('addMemory')}</Button>}</div>{active.length === 0 ? <p className={css.muted}>{t('noMemories')}</p> : <ul className={css.recordList}>{active.map(item => <li key={item.id}>
      <p className={css.messageText}>{item.text}</p>
      <div className={css.messageMeta}><span>{t('personalScope')}</span><time>{new Date(item.updatedAt).toLocaleString()}</time></div>
      <details className={css.source}><summary>{t('source')}</summary><p>{item.source.kind === 'manual' ? t('sourceManual') : item.source.kind === 'chat' ? t('sourceSession') : item.source.kind === 'archive' ? t('sourceArchive') : t('importedFrom', { name: item.source.fileName })}</p>
        {item.source.kind === 'chat' && <code>{item.source.conversationId} / {item.source.messageId}</code>}
        {item.source.kind === 'archive' && <code>{item.source.revisionId} / {item.source.nodeId}</code>}
      </details>
      <div className={css.rowActions}><Button size="sm" disabled={busy} onClick={() => { setEditing({ memory: item, text: item.text }) }}>{t('memoryEdit')}</Button><Button size="sm" disabled={busy} onClick={() => { void commands.forget(item) }}>{t('forget')}</Button></div>
    </li>)}</ul>}</section>
    <Modal open={addition !== undefined} title={t('addMemory')} closeLabel={t('cancel')} onClose={() => { if (!busy) setAddition(undefined) }} footer={<>
      <Button disabled={busy} onClick={() => { setAddition(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !addition?.text.trim()} onClick={() => { if (addition) void commands.proposeMemory(addition.text, addition.category, addition.source).then(ok => { if (ok) { const remaining = imported.filter((_entry, index) => index !== importIndex); setImported(remaining); setImportIndex(0); const next = remaining[0]; setAddition(next === undefined ? undefined : { ...next, source: addition.source }) } }) }}>{t('remember')}</Button>
    </>}><label className={css.filePicker}>{t('importMemories')}<input type="file" accept=".txt,.md,.json,text/plain,application/json" onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file === undefined) return
      if (file.size > 1024 * 1024) { setImportError(true); return }
      setImportError(false)
      void file.text().then(text => {
        const entries = parseMemoryImport(file.name, text)
        setImported(entries)
        setImportIndex(0)
        const first = entries[0]
        if (first !== undefined) setAddition({ ...first, source: { kind: 'imported-text', fileName: file.name } })
      }).catch(() => { setImportError(true) })
    }} /></label><p className={css.muted}>{t('memoryImportFormat')}</p>
    {importError && <p role="alert">{t('failed')}</p>}
    {imported.length > 1 && <label>{t('importEntry')}<select value={importIndex} onChange={event => { setImportIndex(Number(event.target.value)); const entry = imported[Number(event.target.value)]; if (entry && addition) setAddition({ ...addition, ...entry }) }}>{imported.map((entry, index) => <option key={`${index}:${entry.text}`} value={index}>{entry.text.slice(0, 80)}</option>)}</select></label>}
    {addition?.source.kind === 'imported-text' && addition.source.fileName.toLowerCase() === 'agents.md' && <p className={css.notice}>{t('agentsReview')}</p>}
    {addition?.source.kind === 'imported-text' && <p className={css.muted}>{t('importedFrom', { name: addition.source.fileName })}</p>}
    <label>{t('category')}<select value={addition?.category ?? 'fact'} onChange={event => { if (addition) setAddition({ ...addition, category: event.target.value as Memory['category'] }) }}>{(['fact', 'preference', 'decision'] as const).map(category => <option key={category} value={category}>{t(category)}</option>)}</select></label><textarea className={css.textarea} aria-label={t('memoryText')} value={addition?.text ?? ''} onChange={event => { if (addition) setAddition({ ...addition, text: event.target.value }) }} /></Modal>
    <Modal open={editing !== undefined} title={t('memoryEdit')} closeLabel={t('cancel')} onClose={() => { if (!busy) setEditing(undefined) }} footer={<>
      <Button disabled={busy} onClick={() => { setEditing(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !editing?.text.trim()} onClick={() => { if (editing) void commands.editMemory(editing.memory, editing.text).then(ok => { if (ok) setEditing(undefined) }) }}>{t('save')}</Button>
    </>}><textarea className={css.textarea} aria-label={t('memoryText')} value={editing?.text ?? ''} onChange={event => { if (editing) setEditing({ ...editing, text: event.target.value }) }} /></Modal>
  </div>
}
