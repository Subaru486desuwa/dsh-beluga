/** Imported history, kept exactly as exported and drawn like the messages that continue it. */
import { useState } from 'react'
import { Button, IconSparkleRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchiveNode, ArchiveView, Conversation } from '../shared/types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalCommands } from './contract.ts'
import { ActionButton, CopyButton, UserBubble, useMarkdown } from './Message.tsx'
import css from './PersonalChat.module.css'

type T = TranslateNS<'personalChat'>
/** Export times are seconds since the epoch. */
const exportTime = (node: ArchiveNode) => typeof node.time === 'number' ? node.time * 1000 : undefined

/** Render the selected parent chain, not a timestamp-flattened mapping. @param props - Host-resolved archive and exact selection callbacks. @returns the imported messages under one line of controls. */
export function ArchiveHistory({ archive, conversation, commands, busy, t }: { archive: ArchiveView; conversation: Conversation; commands: PersonalCommands; busy: boolean; t: T }) {
  const [candidate, setCandidate] = useState<{ nodeId: string; text: string } | undefined>()
  const markdown = useMarkdown(t)
  const leaves = archive.nodes.filter(node => node.children.length === 0)
  const hiddenReasoning = archive.branchNodes.filter(node => node.reasoning).length
  const remember = (node: ArchiveNode) => node.text !== '' && <ActionButton label={t('remember')} disabled={busy} onClick={() => { setCandidate({ nodeId: node.id, text: node.text }) }}><IconSparkleRegular size={18} /></ActionButton>
  return <section className={css.archive} aria-label={t('importedHistory')}>
    <div className={css.archiveBar}>
      <Tooltip label={t('archiveReadOnly')} side="bottom" portal maxWidth={320}><span tabIndex={0}>{t('importedHistory')} · {t('readOnly')}</span></Tooltip>
      {conversation.archiveRevisions.length > 1 && <label>{t('archiveRevision')}<select aria-label={t('archiveRevision')} value={archive.revisionId} disabled={busy} onChange={event => {
        void commands.selectArchive({ revisionId: event.target.value as ArchiveView['revisionId'] })
      }}>{conversation.archiveRevisions.map((id, index) => <option key={id} value={id}>{index + 1}</option>)}</select></label>}
      {(leaves.length > 1 || !leaves.some(node => node.id === archive.selectedNode)) && <label>{t('archiveBranch')}<select aria-label={t('archiveBranch')} value={archive.selectedNode} disabled={busy} onChange={event => { void commands.selectArchive({ revisionId: archive.revisionId, nodeId: event.target.value }) }}>
        {!leaves.some(node => node.id === archive.selectedNode) && <option value={archive.selectedNode}>{archive.selectedNode}</option>}
        {leaves.map((node, index) => <option key={node.id} value={node.id}>{t('branch', { number: index + 1 })}</option>)}
      </select></label>}
      {hiddenReasoning > 0 && <span>{t('reasoningHiddenShort', { count: hiddenReasoning })}</span>}
    </div>
    {archive.warnings.map((warning, index) => <p className={css.threadNote} key={`${index}:${warning}`}>{warning}</p>)}
    {archive.branchNodes.filter(node => !node.structural && !node.reasoning).map(node => {
      const time = exportTime(node)
      return <article key={node.id} className={css.turn} data-archive-role={node.role ?? 'unknown'}>
        {node.role === 'user' ? <div className={css.userTurn}>
          {node.text && <UserBubble text={node.text} {...time === undefined ? {} : { time }} />}
          <div className={css.userActions}>{node.text && <CopyButton text={node.text} t={t} />}{remember(node)}</div>
        </div> : <div className={css.replyTurn}>
          {node.role === 'assistant' ? node.text && markdown(node.text) : <div className={css.rawNode}><small>{node.role ?? t('structural')}</small><pre>{node.text}</pre></div>}
          {node.text && <div className={css.replyActions}><CopyButton text={node.text} t={t} />{remember(node)}</div>}
        </div>}
        {node.unsupportedContent && <p className={css.threadNote}>{t('unsupported')}</p>}
      </article>
    })}
    <details className={css.original}><summary>{t('original')}</summary><pre>{JSON.stringify(archive.original, null, 2)}</pre></details>
    <Modal open={candidate !== undefined} title={t('remember')} closeLabel={t('cancel')} onClose={() => { if (!busy) setCandidate(undefined) }} footer={<>
      <Button disabled={busy} onClick={() => { setCandidate(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !candidate?.text.trim()} onClick={() => { if (candidate) void commands.proposeMemory(candidate.text, 'fact', { kind: 'archive', revisionId: archive.revisionId, nodeId: candidate.nodeId }).then(ok => { if (ok) setCandidate(undefined) }) }}>{t('remember')}</Button>
    </>}><textarea className={css.textarea} aria-label={t('memoryText')} value={candidate?.text ?? ''} onChange={event => { if (candidate) setCandidate({ ...candidate, text: event.target.value }) }} /></Modal>
  </section>
}
