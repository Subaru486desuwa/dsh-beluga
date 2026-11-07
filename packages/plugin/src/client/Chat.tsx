import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, MarkdownText, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatAttachment, ChatMessageView } from '../shared/types.ts'
import type { PersonalState } from './model.ts'
import type { PersonalCommands } from './contract.ts'
import { decodeBase64, saveFile } from './export.ts'
import { FilePreview } from './Preview.tsx'
import { speakable, withoutRemoteImages } from './markdown.ts'
import css from './PersonalChat.module.css'

function FileView({ file, renderable, commands, t }: { file: ChatAttachment; renderable: boolean; commands: PersonalCommands; t: TranslateNS<'personalChat'> }) {
  const [image, setImage] = useState<string | undefined>()
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const office = renderable && /\.(docx|xlsx|pptx)$/iu.test(file.name)
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
  return <div className={css.fileCard}>{image && <img className={css.ownImage} src={image} alt={file.name} />}<span>{file.artifact ? t('artifactVersion', { version: file.artifact.version }) : t('inputFile')} · {file.name} · {Math.ceil(file.bytes / 1024)} KB</span><Button size="sm" onClick={() => { void download().catch(() => setFailed(true)) }}>{t('download')}</Button>{office && <Button size="sm" onClick={() => setPreviewing(true)}>{t('previewFile')}</Button>}{office && <Button size="sm" disabled={exporting} onClick={() => { void exportPdf() }}>{t(exporting ? 'loading' : 'exportPdf')}</Button>}{previewing && <FilePreview file={file} commands={commands} onClose={() => setPreviewing(false)} t={t} />}{file.artifact && <small>{file.artifact.summary}</small>}{failed && <span role="alert">{t('failed')}</span>}</div>
}
/** A network voice would send the reply to the browser vendor, so only voices on this device count. */
function localVoice(text: string): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in globalThis)) return undefined
  const language = /\p{Script=Han}/u.test(text) ? 'zh' : navigator.language.split('-')[0]!
  return speechSynthesis.getVoices().find(voice => voice.localService && voice.lang.toLowerCase().startsWith(language))
}
function ReadAloud({ text, t }: { text: string; t: TranslateNS<'personalChat'> }) {
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
  return <><Button size="sm" onClick={toggle}>{t(reading ? 'stopReading' : 'readAloud')}</Button>{unavailable && <span className={css.muted} role="alert">{t('speechUnavailable')}</span>}</>
}
export function ChatMessages({ state, commands, t }: { state: PersonalState; commands: PersonalCommands; t: TranslateNS<'personalChat'> }) {
  const detail = state.detail!
  const scroll = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const [edit, setEdit] = useState<{ message: ChatMessageView; text: string } | undefined>()
  const [copied, setCopied] = useState<string | undefined>()
  const renderable = state.limits?.office === true && !detail.conversation.temporary
  const labels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t])
  useEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [detail.messages.length, detail.live?.text, detail.live?.reasoning])
  const renderMarkdown = (text: string, streaming = false) => <MarkdownText text={withoutRemoteImages(text, t('externalImage'), streaming)} streaming={streaming} labels={labels} />
  const copy = async (message: ChatMessageView) => { await writeClipboard(message.text); setCopied(message.id); setTimeout(() => setCopied(undefined), 1500) }
  return <>
    <div className={css.messages} ref={scroll} onScroll={() => { const el = scroll.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}>
      <div className={css.messageColumn}>
        {detail.messages.map(message => <article key={message.id} className={css.chatMessage} data-role={message.role}>
          <div className={css.messageMeta}><span>{message.role}</span><time>{new Date(message.time).toLocaleTimeString()}</time></div>
          {message.role === 'tool' ? <details className={css.tool}><summary>{t('toolResult')}</summary><pre>{message.text}</pre></details> : <>
            {message.reasoning && <details className={css.reasoning}><summary>{t('thinking')}</summary><div className={css.messageText}>{message.reasoning}</div></details>}
            {message.role === 'assistant' ? renderMarkdown(message.text) : <div className={css.userText}>{message.text}</div>}
            {message.toolNames.length > 0 && <div className={css.muted}>{message.toolNames.join(' · ')}</div>}
            {message.sources && <nav className={css.sources} aria-label={t('sources')}>{message.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer noopener">{source.title || new URL(source.url).hostname}</a>)}</nav>}
          </>}
          {message.attachmentIds.map(id => { const file = detail.attachments.find(item => item.id === id); return file ? <FileView key={id} file={file} renderable={renderable} commands={commands} t={t} /> : null })}
          {message.role !== 'tool' && <div className={css.messageActions}>
            <Button size="sm" onClick={() => { void copy(message) }}>{t(copied === message.id ? 'copied' : 'copy')}</Button>
            {message.role === 'user' ? <Button size="sm" disabled={state.busy || !!detail.live} onClick={() => setEdit({ message, text: message.text })}>{t('edit')}</Button> : <Button size="sm" disabled={state.busy || !!detail.live} onClick={() => { void commands.branch(message.id, 'regenerate') }}>{t('regenerate')}</Button>}
            {message.role === 'assistant' && <ReadAloud text={message.text} t={t} />}
          </div>}
        </article>)}
        {detail.live && <article className={css.chatMessage} aria-live="polite">
          {detail.live.reasoning && <details className={css.reasoning}><summary>{t('thinking')}</summary><div className={css.messageText}>{detail.live.reasoning}</div></details>}
          {detail.live.text ? renderMarkdown(detail.live.text, true) : <p className={css.muted}>{detail.live.tool || t('loading')}</p>}
        </article>}
        {detail.error && <p className={css.turnError} role="status">{detail.error === 'max-tokens' ? t('replyTruncated') : t('replyError', { reason: detail.error })}{detail.messages.some(message => message.role === 'user') && <Button size="sm" disabled={state.busy || !!detail.live} onClick={() => { const last = detail.messages.findLast(message => message.role === 'user'); if (last) void commands.branch(last.id, 'regenerate') }}>{t('retry')}</Button>}</p>}
        {detail.omittedMessages > 0 && <p className={css.muted}>{t('omittedMessages', { count: detail.omittedMessages })}</p>}
      </div>
    </div>
    <Modal open={edit !== undefined} title={t('editTitle')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setEdit(undefined) }} footer={<><Button onClick={() => setEdit(undefined)}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy || !edit?.text.trim()} onClick={() => { if (edit) void commands.branch(edit.message.id, 'edit', edit.text).then(ok => { if (ok) setEdit(undefined) }) }}>{t('sendEdit')}</Button></>}>
      <textarea className={css.textarea} aria-label={t('editTitle')} value={edit?.text ?? ''} onChange={event => { if (edit) setEdit({ ...edit, text: event.target.value }) }} />
    </Modal>
  </>
}
export function ChatComposer({ state, commands, t }: { state: PersonalState; commands: PersonalCommands; t: TranslateNS<'personalChat'> }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const live = !!state.detail?.live
  const submit = async () => {
    if (state.busy || live || uploading || (!text.trim() && !files.length) || !state.selectedModel) return
    if (await commands.send(text, files.map(file => file.id))) { setText(''); setFiles([]); setError(false) }
  }
  const addFiles = async (selected: FileList | readonly File[]) => {
    setUploading(true); setError(false)
    try {
      for (const file of Array.from(selected)) {
        const attachment = await commands.upload(file)
        if (!attachment) { setError(true); break }
        setFiles(value => [...value, attachment])
      }
    } finally { setUploading(false) }
  }
  return <form className={css.composer} onSubmit={event => { event.preventDefault(); void submit() }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!live && !uploading) void addFiles(event.dataTransfer.files) }}>
    {files.length > 0 && <div className={css.composerFiles}>{files.map(file => <span key={file.id}>{file.name}<button type="button" aria-label={t('removeAttachment')} disabled={state.busy || uploading} onClick={() => { void commands.removeAttachment(file.id).then(ok => { if (ok) setFiles(current => current.filter(item => item.id !== file.id)) }) }}>×</button></span>)}</div>}
    <textarea className={css.composerText} aria-label={t('messagePlaceholder')} placeholder={t('messagePlaceholder')} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void submit() }
    }} onPaste={event => { const list = Array.from(event.clipboardData.files); if (list.length && !uploading && !live) { event.preventDefault(); void addFiles(list) } }} />
    <div className={css.composerControls}>
      <Button type="button" size="sm" disabled={state.busy || uploading || live} onClick={() => picker.current?.click()}>{uploading ? t('loading') : t('attach')}</Button>
      <label className={css.webToggle}><input type="checkbox" checked={state.web} disabled={live || state.busy} onChange={event => commands.setWeb(event.target.checked)} />{t('web')}</label>
      <input ref={picker} className={css.hiddenFile} type="file" multiple onChange={event => { const selected = event.target.files; if (selected?.length) void addFiles(selected); event.target.value = '' }} />
      <select aria-label={t('model')} disabled={state.busy || live} value={state.selectedModel ? modelKey(state.selectedModel) : ''} onChange={event => { const index = state.models.findIndex(model => modelKey(model) === event.target.value); if (index >= 0) commands.chooseModel(state.models[index]!) }}>
        {state.models.length === 0 && <option value="">{t(state.modelsLoading ? 'loading' : 'noModels')}</option>}
        {state.models.map(model => <option key={model.provider + ':' + model.model + ':' + !!model.inline} value={modelKey(model)}>{model.name}</option>)}
      </select>
      {live ? <Button type="button" variant="primary" disabled={state.busy} onClick={() => { void commands.stop() }}>{t('stop')}</Button> : <Button type="submit" variant="primary" disabled={state.busy || uploading || (!text.trim() && !files.length) || !state.selectedModel}>{t('send')}</Button>}
    </div>
    {error && <p className={css.muted} role="alert">{t('uploadFailed')}</p>}
  </form>
}

function modelKey(model: { provider: string; model: string; inline?: true }): string { return JSON.stringify([model.provider, model.model, !!model.inline]) }
