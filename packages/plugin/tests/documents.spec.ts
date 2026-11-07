import { expect, it } from 'vitest'
import { extractOfficeText } from '../../office/src/office.ts'
import { renderDocument } from '../../office/src/documents.ts'
import { reviseDocument, validateDocument } from '../src/host/documents.ts'

it('generates editable headings, paragraphs and tables, revising only addressed blocks', async () => {
  const source = validateDocument({ title: '预算报告', blocks: [{ kind: 'heading', level: 1, text: '预算' }, { kind: 'paragraph', text: '原始分析' }, { kind: 'table', rows: [['预算', '实际'], ['230000', '235000']] }] })
  const revised = reviseDocument(source, [{ index: 1, block: { kind: 'paragraph', text: '差额 5000，差额率 2.17%' } }])
  expect(source.blocks[1]).toEqual({ kind: 'paragraph', text: '原始分析' })
  expect(revised.blocks[0]).toEqual(source.blocks[0])
  expect(revised.blocks[2]).toEqual(source.blocks[2])
  const bytes = await renderDocument(revised, new AbortController().signal)
  const result = extractOfficeText(bytes, 'report.docx', 16000000, new AbortController().signal)
  expect(result.text).toContain('Heading1')
  expect(result.text).toContain('230000')
  expect(result.text).toContain('差额 5000')
  expect(result.text).not.toContain('原始分析')
})
it('rejects ambiguous targets, executable fields and malformed tables', () => {
  const source = validateDocument({ title: 't', blocks: [{ kind: 'paragraph', text: 'a' }] })
  expect(() => reviseDocument(source, [{ index: 2, block: source.blocks[0]! }])).toThrow()
  expect(() => reviseDocument(source, [{ index: 0, block: source.blocks[0]! }, { index: 0, block: source.blocks[0]! }])).toThrow()
  expect(() => validateDocument({ ...source, code: 'process.exit()' })).toThrow()
  expect(() => validateDocument({ title: 't', blocks: [{ kind: 'table', rows: [['a'], ['a', 'b']] }] })).toThrow()
})
it('does not finish a cancelled generation', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(renderDocument({ title: 't', blocks: [{ kind: 'paragraph', text: 'a' }] }, controller.signal)).rejects.toThrow()
})
