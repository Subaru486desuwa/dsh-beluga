import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { extractOfficeText } from '../../office/src/office.ts'
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))
const read = (files: Record<string, string>, name = 'sample.docx', limit = 100000) => extractOfficeText(zip(files), name, limit, new AbortController().signal)
describe('bounded in-memory Office reading', () => {
  it('keeps Word paragraph order, styles, table coordinates and headers', () => {
    const result = read({ 'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>', 'word/header1.xml': '<w:hdr><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>' })
    expect(result.status).toBe('text')
    expect(result.text).toContain('Heading1')
    expect(result.text).toContain('标题 & 内容')
    expect(result.text).toContain('table[1]/row[1]/cell[1]')
    expect(result.text).toContain('页眉')
  })
  it('resolves workbook relationships and preserves strings, formula and cache separately', () => {
    const result = read({ 'xl/workbook.xml': '<workbook><sheets><sheet name="预算" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet7.xml"/></Relationships>', 'xl/sharedStrings.xml': '<sst><si><t>00123</t></si></sst>', 'xl/worksheets/sheet7.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B4)</f><v>230000</v></c></row></sheetData></worksheet>' }, 'budget.xlsx')
    expect(result.text).toContain('预算')
    expect(result.text).toContain('"value":"00123"')
    expect(result.text).toContain('"formula":"SUM(B2:B4)"')
    expect(result.text).toContain('"cachedValue":"230000"')
    expect(result.text).toContain('not recalculated')
  })
  it('reads slides in presentation order, including notes', () => {
    const result = read({ 'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="r2"/><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>', 'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>', 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>ONE</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>TWO</a:t></a:r></a:p></p:sld>', 'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>', 'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>NOTE</a:t></a:r></a:p></p:notes>' }, 'slides.pptx')
    expect(result.text.indexOf('TWO')).toBeLessThan(result.text.indexOf('ONE'))
    expect(result.text).toContain('NOTE')
  })
  it('rejects traversal, DTD, malformed XML, missing parts and decompression bombs', () => {
    expect(() => read({ '../word/document.xml': '<x/>' })).toThrow()
    expect(() => read({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>' })).toThrow()
    expect(() => read({ 'word/document.xml': '<w:document><bad></w:document>' })).toThrow()
    expect(() => read({ 'nothing.xml': '<x/>' })).toThrow()
    expect(() => read({ 'word/document.xml': '<x>' + 'a'.repeat(100000) + '</x>' }, 'bomb.docx', 1000)).toThrow()
  })
  it('does not resolve external workbook relationships', () => {
    expect(() => read({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Remote" r:id="r"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r" TargetMode="External" Target="https://example.com/data"/></Relationships>' }, 'external.xlsx')).toThrow()
  })
  it('honors cancellation before parsing', () => {
    const controller = new AbortController(); controller.abort()
    expect(() => extractOfficeText(new Uint8Array(), 'x.docx', 100, controller.signal)).toThrow()
  })
})

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssetRepository } from '../src/host/assets.ts'
import { Config } from '../src/host/config.ts'
import type { ConversationId } from '../src/shared/types.ts'
it('reads temporary Office attachments in pages without writing source or extracted text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-memory-'))
  try {
    const assets = new AssetRepository(directory, Config({ dataDir: directory, maxAttachmentTextBytes: 4096 }), () => ({ extractText: extractOfficeText, renderDocument: async () => new Uint8Array() }))
    await assets.initialize()
    const data = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>' + '中文🙂'.repeat(2000) + '</w:t></w:r></w:p></w:body></w:document>' })
    const attachment = await assets.save(randomUUID(), brandString<ConversationId>(randomUUID()), true, 'report.DOCX', data)
    expect(attachment.mediaType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    let offset = 0
    let text = ''
    do {
      const page = await assets.text(attachment, true, offset, new AbortController().signal)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      text += page.text
      if (page.nextOffset === undefined) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    } while (true)
    expect(text).toContain('中文🙂'.repeat(2000))
    expect(await readdir(directory)).toEqual([])
    assets.clearTemporary()
    await expect(assets.read(attachment, true)).rejects.toThrow('unavailable')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
