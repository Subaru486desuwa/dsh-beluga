/** Source-preserving imported history and a continuation into plugin-owned messages. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchiveView, Conversation } from '../shared/types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalCommands } from './contract.ts'
import css from './PersonalChat.module.css'

/** Render the selected parent chain, not a timestamp-flattened mapping. @param props - Host-resolved archive and exact selection callbacks. @returns read-only archive controls and messages. */
export function ArchiveHistory({ archive, conversation, commands, busy, t }: { archive: ArchiveView; conversation: Conversation; commands: PersonalCommands; busy: boolean; t: TranslateNS<'personalChat'> }) {
  const [candidate, setCandidate] = useState<{ nodeId: string; text: string } | undefined>()
  const leaves = archive.nodes.filter(node => node.children.length === 0)
  const hiddenReasoning = archive.branchNodes.filter(node => node.reasoning).length
  return <>
    <div className={css.archiveControls}>
      <label>{t('archiveRevision')}<select aria-label={t('archiveRevision')} value={archive.revisionId} disabled={busy} onChange={event => {
        void commands.selectArchive({ revisionId: event.target.value as ArchiveView['revisionId'] })
      }}>{conversation.archiveRevisions.map((id, index) => <option key={id} value={id}>{index + 1}</option>)}</select></label>
      <label>{t('archiveBranch')}<select aria-label={t('archiveBranch')} value={archive.selectedNode} disabled={busy} onChange={event => { void commands.selectArchive({ revisionId: archive.revisionId, nodeId: event.target.value }) }}>
        {!leaves.some(node => node.id === archive.selectedNode) && <option value={archive.selectedNode}>{archive.selectedNode}</option>}
        {leaves.map((node, index) => <option key={node.id} value={node.id}>{t('branch', { number: index + 1 })}</option>)}
      </select></label>
    </div>
    <p className={css.muted}>{t('archiveReadOnly')}</p>
    {archive.warnings.map((warning, index) => <p className={css.notice} key={`${index}:${warning}`}>{warning}</p>)}
    {hiddenReasoning > 0 && <p className={css.muted}>{t('reasoningHidden', { count: hiddenReasoning })}</p>}
    <ol className={css.archiveMessages}>{archive.branchNodes.filter(node => !node.structural && !node.reasoning).map(node => <li key={node.id} data-archive-role={node.role}>
      <div className={css.messageMeta}><span>{node.role}</span>{typeof node.time === 'number' && <time>{new Date(node.time * 1000).toLocaleString()}</time>}</div>
      <div className={css.messageText}>{node.text}</div>
      {node.text !== '' && <Button size="sm" disabled={busy} onClick={() => { setCandidate({ nodeId: node.id, text: node.text }) }}>{t('remember')}</Button>}
      {node.unsupportedContent && <p className={css.notice}>{t('unsupported')}</p>}
    </li>)}</ol>
    <Modal open={candidate !== undefined} title={t('remember')} closeLabel={t('cancel')} onClose={() => { if (!busy) setCandidate(undefined) }} footer={<>
      <Button disabled={busy} onClick={() => { setCandidate(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !candidate?.text.trim()} onClick={() => { if (candidate) void commands.proposeMemory(candidate.text, 'fact', { kind: 'archive', revisionId: archive.revisionId, nodeId: candidate.nodeId }).then(ok => { if (ok) { setCandidate(undefined); void commands.section('memory') } }) }}>{t('remember')}</Button>
    </>}><textarea className={css.textarea} aria-label={t('memoryText')} value={candidate?.text ?? ''} onChange={event => { if (candidate) setCandidate({ ...candidate, text: event.target.value }) }} /></Modal>
    <details className={css.original}><summary>{t('original')}</summary><pre>{JSON.stringify(archive.original, null, 2)}</pre></details>
  </>
}

/** Submit new text only; archive rows never become fabricated live messages. @param props - Admission command and locale. @returns ephemeral transition input. */
export function ArchiveContinuation({ commands, busy, t }: { commands: PersonalCommands; busy: boolean; t: TranslateNS<'personalChat'> }) {
  const [text, setText] = useState('')
  return <form className={css.continueInput} onSubmit={event => { event.preventDefault(); if (text.trim()) void commands.continueArchive(text).then(ok => { if (ok) setText('') }) }}>
    <textarea aria-label={t('continuation')} placeholder={t('continuePlaceholder')} value={text} disabled={busy} onChange={event => { setText(event.target.value) }} />
    <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{t('send')}</Button>
  </form>
}
