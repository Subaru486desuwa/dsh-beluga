// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ButtonHTMLAttributes } from 'react'
import { ImportPage } from '../src/client/Import.tsx'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { PersonalState } from '../src/client/model.ts'
import type { ImportPreview } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  Modal: () => null,
}))
afterEach(cleanup)
const t = ((key: string) => key) as never
const preview = { id: 'preview', fileName: 'export.zip', expiresAt: 0, warnings: ['limits'], items: Array.from({ length: 339 }, (_, index) => ({ sourceId: `source-${index}`, title: `Chat ${index}`, nodes: 4, branches: 1, status: 'new', warnings: [] })) } as unknown as ImportPreview
const show = (state: Partial<PersonalState>) => render(<ImportPage state={{ imports: [], busy: false, preview: undefined, ...state } as PersonalState} commands={{} as PersonalCommands} t={t} />)

describe('import page', () => {
  it('offers the decision before a list that can run to hundreds of rows', () => {
    show({ preview })
    const list = screen.getAllByRole('listitem')[0]!
    for (const name of ['importConfirm', 'importCancel']) expect(screen.getByRole('button', { name }).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('says it is working while an export is being read', () => {
    show({ busy: true })
    expect(screen.getByRole('status').textContent).toBe('loading')
  })
  it('stays quiet once the preview is there', () => {
    show({ preview })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
