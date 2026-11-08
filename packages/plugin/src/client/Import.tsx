/** Explicit preview, commit and batch-scoped undo for ChatGPT exports. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImportBatch } from '../shared/types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalCommands } from './contract.ts'
import type { PersonalState } from './model.ts'
import css from './PersonalChat.module.css'

/** No file or memory is imported before the preview confirmation. @param props - Current preview, import history and explicit commands. @returns import management page. */
export function ImportPage({ state, commands, t }: { state: PersonalState; commands: PersonalCommands; t: TranslateNS<'personalChat'> }) {
  const [undo, setUndo] = useState<ImportBatch | undefined>()
  const preview = state.preview
  return <div className={css.management}>
    <section><h2>{t('importTitle')}</h2><p className={css.muted}>{t('importBody')}</p>
      <label className={css.filePicker}>{t('chooseFile')}<input type="file" accept=".zip,.json,application/zip,application/json" disabled={state.busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void commands.preview(file) }} /></label>
      {state.busy && preview === undefined && <p className={css.muted} role="status">{t('loading')}</p>}
    </section>
    {preview !== undefined && <section aria-label={t('preview')}><h2>{t('preview')}</h2><p>{preview.fileName} · {t('previewCounts', { count: preview.items.length })}</p>
      {preview.warnings.map((warning, index) => <p key={`${index}:${warning}`} className={css.notice}>{warning}</p>)}
      <div className={css.previewActions}><Button variant="primary" disabled={state.busy} onClick={() => { void commands.commitImport() }}>{t('importConfirm')}</Button><Button disabled={state.busy} onClick={commands.discardPreview}>{t('importCancel')}</Button></div>
      <ul className={css.recordList}>{preview.items.map(item => <li key={item.sourceId}><h3>{item.title}</h3><p className={css.muted}>{t(item.status === 'new' ? 'importNew' : item.status === 'duplicate' ? 'importDuplicate' : 'importRevision')} · {t('importNodes', { nodes: item.nodes, branches: item.branches })}</p>{item.warnings.map((warning, index) => <p key={`${index}:${warning}`} className={css.notice}>{warning}</p>)}</li>)}</ul>
    </section>}
    <section><h2>{t('importHistory')}</h2>{state.imports.length === 0 ? <p className={css.muted}>{t('noImports')}</p> : <ul className={css.recordList}>{state.imports.map(batch => <li key={batch.id}>
      <h3>{batch.fileName}</h3><p className={css.muted}>{new Date(batch.createdAt).toLocaleString()}</p>
      {batch.state === 'withdrawn' ? <p>{t('undone')}</p> : <Button size="sm" disabled={state.busy || batch.state !== 'committed'} onClick={() => { setUndo(batch) }}>{t('undoImport')}</Button>}
    </li>)}</ul>}</section>
    <Modal open={undo !== undefined} title={t('undoTitle')} description={t('undoBody')} closeLabel={t('cancel')} onClose={() => { if (!state.busy) setUndo(undefined) }} footer={<>
      <Button disabled={state.busy} onClick={() => { setUndo(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={state.busy} onClick={() => { if (undo) void commands.undoImport(undo.id).then(ok => { if (ok) setUndo(undefined) }) }}>{t('undoConfirm')}</Button>
    </>} />
  </div>
}
