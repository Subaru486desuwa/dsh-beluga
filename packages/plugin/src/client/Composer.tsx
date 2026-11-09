/** The message box: files waiting to send, the tools menu, the route and effort chip, and the send control. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { FileTypeIcon, IconCloseOutlineRegular, IconGlobeOutlineRegular, IconPaperclipOutlineRegular, IconPlusOutlineRegular, Menu, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatAttachment } from '../shared/types.ts'
import type { ModelChoice } from '../shared/models.ts'
import type { PersonalChatKey } from './locales.ts'
import type { PersonalCommands } from './contract.ts'
import type { PersonalState } from './model.ts'
import { ModelPicker, selectedChoice, shortName } from './ModelPicker.tsx'
import { ArrowUpGlyph, DropGlyph, GitHubGlyph, StopGlyph } from './icons.tsx'
import { autoGrow } from './Message.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>
/** The box grows with the text up to this many lines, then scrolls. */
const MAX_LINES = 10

export interface TrayItem {
  readonly key: string
  readonly name: string
  readonly image: boolean
  /** A local picture of the file while it uploads; never leaves the page. */
  readonly preview?: string
  readonly status: 'uploading' | 'ready' | 'failed'
  readonly attachment?: ChatAttachment
  readonly error?: PersonalChatKey
}
export interface Tray {
  readonly items: readonly TrayItem[]
  readonly uploading: boolean
  add(files: readonly File[]): void
  remove(key: string): void
  /** Forget what was sent; the files now belong to the message. */
  clear(): void
}

/**
 * Files upload one at a time, in the order added, because the chat runs one operation at a time.
 * @param maxBytes - the Host's per-file limit, checked before reading the file.
 */
export function useTray(commands: PersonalCommands, maxBytes: number | undefined): Tray {
  const [items, setItems] = useState<readonly TrayItem[]>([])
  const queue = useRef(Promise.resolve())
  const previews = useRef(new Set<string>())
  const current = useRef(commands)
  current.current = commands
  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url) }, [])
  const update = (key: string, change: Partial<TrayItem>) => setItems(list => list.map(item => item.key === key ? { ...item, ...change } : item))
  const forget = (item: TrayItem | undefined) => { if (item?.preview) { URL.revokeObjectURL(item.preview); previews.current.delete(item.preview) } }
  const add = useCallback((files: readonly File[]) => {
    const added = files.map(file => {
      const image = file.type.startsWith('image/')
      const preview = image ? URL.createObjectURL(file) : undefined
      if (preview) previews.current.add(preview)
      return { file, item: { key: crypto.randomUUID(), name: file.name, image, status: 'uploading' as const, ...preview ? { preview } : {} } }
    })
    setItems(list => [...list, ...added.map(entry => entry.item)])
    for (const { file, item } of added) queue.current = queue.current.then(async () => {
      if (maxBytes !== undefined && file.size > maxBytes) { update(item.key, { status: 'failed', error: 'fileLimit' }); return }
      const attachment = await current.current.upload(file).catch(() => undefined)
      update(item.key, attachment ? { status: 'ready', attachment, image: attachment.image } : { status: 'failed', error: 'uploadFailed' })
    })
  }, [maxBytes])
  const remove = (key: string) => {
    const item = items.find(entry => entry.key === key)
    if (!item || item.status === 'uploading') return
    if (item.status === 'failed' || !item.attachment) { forget(item); setItems(list => list.filter(entry => entry.key !== key)); return }
    void current.current.removeAttachment(item.attachment.id).then(ok => { if (ok) { forget(item); setItems(list => list.filter(entry => entry.key !== key)) } })
  }
  const clear = () => { for (const item of items) forget(item); setItems([]) }
  return { items, uploading: items.some(item => item.status === 'uploading'), add, remove, clear }
}

/** The kind a file card names under the file. */
function kindKey(name: string): PersonalChatKey {
  const kind = classifyFileType(name)
  return kind === 'pdf' ? 'kindPdf' : kind === 'word' ? 'kindDocument' : kind === 'excel' ? 'kindSpreadsheet' : kind === 'ppt' ? 'kindPresentation' : kind === 'image' ? 'kindImage' : 'kindFile'
}
/** A file shown as a card: its type glyph, name and kind. */
export function FileTile({ name, note, t }: { name: string; note?: string; t: T }) {
  return <span className={css.fileTile}><span className={css.fileGlyph}><FileTypeIcon path={name} size={22} /></span><span className={css.fileText}><strong>{name}</strong><small>{note ? note + ' · ' : ''}{t(kindKey(name))}</small></span></span>
}

/** Word, Excel and PowerPoint files, which only the optional Office extension can read. */
export const officeFile = (name: string): boolean => /\.(docx|xlsx|pptx)$/iu.test(name)

/** @param props.officeMissing - the Office extension is not installed, so Office files are kept but not read. */
function TrayView({ tray, officeMissing, t }: { tray: Tray; officeMissing: boolean; t: T }) {
  return <ul className={css.tray} aria-label={t('attachments')}>
    {tray.items.map(item => <li key={item.key} className={css.trayItem} data-status={item.status} data-image={item.image && !!item.preview || undefined}>
      {item.image && item.preview ? <img className={css.trayImage} src={item.preview} alt={item.name} /> : <FileTile name={item.name} {...(officeMissing && officeFile(item.name) ? { note: t('officeNeeded') } : {})} t={t} />}
      {item.status === 'uploading' && <span className={css.trayShimmer} role="status" aria-label={t('uploading')} />}
      {item.status === 'failed' && <span className={css.trayError} role="alert" title={t(item.error ?? 'uploadFailed')}>{t(item.error ?? 'uploadFailed')}</span>}
      {item.status !== 'uploading' && <button type="button" className={css.trayRemove} aria-label={t('removeAttachment') + ' · ' + item.name} onClick={() => { tray.remove(item.key) }}><IconCloseOutlineRegular size={12} /></button>}
    </li>)}
  </ul>
}

/** The image route the person most likely wants: the one this chat or they last used, else the first. */
function imageRoute(state: PersonalState): ModelChoice | undefined {
  const own = state.detail?.model
  return state.models.find(model => model.images && own && model.provider === own.provider && model.model === own.model && !!model.inline === !!own.inline)
    ?? state.models.find(model => model.images && model.lastUsed) ?? state.models.find(model => model.images)
}

/**
 * @param props.imagesNeeded - the chat already holds images, so the route must read them.
 * @param props.uploadable - files can be added now.
 * @returns the composer form.
 */
export function Composer({ state, commands, tray, imagesNeeded, uploadable, t }: { state: PersonalState; commands: PersonalCommands; tray: Tray; imagesNeeded: boolean; uploadable: boolean; t: T }) {
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const live = !!state.detail?.live
  const choice = selectedChoice(state)
  const ready = tray.items.filter(item => item.status === 'ready')
  const imageBlocked = !!choice && !choice.images && (imagesNeeded || ready.some(item => item.image) || tray.items.some(item => item.image && item.status === 'uploading'))
  const switchTo = imageBlocked ? imageRoute(state) : undefined
  const sendable = !state.busy && !live && !tray.uploading && !imageBlocked && !!choice && (!!text.trim() || ready.length > 0)
  useLayoutEffect(() => {
    if (!input.current) return
    const multiline = autoGrow(input.current, MAX_LINES)
    // Once the text needs a second line the box keeps its taller shape until it is emptied, so it never flickers between the two.
    if (!text) setExpanded(false)
    else if (multiline) setExpanded(true)
  }, [text])
  useEffect(() => { if (globalThis.matchMedia?.('(hover: hover)').matches) input.current?.focus() }, [])
  const submit = async () => {
    if (!sendable) return
    if (await commands.send(text, ready.map(item => item.attachment!.id))) { setText(''); tray.clear() }
  }
  const github = state.apps?.github
  // GitHub is offered once an account is connected; before that the menu leads to the Apps page.
  const githubReady = !!github?.installed && !!github.account
  const githubOn = state.github && githubReady
  const webOffered = state.apps?.web.available !== false
  const tools = [
    { id: 'files', label: t('addFiles'), icon: <IconPaperclipOutlineRegular size={18} />, disabled: !uploadable },
    ...(webOffered ? [{ id: 'web', label: t('webSearch'), icon: <IconGlobeOutlineRegular size={18} /> }] : []),
    ...(githubReady ? [{ id: 'github', label: t('github'), icon: <GitHubGlyph size={18} /> }] : github?.installed ? [{ id: 'connect', label: t('connectGitHub'), icon: <GitHubGlyph size={18} /> }] : []),
  ]
  const pick = (id: string) => {
    setToolsOpen(false)
    if (id === 'files') picker.current?.click()
    else if (id === 'web') commands.setWeb(!state.web)
    else if (id === 'github') commands.setGitHub(!state.github)
    else if (id === 'connect') void commands.openSettings('apps')
  }
  return <form className={css.composer} data-expanded={expanded || state.web || githubOn || state.models.length > 0 || tray.items.length > 0 || undefined} onSubmit={event => { event.preventDefault(); void submit() }}
    onClick={event => { if (event.target === event.currentTarget) input.current?.focus() }}>
    {tray.items.length > 0 && <TrayView tray={tray} officeMissing={state.limits?.office === false} t={t} />}
    {imageBlocked && <p className={css.composerNotice} role="status">{t('imageMismatch')}{switchTo && <button type="button" className={css.linkButton} onClick={() => { commands.chooseModel(switchTo) }}>{t('switchModel', { name: shortName(switchTo) })}</button>}</p>}
    <textarea ref={input} className={css.composerText} rows={1} aria-label={t('messagePlaceholder')} placeholder={t('messagePlaceholder')} value={text}
      onChange={event => { setText(event.target.value) }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void submit() } }}
      onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length && uploadable) { event.preventDefault(); tray.add(files) } }} />
    <div className={css.composerLeading}>
      <Menu open={toolsOpen} onClose={() => { setToolsOpen(false) }} portal side="top" autoFocus selection="check" selectedIds={[...state.web ? ['web'] : [], ...githubOn ? ['github'] : []]}
        items={tools} onSelect={pick}
        anchor={<button type="button" className={css.roundButton} aria-label={t('tools')} aria-haspopup="menu" aria-expanded={toolsOpen} onClick={() => { setToolsOpen(value => !value) }}><IconPlusOutlineRegular size={20} /></button>} />
      {state.web && <button type="button" className={css.chip} data-active="true" aria-label={t('removeWeb')} onClick={() => { commands.setWeb(false) }}><span className={css.chipIcon}><IconGlobeOutlineRegular size={18} /></span><span className={css.chipClose}><IconCloseOutlineRegular size={14} /></span><span>{t('webChip')}</span></button>}
      {githubOn && <button type="button" className={css.chip} data-active="true" aria-label={t('removeGitHub')} onClick={() => { commands.setGitHub(false) }}><span className={css.chipIcon}><GitHubGlyph size={16} /></span><span className={css.chipClose}><IconCloseOutlineRegular size={14} /></span><span>{t('github')}</span></button>}
      <input ref={picker} className={css.hiddenFile} type="file" multiple tabIndex={-1} onChange={event => { const files = event.target.files; if (files?.length) tray.add(Array.from(files)); event.target.value = '' }} />
    </div>
    <div className={css.composerTrailing}>
      <ModelPicker state={state} commands={commands} imagesNeeded={imagesNeeded} disabled={state.busy || live || state.detail?.conversation.archived === true} t={t} />
      {live ? <button type="button" className={css.sendButton} aria-label={t('stop')} disabled={state.busy} onClick={() => { void commands.stop() }}><StopGlyph /></button>
        : <button type="submit" className={css.sendButton} aria-label={t('send')} disabled={!sendable}><ArrowUpGlyph /></button>}
    </div>
  </form>
}

/** Whether a drag carries files, as opposed to text or a link. */
const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')
/**
 * The whole conversation pane takes a dropped file; an invitation covers it while one is held over it.
 * @returns handlers for the pane and whether the invitation shows.
 */
export function useDropZone(tray: Tray, enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  useEffect(() => { if (!enabled) { depth.current = 0; setOver(false) } }, [enabled])
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => { if (!enabled || !carriesFiles(event)) return; event.preventDefault(); depth.current++; setOver(true) },
      onDragOver: (event: DragEvent) => { if (!enabled || !carriesFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
      onDragLeave: (event: DragEvent) => { if (!enabled || !carriesFiles(event)) return; if (--depth.current <= 0) { depth.current = 0; setOver(false) } },
      onDrop: (event: DragEvent) => { if (!enabled || !carriesFiles(event)) return; event.preventDefault(); depth.current = 0; setOver(false); const files = Array.from(event.dataTransfer.files); if (files.length) tray.add(files) },
    },
  }
}
export function DropOverlay({ t }: { t: T }) {
  return <div className={css.dropOverlay} aria-hidden><DropGlyph /><strong>{t('dropTitle')}</strong><span>{t('dropBody')}</span></div>
}
