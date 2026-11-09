/** A chat as turns: the person's message, then one reply with its thinking, to-do list, files, memory proposals and sources. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCheckCircleFillRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconDeliverDocRegular, IconDownloadOutlineRegular, IconEditOutlineRegular, IconFullscreenOutlineRegular, IconGlobeOutlineRegular, IconPersonalizationOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, ImageLightbox, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatAttachment, ConversationDetail, LiveTurn, Memory, MemoryCandidate, MemoryState, TodoItem } from '../shared/types.ts'
import type { PersonalState } from './model.ts'
import type { PersonalCommands } from './contract.ts'
import type { PersonalChatKey } from './locales.ts'
import { decodeBase64, saveFile } from './export.ts'
import { FilePreview } from './Preview.tsx'
import { speakable } from './markdown.ts'
import { turnsOf, variantsOf, type ChatTurn, type Variants } from './turns.ts'
import { ActionButton, CopyButton, UserBubble, autoGrow, useMarkdown } from './Message.tsx'
import { FileTile, officeFile } from './Composer.tsx'
import { CANDIDATE_REASONS } from './Memory.tsx'
import { ArrowDownGlyph, SpeakerGlyph, StopGlyph } from './icons.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

/** What a running tool is doing, in words; a tool not listed is just "working". */
const TOOL_STATUS: Readonly<Record<string, PersonalChatKey>> = {
  web_search: 'toolWebSearch', web_fetch: 'toolWebFetch', create_document: 'toolDocument', edit_document: 'toolDocument', fill_template: 'toolDocument',
  create_workbook: 'toolWorkbook', edit_workbook: 'toolWorkbook', create_presentation: 'toolPresentation', read_sheet: 'toolReadFile', read_attachment: 'toolReadFile',
  memory_propose: 'toolMemory', memory_recall: 'toolMemory', search_chats: 'toolSearchChats', todo_write: 'toolPlanning',
}
const toolStatus = (tool: string): PersonalChatKey => TOOL_STATUS[tool] ?? 'toolWorking'

/**
 * Memories this turn proposed: one waiting is saved or dismissed here, and one saved can be undone.
 * A candidate dismissed or a memory forgotten elsewhere leaves the list.
 */
function MemoryProposals({ turn, memory, busy, commands, t }: { turn: ChatTurn; memory: MemoryState | undefined; busy: boolean; commands: PersonalCommands; t: T }) {
  const rows = turn.proposed.flatMap((id): { candidate: MemoryCandidate; saved: Memory | undefined }[] => {
    const candidate = memory?.candidates.find(item => item.id === id)
    if (candidate?.state === 'pending') return [{ candidate, saved: undefined }]
    const saved = candidate?.state === 'saved' ? memory!.memories.find(item => item.id === candidate.memoryId) : undefined
    return candidate && saved ? [{ candidate, saved }] : []
  })
  if (!rows.length) return null
  return <section className={css.proposals} aria-label={t('memoryTitle')}>
    {rows.map(({ candidate, saved }) => <div key={candidate.id} className={css.proposal}>
      <IconPersonalizationOutlineRegular size={18} />
      <span className={css.proposalText}><small>{saved ? t('memoryUpdated') : t('candidateReason', { reason: t(CANDIDATE_REASONS[candidate.reason]) })}</small><span>{saved?.text ?? candidate.text}</span></span>
      <div className={css.rowActions}>
        {saved ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void commands.forget(saved) }}>{t('memoryUndo')}</Button>
          : <><Button size="sm" variant="outline" disabled={busy} onClick={() => { void commands.decide(candidate, 'reject') }}>{t('reject')}</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => { void commands.decide(candidate, 'confirm') }}>{t('confirm')}</Button></>}
      </div>
    </div>)}
  </section>
}

/**
 * What the turn drew on: web pages, Saved Memories and earlier chats. The Memory Summary and
 * custom instructions go with every reply and are not listed; a forgotten memory leaves the list.
 */
function Sources({ turn, memory, commands, t }: { turn: ChatTurn; memory: MemoryState | undefined; commands: PersonalCommands; t: T }) {
  const memories = turn.recalled.flatMap(id => memory?.memories.find(item => item.id === id) ?? [])
  if (!turn.sources.length && !memories.length && !turn.referenced.length && !turn.work.length) return null
  return <nav className={css.sources} aria-label={t('sources')}>
    {turn.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer noopener"><IconGlobeOutlineRegular size={14} /><span>{source.title || new URL(source.url).hostname}</span></a>)}
    {memories.map(item => <span key={item.id} title={item.text}><IconPersonalizationOutlineRegular size={14} /><span><span className={css.srOnly}>{t('sourceMemory')}</span>{item.text}</span></span>)}
    {turn.referenced.map(chat => <button key={chat.conversationId} type="button" onClick={() => { void commands.open(chat.conversationId) }}><IconSearchOutlineRegular size={14} /><span><span className={css.srOnly}>{t('sourceChat')}</span>{chat.title || t('newChat')}</span></button>)}
    {turn.work.map(session => <button key={session.sessionId} type="button" onClick={() => { commands.openWork(session.sessionId) }}><IconCodeOutlineRegular size={14} /><span><span className={css.srOnly}>{t('sourceWork')}</span>{session.title}</span></button>)}
  </nav>
}

function FileView({ file, renderable, commands, t }: { file: ChatAttachment; renderable: boolean; commands: PersonalCommands; t: T }) {
  const [image, setImage] = useState<string | undefined>()
  const [enlarged, setEnlarged] = useState(false)
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const office = renderable && officeFile(file.name)
  const currentCommands = useRef(commands)
  currentCommands.current = commands
  useEffect(() => {
    let active = true
    if (file.image) void currentCommands.current.attachment(file.id).then(result => { if (active) setImage('data:' + result.mediaType + ';base64,' + result.base64) }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [file.id, file.image])
  const download = async () => {
    const result = await commands.attachment(file.id, true)
    saveFile(result.name, new Blob([decodeBase64(result.base64)], { type: result.mediaType }))
  }
  const exportPdf = async () => {
    setExporting(true)
    try {
      const result = await commands.exportPdf(file.id)
      saveFile(result.name, new Blob([decodeBase64(result.base64)], { type: 'application/pdf' }))
    } catch { setFailed(true) } finally { setExporting(false) }
  }
  if (file.image && image) return <>
    <button type="button" className={css.imageThumb} aria-label={t('imagePreview') + ' · ' + file.name} onClick={() => { setEnlarged(true) }}><img src={image} alt={file.name} /></button>
    {enlarged && <ImageLightbox src={image} alt={file.name} labels={{ dialog: t('imagePreview'), close: t('close') }} onClose={() => { setEnlarged(false) }} />}
  </>
  const note = file.artifact ? t('artifactVersion', { version: file.artifact.version }) : t('inputFile')
  return <div className={css.fileCard}>
    <FileTile name={file.name} note={note} t={t} />
    <div className={css.fileActions}>
      <ActionButton label={t('download')} onClick={() => { void download().catch(() => setFailed(true)) }}><IconDownloadOutlineRegular size={18} /></ActionButton>
      {office && <ActionButton label={t('previewFile')} onClick={() => setPreviewing(true)}><IconFullscreenOutlineRegular size={18} /></ActionButton>}
      {office && <ActionButton label={t(exporting ? 'loading' : 'exportPdf')} disabled={exporting} onClick={() => { void exportPdf() }}><IconDeliverDocRegular size={18} /></ActionButton>}
    </div>
    {file.artifact && <small className={css.fileSummary}>{file.artifact.summary}</small>}
    {failed && <span className={css.fileError} role="alert">{t('failed')}</span>}
    {previewing && <FilePreview file={file} commands={commands} onClose={() => setPreviewing(false)} t={t} />}
  </div>
}
function Files({ ids, detail, renderable, commands, t }: { ids: readonly string[]; detail: ConversationDetail; renderable: boolean; commands: PersonalCommands; t: T }) {
  const files = [...new Set(ids)].map(id => detail.attachments.find(item => item.id === id)).filter(file => file !== undefined)
  return files.length ? <div className={css.files}>{files.map(file => <FileView key={file.id} file={file} renderable={renderable} commands={commands} t={t} />)}</div> : null
}

/** A network voice would send the reply to the browser vendor, so only voices on this device count. */
function localVoice(text: string): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in globalThis)) return undefined
  const language = /\p{Script=Han}/u.test(text) ? 'zh' : navigator.language.split('-')[0]!
  return speechSynthesis.getVoices().find(voice => voice.localService && voice.lang.toLowerCase().startsWith(language))
}
function ReadAloud({ text, t }: { text: string; t: T }) {
  const [reading, setReading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const spoken = useRef<SpeechSynthesisUtterance | undefined>(undefined)
  useEffect(() => {
    // Browsers load their voice list on first request, which a first press would otherwise miss.
    if ('speechSynthesis' in globalThis) speechSynthesis.getVoices()
    return () => { if (spoken.current) speechSynthesis.cancel() }
  }, [])
  const finish = () => { spoken.current = undefined; setReading(false) }
  const toggle = () => {
    if (reading) { speechSynthesis.cancel(); finish(); return }
    const voice = localVoice(text)
    setUnavailable(!voice)
    if (!voice) return
    const utterance = new SpeechSynthesisUtterance(speakable(text))
    utterance.voice = voice
    utterance.lang = voice.lang
    utterance.onend = finish
    utterance.onerror = finish
    spoken.current = utterance
    // Replaces another reply being read; the browser would otherwise queue this one behind it.
    speechSynthesis.cancel()
    speechSynthesis.speak(utterance)
    setReading(true)
  }
  return <><ActionButton label={t(reading ? 'stopReading' : 'readAloud')} onClick={toggle}>{reading ? <StopGlyph size={12} /> : <SpeakerGlyph />}</ActionButton>{unavailable && <span className={css.actionNote} role="alert">{t('speechUnavailable')}</span>}</>
}

function VersionSwitch({ variants, disabled, commands, t }: { variants: Variants; disabled: boolean; commands: PersonalCommands; t: T }) {
  const { current, targets } = variants
  return <div className={css.versions}>
    <button type="button" className={css.versionStep} aria-label={t('previousVersion')} disabled={disabled || current === 0} onClick={() => { void commands.selectBranch(targets[current - 1]!) }}><IconChevronLeftOutlineRegular size={16} /></button>
    <span>{t('versionCount', { current: current + 1, total: targets.length })}</span>
    <button type="button" className={css.versionStep} aria-label={t('nextVersion')} disabled={disabled || current === targets.length - 1} onClick={() => { void commands.selectBranch(targets[current + 1]!) }}><IconChevronRightOutlineRegular size={16} /></button>
  </div>
}

/**
 * The step now streaming, on this client's clock: when it started, as the Host measures it, and when its thinking ended.
 * Each Host view of the step re-bases the start, so the count needs no shared clock; a new step starts without an end.
 */
function useStepClock(live: LiveTurn | undefined): { readonly start: number; readonly end?: number } | undefined {
  const clock = useRef<{ elapsed: number; start: number; end?: number } | undefined>(undefined)
  const previous = clock.current
  if (!live) clock.current = undefined
  else if (!previous || previous.elapsed !== live.stepElapsedMs) clock.current = { elapsed: live.stepElapsedMs, start: Date.now() - live.stepElapsedMs, ...(previous?.end !== undefined && (live.reasoning || live.text) ? { end: previous.end } : {}) }
  if (clock.current && clock.current.end === undefined && live?.reasoning && (live.text || live.tool)) clock.current.end = Date.now()
  return clock.current
}

/** @returns the current time, refreshed at each whole second after `since` while `since` is set. */
function useSecondTick(since: number | undefined): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (since === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      const time = Date.now()
      setNow(time)
      timer = setTimeout(tick, 1000 - (((time - since) % 1000) + 1000) % 1000)
    }
    tick()
    return () => { clearTimeout(timer) }
  }, [since])
  return now
}

/** While `since` is set the model is thinking and the label counts whole seconds from it; afterwards it shows `ms`. */
function ThinkingRow({ reasoning, ms, since, t }: { reasoning: string; ms?: number; since?: number; t: T }) {
  const [open, setOpen] = useState(false)
  const now = useSecondTick(since)
  const thinking = since !== undefined
  const label = thinking ? t('thinkingFor', { seconds: Math.max(0, Math.floor((now - since) / 1000)) }) : ms !== undefined && ms >= 500 ? t('thoughtFor', { seconds: Math.max(1, Math.round(ms / 1000)) }) : t('thought')
  const head = <TextShimmer active={thinking}>{label}</TextShimmer>
  if (!reasoning) return <div className={css.thinking}>{head}</div>
  return <div className={css.thinking}>
    <button type="button" className={css.thinkingToggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{head}<IconChevronRightOutlineRegular size={16} className={css.disclosure} /></button>
    {open && <div className={css.thinkingText}>{reasoning}</div>}
  </div>
}

function TodoCard({ todos, running, stopped, t }: { todos: readonly TodoItem[]; running: boolean; stopped: boolean; t: T }) {
  const done = todos.filter(item => item.status === 'completed').length
  const [open, setOpen] = useState(running || stopped)
  useEffect(() => { if (running) setOpen(true); else if (!stopped) setOpen(false) }, [running, stopped])
  const title = running ? t('todoProgress', { done, total: todos.length }) : stopped ? t('todoStopped', { done, total: todos.length }) : t('todoDone', { count: done })
  return <section className={css.todos} data-running={running || undefined} aria-label={t('todoTitle')}>
    <button type="button" className={css.todoHead} aria-expanded={open} onClick={() => { setOpen(value => !value) }}><span>{title}</span><IconChevronDownOutlineRegular size={16} className={css.disclosure} /></button>
    {open && <ol className={css.todoList}>{todos.map(item => <li key={item.content} data-status={item.status}>
      <span className={css.todoMark} aria-hidden>{item.status === 'completed' ? <IconCheckCircleFillRegular size={18} /> : null}</span>
      <TextShimmer active={running && item.status === 'in_progress'}>{item.content}</TextShimmer>
      <span className={css.srOnly}>{t(item.status === 'completed' ? 'todoCompleted' : item.status === 'in_progress' ? 'todoCurrent' : 'todoPending')}</span>
    </li>)}</ol>}
  </section>
}

interface ShownTurn extends ChatTurn { readonly live?: LiveTurn }
/** The running turn: what its finished steps stored, then the step streaming now. */
function withLive(turn: ChatTurn, live: LiveTurn): ShownTurn {
  return { ...turn, live, text: [turn.text, live.text.trim()].filter(Boolean).join('\n\n'), reasoning: [turn.reasoning, live.reasoning.trim()].filter(Boolean).join('\n\n') }
}

/** Live messages share one scroll region with whatever precedes them, so an imported history reads straight into its continuation. @param props - Authoritative state, commands and the content shown above the messages. @returns the scrolling thread with its scroll-to-bottom control. */
export function ChatMessages({ state, commands, t, children }: { state: PersonalState; commands: PersonalCommands; t: T; children?: ReactNode }) {
  const detail = state.detail!
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>()
  const markdown = useMarkdown(t)
  const renderable = state.limits?.office === true && !detail.conversation.temporary
  const live = detail.live
  const locked = state.busy || !!live
  const turns: ShownTurn[] = turnsOf(detail.messages)
  if (live && turns.length) turns[turns.length - 1] = withLive(turns.at(-1)!, live)
  const variants = detail.conversation.selectedBranchId ? variantsOf(detail.conversation) : new Map<number, Variants>()
  const clock = useStepClock(live)
  const lastUser = detail.messages.findLast(message => message.role === 'user')?.id
  const toBottom = (smooth = false) => {
    const element = scroller.current
    if (!element) return
    if (smooth && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else element.scrollTop = element.scrollHeight
  }
  // Streaming follows only a reader already at the bottom; one who scrolled up keeps their place.
  useLayoutEffect(() => {
    const target = column.current
    if (following.current) toBottom()
    if (!target || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (following.current) toBottom() })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  // A message just sent always brings the reader down to it.
  const seenUser = useRef(lastUser)
  useLayoutEffect(() => {
    if (seenUser.current !== lastUser) { seenUser.current = lastUser; following.current = true; setAtBottom(true) }
    if (following.current) toBottom()
  }, [lastUser, detail.messages.length, live?.text, live?.reasoning, live?.tool])
  const retry = () => { if (lastUser) void commands.branch(lastUser, 'regenerate') }
  const last = turns.length - 1
  const stopped = !!detail.error
  return <div className={css.thread}>
    <div className={css.messages} ref={scroller} onScroll={() => { const element = scroller.current; if (!element) return; const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32; following.current = bottom; setAtBottom(bottom) }}>
      <div className={css.messageColumn} ref={column}>
        {children}
        {turns.map((turn, index) => {
          const versions = variants.get(turn.index)
          const running = !!turn.live
          const reply = turn.replies.at(-1)
          const latest = index === last
          const thinkingNow = running && !!turn.live!.reasoning && !turn.live!.text && !turn.live!.tool
          const step = running && clock?.end !== undefined && turn.live!.reasoning ? clock.end - clock.start : undefined
          const thinkingMs = turn.thinkingMs === undefined && step === undefined ? undefined : (turn.thinkingMs ?? 0) + (step ?? 0)
          const since = thinkingNow && clock ? clock.start - (turn.thinkingMs ?? 0) : undefined
          const status = running && !turn.todos && !thinkingNow && !turn.live!.text ? turn.live!.tool ? t(toolStatus(turn.live!.tool)) : undefined : undefined
          return <article key={turn.key} className={css.turn} data-latest={latest || undefined}>
            {turn.user && <div className={css.userTurn}>
              <Files ids={turn.user.attachmentIds} detail={detail} renderable={renderable} commands={commands} t={t} />
              {editing?.id === turn.user.id ? <EditBox text={editing.text} busy={locked} t={t} onChange={text => { setEditing({ id: turn.user!.id, text }) }} onCancel={() => { setEditing(undefined) }} onSend={() => { void commands.branch(turn.user!.id, 'edit', editing.text).then(ok => { if (ok) setEditing(undefined) }) }} />
                : turn.user.text && <UserBubble text={turn.user.text} time={turn.user.time} />}
              {editing?.id !== turn.user.id && <div className={css.userActions}>
                {versions && !versions.onReply && <VersionSwitch variants={versions} disabled={locked} commands={commands} t={t} />}
                {turn.user.text && <CopyButton text={turn.user.text} t={t} />}
                <ActionButton label={t('edit')} disabled={locked} onClick={() => { setEditing({ id: turn.user!.id, text: turn.user!.text }) }}><IconEditOutlineRegular size={18} /></ActionButton>
              </div>}
            </div>}
            {(reply || running || turn.attachmentIds.length > 0) && <div className={css.replyTurn}>
              {(turn.reasoning || thinkingMs !== undefined || thinkingNow) && <ThinkingRow reasoning={turn.reasoning} t={t} {...thinkingMs === undefined ? {} : { ms: thinkingMs }} {...since === undefined ? {} : { since }} />}
              {turn.todos && <TodoCard todos={turn.todos} running={running} stopped={latest && stopped && !running} t={t} />}
              {status && <p className={css.status}><TextShimmer active>{status}</TextShimmer></p>}
              {running && !turn.text && !status && !thinkingNow && !turn.todos && <span className={css.pending} role="status" aria-label={t('loading')} />}
              {turn.text && markdown(turn.text, running)}
              <Files ids={turn.attachmentIds} detail={detail} renderable={renderable} commands={commands} t={t} />
              <MemoryProposals turn={turn} memory={state.memory} busy={state.busy} commands={commands} t={t} />
              <Sources turn={turn} memory={state.memory} commands={commands} t={t} />
              {!running && reply && <div className={css.replyActions}>
                {versions?.onReply && <VersionSwitch variants={versions} disabled={locked} commands={commands} t={t} />}
                {turn.text && <CopyButton text={turn.text} t={t} />}
                {turn.text && <ReadAloud text={turn.text} t={t} />}
                {turn.user && <ActionButton label={t('regenerate')} disabled={locked} onClick={() => { void commands.branch(reply.id, 'regenerate') }}><IconRefreshOutlineRegular size={18} /></ActionButton>}
              </div>}
            </div>}
          </article>
        })}
        {detail.error && detail.error !== 'stopped' && <div className={css.turnError} role="status"><span>{detail.error === 'max-tokens' ? t('replyTruncated') : t('replyError', { reason: detail.error })}</span>{lastUser && <Button size="sm" variant="outline" disabled={locked} onClick={retry}>{t('retry')}</Button>}</div>}
      </div>
    </div>
    {!atBottom && <button type="button" className={css.toBottom} aria-label={t('scrollDown')} onClick={() => { following.current = true; setAtBottom(true); toBottom(true) }}><ArrowDownGlyph size={18} /></button>}
  </div>
}

/** The person's message opened for editing in place; sending it starts a new version. */
function EditBox({ text, busy, onChange, onCancel, onSend, t }: { text: string; busy: boolean; onChange: (text: string) => void; onCancel: () => void; onSend: () => void; t: T }) {
  const input = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => { if (input.current) autoGrow(input.current, 12) }, [text])
  useEffect(() => { const element = input.current; if (element) { element.focus(); element.setSelectionRange(element.value.length, element.value.length) } }, [])
  return <form className={css.editBox} onSubmit={event => { event.preventDefault(); if (!busy && text.trim()) onSend() }}>
    <textarea ref={input} aria-label={t('edit')} value={text} onChange={event => { onChange(event.target.value) }} onKeyDown={event => { if (event.key === 'Escape') onCancel() }} />
    <div className={css.editActions}><Button type="button" variant="outline" onClick={onCancel}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={busy || !text.trim()}>{t('send')}</Button></div>
  </form>
}
