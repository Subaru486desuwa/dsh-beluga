/** Exercise current, built Chat with genuine Office inputs; record gaps as gaps. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import PersonalChat from '../packages/plugin/lib/index.js'
import remote from '../packages/plugin/lib/typert.remote-client.js'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../packages/plugin/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: LlmRuntime, LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
class Probe extends LlmAdapter {
  requests = []
  nextTool
  providerInfo() { return { id: 'office-probe', name: 'Office protocol probe' } }
  async listModels() { return [{ provider: 'office-probe', id: 'fixture', name: 'No external calls', inputModalities: ['text'] }] }
  async *stream(options) {
    this.requests.push({ tools: options.tools?.map(item => item.name) ?? [], sessionId: options.sessionId })
    const call = this.nextTool; this.nextTool = undefined
    if (call) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: 'Protocol probe completed; no semantic model evaluation.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-office-baseline-'))
const ctx = new Context()
const probe = new Probe()
const observations = []
const route = { provider: 'office-probe', model: 'fixture' }
async function settled(id) {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 15000)
  try {
    for await (const update of ctx.personalChat.followConversation({ conversationId: id }, control.signal)) {
      if (update.kind === 'failure') throw new Error(update.reason)
      if (update.kind === 'snapshot' && !update.detail.live) return update.detail
    }
    throw new Error('Probe did not settle')
  } finally { clearTimeout(timer); control.abort() }
}
async function invoke(chat, name, args, attachmentIds = [], text = 'OFFICE_BASELINE_REQUEST') {
  probe.nextTool = { name, arguments: args }
  await ctx.personalChat.send({ conversationId: chat.conversation.id, branchId: chat.conversation.selectedBranchId, requestId: randomUUID(), text, model: route, attachmentIds })
  const detail = await settled(chat.conversation.id)
  const result = detail.messages.findLast(message => message.role === 'tool')
  assert.ok(result, 'Expected a real plugin tool result')
  return JSON.parse(result.text)
}
async function scan(directory) {
  const buffers = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) buffers.push(...await scan(path)); else buffers.push(await readFile(path))
  }
  return buffers
}
try {
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['office-probe'], probe)
  await ctx.plugin(PersonalChat, { dataDir })
  for (const [name, canary] of [['office-report.docx', 'WORD_CANARY_20261106'], ['office-budget.xlsx', 'XLSX_CANARY_20261106'], ['office-brief.pptx', 'PPTX_CANARY_20261106']]) {
    const chat = await ctx.personalChat.create({ temporary: false })
    const data = await readFile(join(root, '.artifacts/office-baseline/fixtures', name))
    const attachment = await ctx.personalChat.upload({ conversationId: chat.conversation.id, name, base64: data.toString('base64') })
    const downloaded = await ctx.personalChat.attachment({ conversationId: chat.conversation.id, attachmentId: attachment.id, original: true })
    assert.deepEqual(Buffer.from(downloaded.base64, 'base64'), data)
    observations.push({ case: name + ':upload-download', status: 'supported', bytes: data.length, mediaType: attachment.mediaType })
    const result = await invoke(chat, 'read_attachment', { attachmentId: attachment.id }, [attachment.id])
    assert.equal(result.status, 'unsupported')
    assert.equal(result.text, '')
    assert.ok(!JSON.stringify(result).includes(canary))
    observations.push({ case: name + ':native-read', status: 'missing', observed: result.status, reason: result.reason })
    await ctx.personalChat.deleteConversation({ conversationId: chat.conversation.id })
  }
  for (const [name, canary] of [['office-budget.csv', 'R&D,100000,120000'], ['office-notes.txt', 'TEXT_CANARY_20261106'], ['office-report.pdf', 'WORD_CANARY_20261106']]) {
    const chat = await ctx.personalChat.create({ temporary: false })
    const data = await readFile(join(root, '.artifacts/office-baseline/fixtures', name))
    const attachment = await ctx.personalChat.upload({ conversationId: chat.conversation.id, name, base64: data.toString('base64') })
    const result = await invoke(chat, 'read_attachment', { attachmentId: attachment.id }, [attachment.id])
    assert.equal(result.status, 'text')
    assert.ok(result.text.includes(canary), 'Expected source content from ' + name)
    observations.push({ case: name + ':read', status: 'supported', textCharacters: result.text.length })
    await ctx.personalChat.deleteConversation({ conversationId: chat.conversation.id })
  }
  for (const [tool, format] of [['create_document', 'docx'], ['create_spreadsheet', 'xlsx'], ['create_presentation', 'pptx']]) {
    const chat = await ctx.personalChat.create({ temporary: false })
    const result = await invoke(chat, tool, { fileName: 'requested.' + format })
    assert.equal(result.error, 'tool-forbidden')
    observations.push({ case: format + ':native-create-edit', status: 'missing', observed: result.error })
    await ctx.personalChat.deleteConversation({ conversationId: chat.conversation.id })
  }
  const normal = await ctx.personalChat.create({ temporary: false })
  const other = await ctx.personalChat.create({ temporary: false })
  const word = await readFile(join(root, '.artifacts/office-baseline/fixtures/office-report.docx'))
  const file = await ctx.personalChat.upload({ conversationId: normal.conversation.id, name: 'office-report.docx', base64: word.toString('base64') })
  await assert.rejects(() => ctx.personalChat.attachment({ conversationId: other.conversation.id, attachmentId: file.id }), /belong/)
  observations.push({ case: 'office-cross-chat-ownership', status: 'guard-passed' })
  await ctx.personalChat.deleteConversation({ conversationId: normal.conversation.id })
  await ctx.personalChat.deleteConversation({ conversationId: other.conversation.id })
  const temporary = await ctx.personalChat.create({ temporary: true })
  const transient = await ctx.personalChat.upload({ conversationId: temporary.conversation.id, name: 'office-report.docx', base64: word.toString('base64') })
  await invoke(temporary, 'read_attachment', { attachmentId: transient.id }, [transient.id], 'OFFICE_TEMP_CANARY_20261106')
  await assert.rejects(() => ctx.personalChat.memoryState({ conversationId: temporary.conversation.id }), /Temporary/)
  await ctx.personalChat.closeTemporary({ conversationId: temporary.conversation.id })
  assert.deepEqual(await readdir(join(dataDir, 'attachments')), [])
  assert.ok((await scan(dataDir)).every(buffer => !buffer.includes('OFFICE_TEMP_CANARY_20261106')))
  observations.push({ case: 'temporary-office-retention', status: 'guard-passed' })
  assert.ok(probe.requests.every(request => request.sessionId === undefined))
  const tools = [...new Set(probe.requests.flatMap(request => request.tools))].sort()
  const methods = Object.keys(remote.methods).sort()
  assert.ok(!tools.some(name => /create|write|export|render|office/u.test(name)))
  assert.ok(!methods.some(name => /document|spreadsheet|presentation|artifact|previewOffice/u.test(name)))
  const report = { build: 'current lib/index.js; unchanged product source', model: 'scripted protocol probe only; no live model quality claims', observations, tools, remoteMethods: methods, nativeOfficeReadiness: 'blocked', fixtureData: 'synthetic genuine OOXML; not personal exports' }
  await writeFile(join(root, '.artifacts/office-baseline/runtime-results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await ctx.fiber.dispose(); await rm(dataDir, { recursive: true, force: true }) }
