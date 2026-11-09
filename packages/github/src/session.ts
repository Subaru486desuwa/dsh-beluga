import { Client, ProtocolError, SdkError, SdkErrorCode, StreamableHTTPClientTransport, UnauthorizedError, type FetchLike, type Tool } from '@modelcontextprotocol/client'
import { PersonalChatError, type ActionRisk, type GitHubTool } from 'dsh-beluga'

/** Tools Personal Chat never offers: they create or remove whole repositories, or only feed other clients' UI. */
const NEVER = new Set(['create_repository', 'fork_repository', 'delete_repository', 'ui_get'])
/** Changes that are easy to see and undo: comments, issues, branches, and pull requests opened, edited or sent for review. */
const LOW_RISK = new Set(['add_comment_to_pending_review', 'add_issue_comment', 'add_reply_to_pull_request_comment', 'create_branch', 'create_pull_request', 'issue_write', 'request_copilot_review', 'sub_issue_write', 'update_issue_comment', 'update_pull_request', 'update_pull_request_branch'])
/** The model calls a tool as `github__<name>`, and model APIs allow 64 characters. */
const NAME = /^[A-Za-z0-9_-]{1,56}$/u

/** A tool the server marks read-only changes nothing; any other change is high-risk unless it is known to be easy to undo. */
export function riskOf(tool: Tool): ActionRisk {
  if (tool.annotations?.readOnlyHint === true) return 'read'
  return tool.annotations?.destructiveHint !== true && LOW_RISK.has(tool.name) ? 'low' : 'high'
}

export interface SessionOptions {
  readonly url: string
  readonly toolsets: readonly string[]
  readonly timeoutMs: number
  readonly fetch?: FetchLike
}

/** One token's connection to the GitHub MCP server. A failed connection is dropped, so the next call opens a new one. */
export class GitHubSession {
  private client?: Promise<Client>
  private listing?: Promise<readonly GitHubTool[]>
  constructor(private readonly options: SessionOptions, private readonly token: string) {}
  /** @returns the login of the account the token belongs to. */
  async login(signal: AbortSignal): Promise<string> {
    const { text, isError } = await this.call('get_me', {}, signal)
    let login: unknown
    try { login = isError ? undefined : (JSON.parse(text) as { login?: unknown }).login } catch { /* Checked below. */ }
    if (typeof login !== 'string' || !login) throw new PersonalChatError('github-error', 'GitHub did not say which account the token belongs to')
    return login
  }
  /** The server's tools for this token, listed once; Personal Chat's exclusions are left out. */
  tools(signal: AbortSignal): Promise<readonly GitHubTool[]> {
    this.listing ??= this.list(signal).catch((error: unknown) => { this.listing = undefined; throw error })
    return this.listing
  }
  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly text: string; readonly isError: boolean }> {
    const client = await this.connect(signal)
    const result = await this.guard(() => client.callTool({ name, arguments: { ...args } }, { signal, timeout: this.options.timeoutMs }), signal)
    const text = result.content.map(block => block.type === 'text' ? block.text : block.type === 'resource' && 'text' in block.resource ? block.resource.text : '[' + block.type + ' omitted]').join('\n')
    return { text, isError: result.isError === true }
  }
  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    try { await (await client)?.close() } catch { /* A connection that never opened has nothing to close. */ }
  }
  private async list(signal: AbortSignal): Promise<readonly GitHubTool[]> {
    const client = await this.connect(signal)
    const tools: GitHubTool[] = []
    let cursor: string | undefined
    do {
      const page = await this.guard(() => client.listTools(cursor === undefined ? {} : { cursor }, { signal, timeout: this.options.timeoutMs }), signal)
      for (const tool of page.tools) if (!NEVER.has(tool.name) && NAME.test(tool.name)) tools.push({ name: tool.name, description: tool.description ?? tool.title ?? tool.name, parameters: tool.inputSchema as Record<string, unknown>, risk: riskOf(tool) })
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }
  private connect(signal: AbortSignal): Promise<Client> {
    this.client ??= (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        authProvider: { token: async () => this.token },
        requestInit: { headers: { 'X-MCP-Toolsets': this.options.toolsets.join(',') } },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      })
      const client = new Client({ name: 'dsh-beluga-github', version: '0.1.0' })
      await this.guard(() => client.connect(transport, { signal, timeout: this.options.timeoutMs }), signal)
      return client
    })().catch((error: unknown) => { this.client = undefined; throw error })
    return this.client
  }
  /** GitHub's own answers reach the model; a refused token or a lost connection becomes a short reason, and the connection is dropped. */
  private async guard<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (signal.aborted || error instanceof PersonalChatError) throw error
      if (error instanceof ProtocolError) throw new PersonalChatError('github-error', error.message.slice(0, 500))
      void this.close()
      if (error instanceof UnauthorizedError) throw new PersonalChatError('github-token-rejected', 'GitHub refused the token; connect again on the Apps page with a valid one')
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) throw new PersonalChatError('github-timeout', 'GitHub did not answer in time')
      throw new PersonalChatError('github-unreachable', 'GitHub could not be reached')
    }
  }
}
