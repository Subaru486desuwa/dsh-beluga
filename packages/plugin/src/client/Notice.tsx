import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NoticeProps } from './contract.ts'

export function PersonalNotice({ usePersonal, commands, t }: NoticeProps) {
  const notice = usePersonal(state => state.notice)
  if (!notice) return null
  const text = t(notice.key, { count: notice.count }) + (notice.detail ? ' — ' + notice.detail : '')
  return <Toast key={notice.seq} text={text} {...notice.key === 'failed' ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} onDone={commands.dismissNotice}
    {...notice.undo ? { actions: [{ label: t('memoryUndo'), onClick: () => { void commands.forget(notice.undo!).then(ok => { if (ok) commands.dismissNotice() }) } }] } : {}} />
}
