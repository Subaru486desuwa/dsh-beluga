/** Isolated visual QA for a generated, synthetic Word artifact; no daily profile changes. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFile, realpath, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderDocument } from '../packages/office/lib/types/documents.js'
const directory = new URL('../.artifacts/office-artifacts/', import.meta.url)
await mkdir(directory, { recursive: true })
const bytes = await renderDocument({ title: '预算与实际分析', blocks: [
  { kind: 'heading', level: 1, text: '预算与实际分析' },
  { kind: 'paragraph', text: '本期预算 230,000，实际 235,000，超出预算 5,000，差额率 2.17%。' },
  { kind: 'table', rows: [['指标', '金额 / 比例'], ['预算', '230,000'], ['实际', '235,000'], ['差额', '5,000'], ['差额率', '2.17%']] },
  { kind: 'heading', level: 2, text: '分析与行动' },
  { kind: 'paragraph', text: '核查超支来源；原始数据与计算假设保留，后续仅修订指定段落。' },
] }, new AbortController().signal)
await writeFile(new URL('generated-report.docx', directory), bytes)
const binary = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const require = createRequire(join(dirname(dirname(binary)), 'package.json'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: OfficeToPdf, OfficeSourceKey } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-office-to-pdf')).href)
const ctx = new Context()
try {
  await ctx.plugin(OfficeToPdf, { maxCachedEntries: 1, maxCachedBytes: 1, maxSourceEntries: 1 })
  const result = await ctx.officeToPdf.convert({ extension: 'docx', priority: 'foreground', source: {
    key: OfficeSourceKey('personal-chat-generated-synthetic-report'), version: '1', bytes: bytes.length,
    async read(signal) { signal.throwIfAborted(); return { bytes, version: '1' } },
  } }, AbortSignal.timeout(65000))
  await writeFile(new URL('generated-report.pdf', directory), result.pdf)
  await writeFile(new URL('render-result.json', directory), JSON.stringify({ missingFonts: result.missingFonts, pdfBytes: result.pdf.length }, null, 2))
  console.log({ missingFonts: result.missingFonts, pdfBytes: result.pdf.length })
} finally { await ctx.fiber.dispose() }
