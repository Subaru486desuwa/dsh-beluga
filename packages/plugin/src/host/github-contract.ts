/** What the optional GitHub extension provides; Personal Chat decides when the model sees a tool and when a call waits for the person. */
export type ActionRisk = 'read' | 'low' | 'high'
export interface GitHubTool {
  /** The server's own name, such as `list_pull_requests`. */
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments, as the server publishes it. */
  readonly parameters: Record<string, unknown>
  /** `read` changes nothing; `low` is easily undone, such as a comment or a new branch; `high` is anything else that changes GitHub. */
  readonly risk: ActionRisk
}
export interface GitHubAccount {
  readonly login: string
  readonly source: 'token' | 'gh-cli'
}
export interface GitHubConnector {
  /** The account whose token is stored, or undefined before one is; reads no network and never returns the token. */
  account(): Promise<GitHubAccount | undefined>
  /** Check a token with GitHub, then store it: a pasted one, or the GitHub CLI's sign-in on this computer. */
  connect(source: { readonly token: string } | { readonly cli: true }, signal: AbortSignal): Promise<GitHubAccount>
  disconnect(): Promise<void>
  /** The tools the stored token can use, without the ones Personal Chat never offers. */
  tools(signal: AbortSignal): Promise<readonly GitHubTool[]>
  /** @returns the server's answer as text; `isError` when GitHub refused or failed the call. */
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly text: string; readonly isError: boolean }>
}
declare module '@deepseek-ai/cordis' { interface Context { personalChatGitHub: GitHubConnector } }
