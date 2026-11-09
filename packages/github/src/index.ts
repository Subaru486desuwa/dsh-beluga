import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { PersonalChatError, type GitHubAccount, type GitHubConnector, type GitHubTool } from 'dsh-beluga'
import { GitHubSession } from './session.ts'

const run = promisify(execFile)
/** Holds the token with the account it signed in as; only this extension reads it. */
const RECORD = credentialKey('dsh-beluga-github', 'account')
/** Plain HTTP reaches only this computer, as a test server does. */
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** How long the tool list may take when it is warmed at startup. */
const WARM_MS = 30000
interface Grant { readonly token: string; readonly login: string; readonly source: GitHubAccount['source'] }
function grantOf(payload: unknown): Grant | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const { token, login, source } = payload as Record<string, unknown>
  return typeof token === 'string' && token && typeof login === 'string' && login && (source === 'token' || source === 'gh-cli') ? { token, login, source } : undefined
}
/** The token the GitHub CLI signed in with on this computer, read only when the person asks for it. */
async function cliToken(signal: AbortSignal): Promise<string> {
  let token = ''
  try { token = (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { signal, timeout: 10000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout.trim() }
  catch { /* Reported below. */ }
  if (!token || /\s/u.test(token)) throw new PersonalChatError('github-cli-unavailable', 'Sign in with `gh auth login` on this computer first, or paste a token')
  return token
}

export interface Config { url: string; toolsets: string[]; timeoutMs: number }
export const Config: z<Config> = z.object({
  url: z.string().default('https://api.githubcopilot.com/mcp/').description('GitHub MCP server, over Streamable HTTP'),
  toolsets: z.array(z.string()).default(['default', 'actions']).description('Toolsets the server offers: the default ones, and Actions for CI'),
  timeoutMs: z.natural().min(1000).default(60000).description('Per request to GitHub'),
})

/** GitHub for Beluga: a token kept in the Harness credential store, and GitHub's MCP server for the tools. */
export default class PersonalChatGitHub extends Service implements GitHubConnector {
  static inject = ['personalChat', 'credentials']
  static Config = Config
  private readonly config: Config
  private session?: GitHubSession
  private sessionToken?: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'personalChatGitHub')
    this.config = Config(config)
    const url = new URL(this.config.url)
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.has(url.hostname)))) throw new PersonalChatError('invalid-config', 'The GitHub MCP server must use HTTPS')
    ctx.effect(() => () => { void this.replace(undefined, undefined) })
  }
  /** A reply should not wait for the tool list, so a stored token's list is fetched at startup. */
  protected async [Service.init](): Promise<void> {
    if (await this.grant()) void this.current().then(session => session.tools(AbortSignal.timeout(WARM_MS))).catch(() => { /* The first reply tries again and reports it. */ })
  }
  async account(): Promise<GitHubAccount | undefined> {
    const grant = await this.grant()
    return grant && { login: grant.login, source: grant.source }
  }
  async connect(source: { readonly token: string } | { readonly cli: true }, signal: AbortSignal): Promise<GitHubAccount> {
    const token = 'token' in source ? source.token : await cliToken(signal)
    const kind: Grant['source'] = 'token' in source ? 'token' : 'gh-cli'
    const session = new GitHubSession(this.config, token)
    let login: string
    try { login = await session.login(signal) } catch (error) { await session.close(); throw error }
    const payload: Grant = { token, login, source: kind }
    await this.ctx.credentials.modifyRecord(RECORD, async () => ({ kind: 'grant', payload }))
    await this.replace(session, token)
    return { login, source: kind }
  }
  async disconnect(): Promise<void> {
    await this.ctx.credentials.deleteRecord(RECORD)
    await this.replace(undefined, undefined)
  }
  async tools(signal: AbortSignal): Promise<readonly GitHubTool[]> { return (await this.current()).tools(signal) }
  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly text: string; readonly isError: boolean }> { return (await this.current()).call(name, args, signal) }
  /** The session for the stored token; a token stored or removed elsewhere is noticed here. */
  private async current(): Promise<GitHubSession> {
    const grant = await this.grant()
    if (!grant) { await this.replace(undefined, undefined); throw new PersonalChatError('github-not-connected', 'Connect a GitHub account on the Apps page first') }
    if (!this.session || this.sessionToken !== grant.token) await this.replace(new GitHubSession(this.config, grant.token), grant.token)
    return this.session!
  }
  private async replace(session: GitHubSession | undefined, token: string | undefined): Promise<void> {
    const old = this.session
    this.session = session
    this.sessionToken = token
    if (old && old !== session) await old.close()
  }
  private async grant(): Promise<Grant | undefined> {
    const record = await this.ctx.credentials.readRecord(RECORD)
    return record?.kind === 'grant' ? grantOf(record.payload) : undefined
  }
}
