/** A local stand-in for GitHub's MCP server and the Harness credential store, for the GitHub extension's tests. */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'

export const FIXTURE_TOKEN = 'ghp_fixture0000000000000000000000000000'
export const FIXTURE_LOGIN = 'octo-fixture'
const repository = { owner: z.string(), repo: z.string() }
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export interface FakeGitHub {
  /** The server's endpoint, on this computer. */
  readonly url: string
  /** The headers each HTTP request arrived with. */
  readonly requests: { readonly authorization?: string; readonly toolsets?: string }[]
  /** The tool calls that reached the server, after any approval. */
  readonly calls: { readonly name: string; readonly args: unknown }[]
  close(): Promise<void>
}

/** Answers like GitHub for one token: a read-only and a destructive tool, low- and high-risk changes, a file, an error and a tool Personal Chat never offers. */
export async function fakeGitHub(token = FIXTURE_TOKEN): Promise<FakeGitHub> {
  const requests: { authorization?: string; toolsets?: string }[] = []
  const calls: { name: string; args: unknown }[] = []
  const record = (name: string, args: unknown) => { calls.push({ name, args }) }
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'github-mcp-server', version: 'fixture' })
    server.registerTool('get_me', { description: 'Get my user profile', annotations: { readOnlyHint: true } }, async () => text({ login: FIXTURE_LOGIN, id: 1 }))
    server.registerTool('list_issues', { description: 'List issues in a repository', inputSchema: z.object(repository), annotations: { readOnlyHint: true } }, async args => { record('list_issues', args); return text([{ number: 7, title: 'Fixture issue', state: 'open' }]) })
    server.registerTool('get_file_contents', { description: 'Get file contents', inputSchema: z.object({ ...repository, path: z.string() }), annotations: { readOnlyHint: true } }, async args => {
      record('get_file_contents', args)
      return { content: [{ type: 'resource' as const, resource: { uri: 'repo://fixture/' + args.path, mimeType: 'text/plain', text: 'file body' } }] }
    })
    server.registerTool('get_job_logs', { description: 'Get job logs', inputSchema: z.object({ ...repository, job_id: z.number() }), annotations: { readOnlyHint: true } }, async args => { record('get_job_logs', args); return { content: [{ type: 'text' as const, text: 'job not found' }], isError: true } })
    server.registerTool('add_issue_comment', { description: 'Add a comment to an issue', inputSchema: z.object({ ...repository, issue_number: z.number(), body: z.string() }) }, async args => { record('add_issue_comment', args); return text({ id: 99, body: args.body }) })
    server.registerTool('merge_pull_request', { description: 'Merge a pull request', inputSchema: z.object({ ...repository, pullNumber: z.number() }) }, async args => { record('merge_pull_request', args); return text({ merged: true }) })
    server.registerTool('delete_file', { description: 'Delete a file', inputSchema: z.object({ ...repository, path: z.string() }), annotations: { destructiveHint: true } }, async args => { record('delete_file', args); return text({ deleted: true }) })
    server.registerTool('create_repository', { description: 'Create a repository', inputSchema: z.object({ name: z.string() }) }, async args => { record('create_repository', args); return text({ created: true }) })
    return server
  })
  const http = createServer((incoming, outgoing) => {
    void (async () => {
      const authorization = incoming.headers.authorization
      const toolsets = incoming.headers['x-mcp-toolsets']
      requests.push({ ...(authorization ? { authorization } : {}), ...(typeof toolsets === 'string' ? { toolsets } : {}) })
      if (authorization !== 'Bearer ' + token) { outgoing.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return }
      const response = await handler.fetch(await webRequest(incoming))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) for await (const chunk of response.body) outgoing.write(chunk)
      outgoing.end()
    })().catch(() => { outgoing.destroy() })
  })
  await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve) })
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp/`, requests, calls,
    close: async () => { await handler.close(); http.closeAllConnections(); await new Promise<void>(resolve => { http.close(() => { resolve() }) }) },
  }
}
async function webRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const bodyless = incoming.method === 'GET' || incoming.method === 'HEAD'
  return new Request('http://127.0.0.1' + (incoming.url ?? '/'), { method: incoming.method ?? 'GET', headers, ...(bodyless ? {} : { body: Buffer.concat(chunks) }) })
}

/** The record half of the Harness credential store, in memory. */
export class FakeCredentials {
  readonly records = new Map<CredentialKey, CredentialRecord>()
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return this.records.get(key) }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<void> {
    const next = await mutate(this.records.get(key))
    if (next) this.records.set(key, structuredClone(next))
  }
  async deleteRecord(key: CredentialKey): Promise<void> { this.records.delete(key) }
}
