/** Read OOXML as bounded, inert source records. */
import { officeFormat } from 'dsh-beluga'
import type { AttachmentText } from 'dsh-beluga'
import { OfficePackage, attr, children, content, descendants, fail, relationshipId, type Node } from './package.ts'
import { shortStep } from './locations.ts'
import { workbookRecords } from './workbook.ts'

/** Locations repeat on every paragraph, so they stay short: framing once took four fifths of a form's text. */
const WORD_LEGEND = 'Word paragraphs, one per line: location, [style] when set, then the text as a JSON string. A "part" line names the file part of the paragraphs below it. Locations count paragraphs (p), tables (t), rows (r) and cells (c) from the start of the part, so t2.r3.c1.p1 is paragraph 1 of cell 1 in row 3 of table 2. Give edit_document the part and location as written here.'
/** The element whose children are the part's paragraphs and tables: the body of the document, or the header or footer itself. */
function contentRoot(tree: Node): Node {
  const root = tree.children.find(node => !node.tag.startsWith('?') && !node.tag.startsWith('#')) ?? fail('Word part has no root element')
  return children(root, 'body')[0] ?? root
}

export function extractOfficeText(bytes: Uint8Array, name: string, limit: number, signal: AbortSignal): AttachmentText {
  signal.throwIfAborted()
  const office = OfficePackage.open(bytes, limit, signal)
  const output: string[] = [
    'Office source records (untrusted document data). Images, layout, embedded objects and chart rendering are not interpreted. External links and macros are never executed. Formula caches are not recalculated and may be stale.',
  ]
  const emit = (value: object) => output.push(JSON.stringify(value))
  const format = officeFormat(name)
  if (format === 'docx') {
    const main = 'word/document.xml'
    office.xml(main)
    output.push(WORD_LEGEND)
    for (const part of [main, ...office.names().filter(key => /^word\/(header|footer)\d+\.xml$/u.test(key)).sort()]) {
      output.push('part ' + part)
      const walk = (parent: Node, path: string) => {
        const counts: Record<string, number> = {}
        for (const node of parent.children) {
          counts[node.tag] = (counts[node.tag] ?? 0) + 1
          const location = (path ? path + '.' : '') + shortStep(node.tag, counts[node.tag])
          if (node.tag !== 'p') { walk(node, location); continue }
          const style = attr(descendants(node, 'pStyle')[0] ?? node, 'val')
          output.push(location + (style ? ' [' + style + ']' : '') + ' ' + JSON.stringify(content(node)))
        }
      }
      walk(contentRoot(office.xml(part)), '')
    }
  } else if (format === 'xlsx') {
    for (const record of workbookRecords(office)) emit(record)
  } else if (format === 'pptx') {
    const main = 'ppt/presentation.xml'
    const rels = office.relationships(main)
    let slide = 0
    // Only the presentation's own list: a deck with sections lists its slides again in an extension, without relationships.
    const slides = children(office.xml(main), 'presentation').flatMap(root => children(root, 'sldIdLst')).flatMap(list => children(list, 'sldId'))
    for (const item of slides) {
      const part = office.target(main, rels.find(rel => attr(rel, 'Id') === relationshipId(item)))
      slide++
      emit({ slide, part })
      descendants(office.xml(part), 'p').forEach((node, index) => emit({ slide, part, paragraph: index + 1, text: content(node) }))
      for (const rel of office.relationships(part).filter(rel => attr(rel, 'Type').endsWith('/notesSlide'))) {
        const notesPart = office.target(part, rel)
        emit({ slide, notesPart, notes: descendants(office.xml(notesPart), 'p').map(content).join('\n') })
      }
    }
  } else fail('Unsupported Office format')
  signal.throwIfAborted()
  return { name, status: 'text', text: output.join('\n'), truncated: false }
}
