/** Read OOXML as bounded, inert source records. */
import { officeFormat } from 'dsh-beluga'
import type { AttachmentText } from 'dsh-beluga'
import { OfficePackage, attr, content, descendants, fail, relationshipId, type Node } from './package.ts'
import { workbookRecords } from './workbook.ts'

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
    for (const part of [main, ...office.names().filter(key => /^word\/(header|footer)\d+\.xml$/u.test(key)).sort()]) {
      const walk = (parent: Node, path: string) => {
        const counts: Record<string, number> = {}
        for (const node of parent.children) {
          counts[node.tag] = (counts[node.tag] ?? 0) + 1
          const label = ({ p: 'paragraph', tbl: 'table', tr: 'row', tc: 'cell' } as Record<string, string>)[node.tag] ?? node.tag
          const location = path + '/' + label + '[' + counts[node.tag] + ']'
          if (node.tag === 'p') emit({ part, location, style: attr(descendants(node, 'pStyle')[0] ?? node, 'val'), text: content(node) })
          else walk(node, location)
        }
      }
      walk(office.xml(part), '')
    }
  } else if (format === 'xlsx') {
    for (const record of workbookRecords(office)) emit(record)
  } else if (format === 'pptx') {
    const main = 'ppt/presentation.xml'
    const rels = office.relationships(main)
    let slide = 0
    for (const item of descendants(office.xml(main), 'sldId')) {
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
