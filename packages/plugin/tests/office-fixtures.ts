import { strToU8, zipSync } from 'fflate'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** The smallest package both Excel and LibreOffice accept. */
export function workbook(sheets: Record<string, string>, extra: Record<string, string> = {}, workbookExtra = ''): Uint8Array {
  const names = Object.keys(sheets)
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + names.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets>${names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>${workbookExtra}</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(names.map((name, index) => [`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetData>${sheets[name]}</sheetData></worksheet>`])),
    ...extra,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
/** A minimal DOCX around this body, with any other parts given as text. */
export function wordDocument(body: string, extra: Readonly<Record<string, string>> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  }
  for (const [name, text] of Object.entries(extra)) files[name] = strToU8(text)
  return zipSync(files)
}
/** The Word paragraphs in `read_attachment` text, which may be several pages joined back together. */
export function wordParagraphs(text: string): { part: string; location: string; style: string; text: string }[] {
  let part = ''
  const found: { part: string; location: string; style: string; text: string }[] = []
  for (const line of text.split('\n').slice(2)) {
    if (line.startsWith('part ')) { part = line.slice(5); continue }
    const match = /^(\S+)(?: \[([^\]]*)\])? (".*")$/u.exec(line)
    if (!match) throw new Error('Not a paragraph line: ' + line)
    found.push({ part, location: match[1]!, style: match[2] ?? '', text: JSON.parse(match[3]!) as string })
  }
  return found
}
/**
 * A synthetic application form the size of a real one: 19 tables of short labels, 26 paragraphs each,
 * with the second cell of row 2 left empty in the first eight tables.
 */
export function formDocument(): Uint8Array {
  const paragraph = (text: string) => text ? `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` : '<w:p/>'
  let body = ''
  for (let table = 1; table <= 19; table++) {
    body += paragraph(`第${table}部分填写说明`) + (table % 2 ? paragraph(`第${table}部分的补充说明文字`) : '')
    let rows = ''
    for (let row = 1; row <= 6; row++) {
      let cells = ''
      for (let cell = 1; cell <= 4; cell++) {
        const empty = table <= 8 && row === 2 && cell === 2
        const extra = row === 6 && cell >= 3 ? paragraph(`表${table}行${row}列${cell}第二段说明`) : ''
        cells += `<w:tc>${paragraph(empty ? '' : `表${table}行${row}列${cell}的字段说明`)}${extra}</w:tc>`
      }
      rows += `<w:tr>${cells}</w:tr>`
    }
    body += `<w:tbl>${rows}</w:tbl>`
  }
  return wordDocument(body)
}
export const wordXml = (part: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}>${part}</w:ftr>`
/** A synthetic budget deck that uses every layout once; its figures are those of the budget workbook and report. */
export const budgetDeck = (image: string) => ({
  title: '2026 年度预算回顾',
  slides: [
    { layout: 'title', title: '2026 年度预算回顾', subtitle: '全年预算 230,000 元，实际支出 235,000 元', notes: '开场：先说结论，超支 5,000 元。' },
    { layout: 'section', title: '一、执行概况' },
    { layout: 'metrics', title: '全年关键数字', metrics: [{ value: '230,000', label: '全年预算（元）' }, { value: '235,000', label: '实际支出（元）' }, { value: '5,000', label: '超支金额（元）' }, { value: '2.17%', label: '超支比例' }] },
    { layout: 'chart', title: '各季度预算与实际', chart: 'column', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '预算', values: [55000, 57000, 58000, 60000] }, { name: '实际', values: [54000, 58500, 62000, 60500] }], unit: '元' },
    { layout: 'table', title: '季度明细', rows: [['季度', '预算（元）', '实际（元）', '差额（元）'], ['Q1', '55,000', '54,000', '-1,000'], ['Q2', '57,000', '58,500', '1,500'], ['Q3', '58,000', '62,000', '4,000'], ['Q4', '60,000', '60,500', '500'], ['合计', '230,000', '235,000', '5,000']] },
    { layout: 'two_column', title: '经验与问题', left: { heading: '做得好的', bullets: ['Q1 支出低于预算 1,000 元', '采购集中在年初完成'] }, right: { heading: '需要改进', bullets: ['Q3 超支 4,000 元，主要来自临时外包', { text: '外包合同未提前比价', level: 2 }, '全年超支比例 2.17%'] } },
    { layout: 'bullets', title: '2027 年改进计划', bullets: ['每季度末复盘一次预算执行', { text: '偏差超过 3% 时提前预警', level: 2 }, '外包项目先比价再签约', 'Keep the total within 235,000 and review it monthly'], notes: '强调预警阈值。' },
    { layout: 'image', title: '季度支出走势', image, bullets: ['下半年支出明显上升', 'Q3 为全年峰值 62,000 元'] },
  ],
})
