// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ChatMessages } from '../src/client/Chat.tsx'
import { FilePreview } from '../src/client/Preview.tsx'
import type { PersonalState } from '../src/client/model.ts'
import type { PersonalCommands } from '../src/client/contract.ts'
import type { ChatAttachment, OfficePreview } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  MarkdownText: () => null, Modal: ({ children, title }: { children: ReactNode; title: string }) => <section aria-label={title}>{children}</section>, writeClipboard: vi.fn(),
}))
afterEach(cleanup)
const file = { id: 'file', conversationId: 'chat', name: '预算.xlsx', bytes: 1024, image: false, mediaType: 'application/octet-stream' } as unknown as ChatAttachment
const page = { width: 800, height: 400, base64: 'AAAA' }
const t = ((key: string, params?: object) => key + (params ? ' ' + JSON.stringify(params) : '')) as never
const preview = (overrides: Partial<OfficePreview>): OfficePreview => ({ pages: [page], pageCount: 1, missingFonts: [], ...overrides })

describe('previewing a file', () => {
  it('shows the pages, and asks again for another worksheet', async () => {
    const previewFile = vi.fn(async (_id: string, sheet?: string) => preview({ sheet: sheet ?? '一', sheets: ['一', '二'], range: 'A1:C9' }))
    render(<FilePreview file={file} commands={{ previewFile } as unknown as PersonalCommands} onClose={() => {}} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('loading')
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '二' } })
    await waitFor(() => expect(previewFile).toHaveBeenLastCalledWith('file', '二'))
    expect((await screen.findByRole('img', { name: '二' })).getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })
  it('asks once for a worksheet with a single sheet, and offers no choice', async () => {
    const previewFile = vi.fn(async () => preview({ sheet: '一', sheets: ['一'] }))
    render(<FilePreview file={file} commands={{ previewFile } as unknown as PersonalCommands} onClose={() => {}} t={t} />)
    await screen.findByRole('img')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(previewFile).toHaveBeenCalledOnce()
  })
  it('says when it shows only part of a file, and which fonts are missing', async () => {
    const previewFile = vi.fn(async () => preview({ sheet: '一', sheets: ['一'], range: 'A1:Z60', clipped: true, missingFonts: ['Calibri'] }))
    render(<FilePreview file={file} commands={{ previewFile } as unknown as PersonalCommands} onClose={() => {}} t={t} />)
    expect(await screen.findByText(/previewClipped/u)).toBeTruthy()
    expect(screen.getByText(/previewFonts.*Calibri/u)).toBeTruthy()
  })
  it('counts the pages left out of a long document', async () => {
    const previewFile = vi.fn(async () => preview({ pages: [page, page], pageCount: 30 }))
    render(<FilePreview file={{ ...file, name: '长文.docx' }} commands={{ previewFile } as unknown as PersonalCommands} onClose={() => {}} t={t} />)
    expect(await screen.findByText(/previewPages.*30/u)).toBeTruthy()
  })
  it('reports a failure', async () => {
    const previewFile = vi.fn(async () => { throw new Error('engine') })
    render(<FilePreview file={file} commands={{ previewFile } as unknown as PersonalCommands} onClose={() => {}} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toContain('failed')
  })
})

describe('file card actions', () => {
  const state = (temporary: boolean, office: boolean, name = '预算.xlsx') => ({
    busy: false, limits: { office },
    detail: { conversation: { id: 'chat', temporary }, messages: [{ id: 'user', role: 'user', text: 'x', time: 0, attachmentIds: ['file'], toolNames: [] }], attachments: [{ ...file, name }], omittedMessages: 0 },
  }) as unknown as PersonalState
  const actions = () => screen.queryAllByRole('button').map(button => button.textContent).filter(label => label === 'previewFile' || label === 'exportPdf')
  it('offers preview and PDF for a saved Office file', () => {
    render(<ChatMessages state={state(false, true)} commands={{} as PersonalCommands} t={t} />)
    expect(actions()).toEqual(['previewFile', 'exportPdf'])
  })
  it('offers neither in Temporary Chat, without the extension, or for other files', () => {
    for (const current of [state(true, true), state(false, false), state(false, true, 'notes.txt')]) {
      render(<ChatMessages state={current} commands={{} as PersonalCommands} t={t} />)
      expect(actions()).toEqual([])
      cleanup()
    }
  })
  it('opens the preview from the card', async () => {
    const previewFile = vi.fn(async () => preview({ sheet: '一', sheets: ['一'] }))
    render(<ChatMessages state={state(false, true)} commands={{ previewFile } as unknown as PersonalCommands} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'previewFile' }))
    await waitFor(() => expect(previewFile).toHaveBeenCalledWith('file', undefined))
  })
})
