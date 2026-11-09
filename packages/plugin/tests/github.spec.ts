import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import PersonalChatService from '../lib/index.js'
import GitHubExtension from '../../github/lib/index.js'
import { FakeCredentials, fakeGitHub, FIXTURE_LOGIN, FIXTURE_TOKEN, type FakeGitHub } from './github-fixtures.ts'

const owned: { ctx: Context; path: string; server: FakeGitHub }[] = []
async function setup() {
  const server = await fakeGitHub()
  const path = await mkdtemp(join(tmpdir(), 'personal-chat-github-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PersonalChatService, { dataDir: path })
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials)
  await ctx.plugin(GitHubExtension, { url: server.url })
  owned.push({ ctx, path, server })
  return { ctx, service: ctx.personalChat, github: ctx.personalChatGitHub, credentials, path, server }
}
async function diskText(path: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(path, { withFileTypes: true })) text += entry.isDirectory() ? await diskText(join(path, entry.name)) : (await readFile(join(path, entry.name))).toString('utf8')
  return text
}
/** Puts a stand-in `gh` first on the PATH for one test. */
async function fakeCli(script: string): Promise<() => void> {
  const bin = await mkdtemp(join(tmpdir(), 'personal-chat-gh-'))
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), '#!/bin/sh\n' + script + '\n')
  await chmod(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = bin + ':' + (path ?? '')
  return () => { process.env.PATH = path; void rm(bin, { recursive: true, force: true }) }
}
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.ctx.fiber.dispose()
    await item.server.close()
    await rm(item.path, { recursive: true, force: true })
  }
})

describe('GitHub extension', () => {
  it('connects with a pasted token, keeps it only in the credential store, and offers the tools by risk', async () => {
    const app = await setup()
    expect((await app.service.apps()).github).toEqual({ installed: true, auto: true, approval: 'ask' })
    const view = await app.service.connectGitHub({ token: '  ' + FIXTURE_TOKEN + '\n' })
    expect(view.github).toEqual({ installed: true, account: FIXTURE_LOGIN, source: 'token', auto: true, approval: 'ask' })
    expect(JSON.stringify(view)).not.toContain(FIXTURE_TOKEN)
    expect([...app.credentials.records.values()]).toEqual([{ kind: 'grant', payload: { token: FIXTURE_TOKEN, login: FIXTURE_LOGIN, source: 'token' } }])
    expect(app.server.requests.length).toBeGreaterThan(0)
    expect(app.server.requests.every(request => request.authorization === 'Bearer ' + FIXTURE_TOKEN && request.toolsets === 'default,actions')).toBe(true)
    const tools = await app.github.tools(AbortSignal.timeout(5000))
    expect(Object.fromEntries(tools.map(tool => [tool.name, tool.risk]))).toEqual({ get_me: 'read', list_issues: 'read', get_file_contents: 'read', get_job_logs: 'read', add_issue_comment: 'low', merge_pull_request: 'high', delete_file: 'high' })
    expect(tools.find(tool => tool.name === 'list_issues')?.parameters).toMatchObject({ type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } })
    expect(await diskText(app.path)).not.toContain(FIXTURE_TOKEN)
  })

  it('refuses a token GitHub rejects, and stores nothing', async () => {
    const app = await setup()
    await expect(app.service.connectGitHub({ token: 'ghp_wrong' })).rejects.toThrow('GitHub refused the token')
    await expect(app.service.connectGitHub({ token: 'two words' })).rejects.toThrow('Paste one GitHub token')
    await expect(app.service.connectGitHub({ token: '' })).rejects.toThrow('Paste one GitHub token')
    await expect(app.service.connectGitHub({ token: FIXTURE_TOKEN, cli: true })).rejects.toThrow('Paste one GitHub token')
    expect(app.credentials.records.size).toBe(0)
    expect((await app.service.apps()).github.account).toBeUndefined()
  })

  it('passes files and GitHub’s own errors on as text', async () => {
    const app = await setup()
    await app.service.connectGitHub({ token: FIXTURE_TOKEN })
    const signal = AbortSignal.timeout(5000)
    expect(await app.github.call('get_file_contents', { owner: 'o', repo: 'r', path: 'README.md' }, signal)).toEqual({ text: 'file body', isError: false })
    expect(await app.github.call('get_job_logs', { owner: 'o', repo: 'r', job_id: 1 }, signal)).toEqual({ text: 'job not found', isError: true })
  })

  it('reads the GitHub CLI sign-in only when asked, and says when there is none', async () => {
    const app = await setup()
    let restore = await fakeCli('[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && echo ' + FIXTURE_TOKEN)
    try { expect((await app.service.connectGitHub({ cli: true })).github).toMatchObject({ account: FIXTURE_LOGIN, source: 'gh-cli' }) }
    finally { restore() }
    await app.service.disconnectGitHub()
    restore = await fakeCli('echo "not logged in" >&2; exit 1')
    try { await expect(app.service.connectGitHub({ cli: true })).rejects.toThrow('gh auth login') }
    finally { restore() }
    expect(app.credentials.records.size).toBe(0)
  })

  it('forgets the token on disconnect, and then offers no tools', async () => {
    const app = await setup()
    await app.service.connectGitHub({ token: FIXTURE_TOKEN })
    expect((await app.service.disconnectGitHub()).github).toEqual({ installed: true, auto: true, approval: 'ask' })
    expect(app.credentials.records.size).toBe(0)
    await expect(app.github.tools(AbortSignal.timeout(5000))).rejects.toThrow('Connect a GitHub account')
  })

  it('reports the extension missing, and refuses to connect without it', async () => {
    const path = await mkdtemp(join(tmpdir(), 'personal-chat-github-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PersonalChatService, { dataDir: path })
    owned.push({ ctx, path, server: { url: '', requests: [], calls: [], close: async () => {} } })
    expect((await ctx.personalChat.apps()).github).toEqual({ installed: false, auto: true, approval: 'ask' })
    await expect(ctx.personalChat.connectGitHub({ token: FIXTURE_TOKEN })).rejects.toThrow('Install and enable the optional GitHub extension')
  })
})
