# Beluga GitHub (opt-in)

Requires an existing Beluga installation. Never installed with the base Chat/Memory package.

Install the locally built tarball in the same profile:

```sh
dsh plugin --profile web add ./dsh-beluga-github-0.1.0.tgz
```

Restart the profile, open **Apps** in Chat, and connect an account. There are two ways:

- **GitHub CLI sign-in:** reads the token of `gh auth login` on this computer once, when you ask.
- **A pasted token:** a fine-grained token with read and write access to the repositories you need.

Beluga checks the token with GitHub before it keeps it, then keeps it in the Harness credential store only. It never shows the token again, and Beluga's own database holds none. **Disconnect** removes it.

The tools come from GitHub's official MCP server, `https://api.githubcopilot.com/mcp/`, with its default toolsets and Actions: repositories, files, issues, pull requests, reviews and workflow runs. Tools that create, fork or delete whole repositories are left out.

The model sees the tool names first and loads the ones a task needs. The person decides on the Apps page whether the model may use GitHub unasked, and which changes wait for them:

- **Always ask me** (default): every change waits for Allow or Decline.
- **Allow low-risk actions:** comments, issues, branches and pull requests run at once. Merges, file pushes, deletions, workflow runs and any change Beluga does not know still ask.
- **Allow all actions:** nothing asks.

Reads never ask. A waiting change shows what will be sent; Stop ends the wait without running it.

The profile patch can set `url`, `toolsets` and `timeoutMs`. The server must use HTTPS; plain HTTP is accepted only for this computer, as a test server is. Organization token policies still apply.

Disconnect first to delete the stored token, then remove with `dsh plugin --profile web remove dsh-beluga-github`; chats stay. Removing the package alone leaves the token in the credential store. This candidate is not publicly published.
