import { useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatAttachment, OfficePreview } from '../shared/types.ts'
import type { PersonalCommands } from './contract.ts'
import css from './PersonalChat.module.css'

/** Show an Office file as the Host renders it. Rendering takes seconds, so each sheet asks once when chosen. */
export function FilePreview({ file, commands, onClose, t }: { file: ChatAttachment; commands: PersonalCommands; onClose: () => void; t: TranslateNS<'personalChat'> }) {
  const [sheet, setSheet] = useState<string | undefined>()
  const [preview, setPreview] = useState<OfficePreview | undefined>()
  const [failed, setFailed] = useState(false)
  const currentCommands = useRef(commands)
  currentCommands.current = commands
  useEffect(() => {
    let active = true
    setPreview(undefined)
    setFailed(false)
    void currentCommands.current.previewFile(file.id, sheet).then(result => { if (active) setPreview(result) }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [file.id, sheet])
  return <Modal open title={file.name} closeLabel={t('cancel')} onClose={onClose} className={css.previewDialog}>
    <div className={css.filePreview}>
      {preview?.sheets && preview.sheets.length > 1 && <label>{t('worksheet')} <select value={preview.sheet} onChange={event => setSheet(event.target.value)}>{preview.sheets.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
      {!preview && !failed && <p className={css.muted} role="status">{t('loading')}</p>}
      {failed && <p className={css.muted} role="alert">{t('failed')}</p>}
      {preview?.clipped && <p className={css.muted}>{t('previewClipped', { range: preview.range ?? '' })}</p>}
      {preview && !preview.sheet && preview.pageCount > preview.pages.length && <p className={css.muted}>{t('previewPages', { total: preview.pageCount, shown: preview.pages.length })}</p>}
      {preview && preview.missingFonts.length > 0 && <p className={css.muted}>{t('previewFonts', { fonts: preview.missingFonts.join(', ') })}</p>}
      {preview?.pages.map((page, index) => <img key={index} src={'data:image/png;base64,' + page.base64} width={page.width} height={page.height} alt={preview.sheet ?? String(index + 1)} />)}
    </div>
  </Modal>
}
