import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { validateDocument, type DocumentInput } from 'dsh-beluga'
export async function renderDocument(input: DocumentInput, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const source = validateDocument(input)
  const paragraph = (value: string) => new Paragraph({ children: [new TextRun({ text: value, font: 'Noto Sans CJK SC' })], spacing: { after: 160 } })
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const
  const children = source.blocks.map(block => block.kind === 'table'
    ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(value => new TableCell({ children: [paragraph(value)] })) })) })
    : block.kind === 'heading' ? new Paragraph({ heading: levels[block.level - 1], children: [new TextRun({ text: block.text, font: 'Noto Sans CJK SC' })] })
    : paragraph(block.text))
  const document = new Document({ title: source.title, styles: { default: { document: { run: { font: 'Noto Sans CJK SC', size: 22 } } } }, sections: [{ children }] })
  const result = await Packer.toBuffer(document)
  signal.throwIfAborted()
  return result
}
