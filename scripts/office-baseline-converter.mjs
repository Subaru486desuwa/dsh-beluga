/** Probe the installed public converter in an isolated Cordis lifetime. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const binary = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const require = createRequire(join(dirname(dirname(binary)), 'package.json'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: OfficeToPdf, OfficeSourceKey } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-office-to-pdf')).href)
const ctx = new Context()
const results = []
try {
  await ctx.plugin(OfficeToPdf, { maxCachedEntries: 1, maxCachedBytes: 1, maxSourceEntries: 1 })
  for (const name of ['office-report.docx', 'office-budget.xlsx', 'office-brief.pptx']) {
    const path = join(root, '.artifacts/office-baseline/fixtures', name)
    const size = (await stat(path)).size
    try {
      const result = await ctx.officeToPdf.convert({ extension: extname(name).slice(1), priority: 'foreground', source: {
        key: OfficeSourceKey('synthetic-office-baseline:' + name), version: 'fixture-v1', bytes: size,
        async read(signal, maxBytes) { signal.throwIfAborted(); const bytes = await readFile(path); if (bytes.length > maxBytes) throw new Error('Fixture exceeds source allowance'); return { bytes, version: 'fixture-v1' } },
      } }, AbortSignal.timeout(65000))
      if (Buffer.from(result.pdf).subarray(0, 5).toString() !== '%PDF-') throw new Error('Converter did not return a PDF')
      await writeFile(path.slice(0, -extname(name).length) + '.pdf', result.pdf)
      results.push({ name, status: 'converted', pdfBytes: result.pdf.length, missingFonts: result.missingFonts })
    } catch (error) { results.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
  }
} finally { await ctx.fiber.dispose() }
await writeFile(join(root, '.artifacts/office-baseline/converter-results.json'), JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
if (results.some(item => item.status !== 'converted')) process.exitCode = 1
