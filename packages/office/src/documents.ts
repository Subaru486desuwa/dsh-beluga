import { AlignmentType, Document, Footer, Header, HeadingLevel, Packer, PageBreak, PageNumber, Paragraph, Table, TableCell, TableOfContents, TableRow, TextRun, WidthType } from 'docx'
import { ChartRun } from 'docx/charts'
import { htmlToContent } from 'docx/html'
import { estimatePageNumbersWith } from 'docx/layout'
import { validateDocument, type DocumentInput } from 'dsh-beluga'

/** Fonts Office installs on Windows and macOS, so a file looks the same on either. */
const FONT = { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Calibri', eastAsia: 'Microsoft YaHei' }
const CHART_SIZE = { width: 600, height: 340 }
const REPORTED_WARNINGS = 10
const LEVELS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const
const textBlock = (value: string) => new Paragraph({ text: value, spacing: { after: 160 } })
type Block = DocumentInput['blocks'][number]

function content(block: Block, warn: (message: string) => void): readonly (Paragraph | Table | TableOfContents)[] {
  switch (block.kind) {
    case 'paragraph': return [textBlock(block.text)]
    case 'heading': return [new Paragraph({ heading: LEVELS[block.level - 1]!, text: block.text })]
    case 'table': return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(value => new TableCell({ children: [textBlock(value)] })) })) })]
    case 'html': return htmlToContent(block.html, { onWarning: warning => warn(warning.message) })
    case 'chart': {
      const { chart, title, categories, series } = block
      const options = { ...(title ? { title } : {}), categories, series, transformation: CHART_SIZE }
      return [new Paragraph({ children: [chart === 'pie' ? new ChartRun({ type: 'pie', ...options }) : new ChartRun({ type: chart, ...options })] })]
    }
    case 'toc': return [new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' })]
    case 'pageBreak': return [new Paragraph({ children: [new PageBreak()] })]
  }
}
/** @returns the file, and what the source asked for that it could not include. */
export async function renderDocument(input: DocumentInput, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly warnings: readonly string[] }> {
  signal.throwIfAborted()
  const source = validateDocument(input)
  const warnings: string[] = []
  const children = source.blocks.flatMap(block => content(block, message => warnings.push(message)))
  const page = (source.pageNumbers ?? true) ? { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 18 })] })] }) } : undefined
  const header = source.header ? { default: new Header({ children: [new Paragraph({ text: source.header, alignment: AlignmentType.RIGHT })] }) } : undefined
  const document = new Document({
    title: source.title,
    // Guessing past an unmeasured font still beats a table of contents with no page numbers.
    pageNumbers: estimatePageNumbersWith({ guess: true }),
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ children: [...children], ...(page ? { footers: page } : {}), ...(header ? { headers: header } : {}) }],
  })
  const bytes = await Packer.toBuffer(document)
  signal.throwIfAborted()
  return { bytes, warnings: warnings.slice(0, REPORTED_WARNINGS) }
}
