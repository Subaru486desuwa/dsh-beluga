import { z } from 'zod'
import { PersonalChatError } from './archive.ts'

const text = z.string().max(20000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), 'XML control characters are not allowed')
export const documentBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), text }).strict(),
  z.object({ kind: z.literal('heading'), text, level: z.number().int().min(1).max(3) }).strict(),
  z.object({ kind: z.literal('table'), rows: z.array(z.array(text).min(1).max(12)).min(1).max(200) }).strict(),
])
export const documentInput = z.object({ title: text, blocks: z.array(documentBlock).min(1).max(500) }).strict()
export type DocumentInput = z.infer<typeof documentInput>
export function validateDocument(input: unknown): DocumentInput {
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new PersonalChatError('document-limit', 'Document source exceeds 256 KiB')
  const value = documentInput.parse(input)
  for (const block of value.blocks) if (block.kind === 'table' && block.rows.some(row => row.length !== block.rows[0]!.length)) throw new PersonalChatError('document-table', 'All table rows must have equal column counts')
  return value
}
export function reviseDocument(source: DocumentInput, changes: readonly { index: number; block: z.infer<typeof documentBlock> }[]): DocumentInput {
  const seen = new Set<number>()
  const next = structuredClone(source)
  for (const change of changes) {
    if (!Number.isInteger(change.index) || change.index < 0 || change.index >= next.blocks.length || seen.has(change.index)) throw new PersonalChatError('document-target', 'Use distinct zero-based block indices from inspect_document')
    seen.add(change.index)
    next.blocks[change.index] = documentBlock.parse(change.block)
  }
  return validateDocument(next)
}
