/** The Memory Summary at the top of the memory page, laid out like ChatGPT's memory summary. */
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, Menu, Modal, TextShimmer, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { routeKey, sameRoute, type ModelChoice } from '../shared/models.ts'
import type { MemorySummaryView } from '../shared/types.ts'
import type { PersonalCommands } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import { ArrowUpGlyph } from './icons.tsx'
import { autoGrow, useMarkdown } from './Message.tsx'
import { shortName } from './ModelPicker.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>
const FOLLOW_LAST = 'last'
const ERRORS: Readonly<Record<string, PersonalChatKey>> = { 'summary-model': 'summaryErrorModel', 'model-error': 'summaryErrorRequest', 'summary-format': 'summaryErrorFormat', 'summary-length': 'summaryErrorLength' }

/** The route that writes the summary; "follow the last chat" is the default. */
function SummaryModel({ summary, models, commands, disabled, t }: { summary: MemorySummaryView; models: readonly ModelChoice[]; commands: PersonalCommands; disabled: boolean; t: T }) {
  const [open, setOpen] = useState(false)
  const stored = summary.model
  const chosen = stored && models.find(model => sameRoute(model, stored))
  const last = models.find(model => model.lastUsed)
  const label = chosen ? shortName(chosen) : stored ? stored.model : t('summaryModelLast')
  const items: MenuEntry[] = [
    { type: 'label', id: 'title', text: t('summaryModel') },
    { id: FOLLOW_LAST, label: <span className={css.menuModel}><span>{t('summaryModelLast')}</span>{last && <small>{last.name}</small>}</span> },
    ...models.map(model => ({ id: routeKey(model), label: model.name })),
  ]
  return <Menu open={open} onClose={() => { setOpen(false) }} portal align="end" autoFocus selection="check" selectedId={chosen ? routeKey(chosen) : stored ? '' : FOLLOW_LAST} items={items}
    onSelect={id => {
      setOpen(false)
      const next = models.find(model => routeKey(model) === id)
      void commands.summaryOptions({ ...(next ? { model: { provider: next.provider, model: next.model, ...(next.inline ? { inline: true as const } : {}) } } : {}), sensitive: summary.sensitive })
    }}
    anchor={<button type="button" className={css.chip} aria-label={t('summaryModel') + ' · ' + label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setOpen(value => !value) }}>
      <span>{label}</span><IconChevronDownOutlineRegular size={14} />
    </button>} />
}

/** The summary text in an editor; Save stores it as typed, against the revision editing started from. */
function SummaryEditor({ draft, setDraft, commands, busy, t }: { draft: { readonly text: string; readonly revision: number }; setDraft: (draft?: { readonly text: string; readonly revision: number }) => void; commands: PersonalCommands; busy: boolean; t: T }) {
  const editor = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => { if (editor.current) autoGrow(editor.current, 24) }, [draft.text])
  useLayoutEffect(() => { editor.current?.focus() }, [])
  return <div className={css.summaryEditor}>
    <textarea ref={editor} className={css.field} value={draft.text} aria-label={t('summaryEditLabel')} disabled={busy} onChange={event => { setDraft({ ...draft, text: event.target.value }) }} />
    <div className={css.summaryEditorActions}>
      <Button disabled={busy} onClick={() => { setDraft(undefined) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { void commands.editSummary(draft.text, draft.revision).then(ok => { if (ok) setDraft(undefined) }) }}>{t('save')}</Button>
    </div>
  </div>
}

/**
 * @param props.enabled - whether "reference earlier chats" is on; when off the summary is kept but neither updated nor used.
 * @returns the summary card: text or its editor, follow-up prompts, and the box that asks about it or corrects it.
 */
export function MemorySummary({ summary, models, enabled, commands, busy, t }: { summary: MemorySummaryView; models: readonly ModelChoice[]; enabled: boolean; commands: PersonalCommands; busy: boolean; t: T }) {
  const markdown = useMarkdown(t)
  const [menuOpen, setMenuOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [text, setText] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<{ readonly question: string; readonly reply: string } | undefined>()
  const [draft, setDraft] = useState<{ readonly text: string; readonly revision: number } | undefined>()
  const input = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => { if (input.current) autoGrow(input.current, 6) }, [text])
  const keep = summary.model ? { model: summary.model } : {}
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const question = text.trim()
    if (!question || busy || !enabled) return
    setAsking(true)
    try {
      const reply = await commands.askSummary(question)
      if (reply === undefined) return
      setText('')
      setAnswer({ question, reply: reply || t('summaryChanged') })
    } finally { setAsking(false) }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
  }
  const menu: MenuEntry[] = [
    { id: 'edit', label: t('summaryEdit'), disabled: draft !== undefined },
    { id: 'refresh', label: t('summaryRefresh'), disabled: !enabled || summary.updating },
    // The menu marks a selected row only with a check mark, so the state is also spoken.
    { id: 'sensitive', label: <>{t('summarySensitive')}<span className={css.srOnly}>{t(summary.sensitive ? 'summaryOn' : 'summaryOffState')}</span></> },
    { id: 'undo', label: t('summaryUndo'), disabled: !summary.canUndo },
    { type: 'separator', id: 'separator' },
    { id: 'clear', label: t('summaryClear'), disabled: !summary.text },
  ]
  const error = summary.error && t('summaryFailed', { reason: t(ERRORS[summary.error] ?? 'summaryErrorOther') })
  return <section className={css.summary} aria-labelledby="personal-summary-title">
    <header className={css.summaryHead}>
      <h2 id="personal-summary-title">{t('summaryTitle')}</h2>
      <span className={css.summaryMeta} role="status">{summary.updating ? <TextShimmer>{t('summaryUpdating')}</TextShimmer> : summary.updatedAt ? t('summaryUpdated', { time: new Date(summary.updatedAt).toLocaleString() }) : ''}</span>
      <SummaryModel summary={summary} models={models} commands={commands} disabled={busy} t={t} />
      <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal align="end" autoFocus selection="check" selectedIds={summary.sensitive ? ['sensitive'] : []} items={menu}
        onSelect={id => {
          setMenuOpen(false)
          if (id === 'edit') { setAnswer(undefined); setDraft({ text: summary.text, revision: summary.revision }) }
          if (id === 'refresh') void commands.refreshSummary()
          if (id === 'sensitive') void commands.summaryOptions({ ...keep, sensitive: !summary.sensitive })
          if (id === 'undo') void commands.undoSummary()
          if (id === 'clear') setClearing(true)
        }}
        anchor={<button type="button" className={css.iconAction} aria-label={t('summaryMore')} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy} onClick={() => { setMenuOpen(value => !value) }}><IconEllipsisOutlineRegular size={20} /></button>} />
    </header>
    {!enabled && <p className={css.summaryNotice}>{t('summaryOff')}</p>}
    {error && <p className={css.summaryNotice} role="alert">{error}</p>}
    {draft ? <SummaryEditor draft={draft} setDraft={setDraft} commands={commands} busy={busy} t={t} /> : <>
      {summary.text ? <div className={css.summaryText}>{markdown(summary.text)}</div> : <p className={css.summaryEmpty}>{t('summaryEmpty')}</p>}
      {summary.suggestions.length > 0 && <section className={css.dive} aria-labelledby="personal-summary-dive">
        <h3 id="personal-summary-dive">{t('summaryDive')}</h3>
        <ul>{summary.suggestions.map(item => <li key={item}><button type="button" className={css.diveLink} disabled={busy} onClick={() => { void commands.startChat(item) }}>{item}</button></li>)}</ul>
      </section>}
      {answer && <div className={css.summaryAnswer} role="status"><p className={css.summaryQuestion}>{answer.question}</p>{markdown(answer.reply)}</div>}
      <form className={css.summaryAsk} onSubmit={event => { void submit(event) }} onClick={event => { if (event.target === event.currentTarget) input.current?.focus() }}>
        <textarea ref={input} rows={1} value={text} placeholder={t('summaryAsk')} aria-label={t('summaryAsk')} disabled={!enabled} onChange={event => { setText(event.target.value) }} onKeyDown={onKeyDown} />
        <button type="submit" className={css.sendButton} aria-label={t('send')} disabled={!text.trim() || busy || !enabled}>{asking ? <span className={css.summarySpinner} aria-hidden="true" /> : <ArrowUpGlyph />}</button>
      </form>
    </>}
    <Modal open={clearing} title={t('summaryClearTitle')} closeLabel={t('cancel')} onClose={() => { setClearing(false) }} footer={<>
      <Button onClick={() => { setClearing(false) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { setClearing(false); setAnswer(undefined); void commands.clearSummary() }}>{t('summaryClear')}</Button>
    </>}><p>{t('summaryClearBody')}</p></Modal>
  </section>
}
