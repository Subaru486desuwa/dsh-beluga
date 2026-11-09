/** Pieces a new turn and an imported message draw the same way. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, MarkdownText, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { withoutRemoteImages } from './markdown.ts'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>

/**
 * Fit a text box to its text, up to a number of lines, then let it scroll.
 * @returns whether the text needs more than one line.
 */
export function autoGrow(element: HTMLTextAreaElement, maxLines: number): boolean {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24
  element.style.height = 'auto'
  const height = element.scrollHeight
  element.style.height = Math.min(height, lineHeight * maxLines) + 'px'
  return element.value.includes('\n') || height > lineHeight * 1.5
}

/** A 32px icon control with its name in a tooltip, as message actions are drawn. */
export function ActionButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return <Tooltip label={label} side="bottom" portal>
    <button type="button" className={css.iconAction} aria-label={label} disabled={disabled} {...pressed === undefined ? {} : { 'aria-pressed': pressed }} onClick={onClick}>{children}</button>
  </Tooltip>
}

export function CopyButton({ text, t }: { text: string; t: T }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <ActionButton label={t(copied ? 'copied' : 'copy')} onClick={() => {
    void writeClipboard(text).then(() => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500) })
  }}>{copied ? <IconCheckOutlineRegular size={18} /> : <IconCopyOutlineRegular size={18} />}</ActionButton>
}

/** The person's words, kept exactly as written. A bubble taller than one line gets the roomier padding. */
export function UserBubble({ text, time }: { text: string; time?: number }) {
  const bubble = useRef<HTMLDivElement>(null)
  const [multiline, setMultiline] = useState(false)
  useLayoutEffect(() => {
    const element = bubble.current
    if (!element) return
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24
    const measure = () => { setMultiline(text.includes('\n') || element.scrollHeight - parseFloat(getComputedStyle(element).paddingTop) * 2 > lineHeight * 1.5) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  const content = <div ref={bubble} className={css.userBubble} data-multiline={multiline || undefined}>{text}</div>
  return time === undefined ? content : <Tooltip label={() => new Date(time).toLocaleString()} side="bottom" delayMs={600} portal>{content}</Tooltip>
}

/** @returns a renderer for assistant Markdown with remote images shown as links. */
export function useMarkdown(t: T): (text: string, streaming?: boolean) => ReactNode {
  const labels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t])
  return (text, streaming = false) => <div className={css.markdown}><MarkdownText text={withoutRemoteImages(text, t('externalImage'), streaming)} streaming={streaming} labels={labels} /></div>
}
