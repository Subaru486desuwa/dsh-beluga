# GitHub comes from its MCP server, loaded by name, with changes held for the person

Beluga's GitHub app calls GitHub's hosted MCP server instead of its own REST client. The server already maps pull requests, issues, Actions and files to tools, keeps up with GitHub's API, and marks which tools only read. The extension adds what the server cannot know: which changes are easy to undo, and the person's approval.

The server's tool schemas come to about 55 KB, too much to send with every request. The model gets one tool that lists the GitHub tool names; it loads the ones a task needs and calls them as `github__<name>`. Loaded tools stay for the rest of the branch, recovered from its history. The deferred loading in Harness model routes was not used, because whether it works depends on the provider.

A change waits inside the running turn until the person allows or declines it. The wait lives only in memory, so Stop, deletion or a restart ends it without running anything. Low risk is an allow-list of changes that are easy to see and undo. Anything else, including a tool GitHub adds later, counts as high risk until the list names it. Tools that create, fork or delete repositories are never offered.

The token is kept in the Harness credential store under the extension's own key, never in Beluga's database or views. The cost is a dependency on GitHub's hosted server being reachable and accepting the token. GitHub Enterprise Server, or a token an organization blocks, needs another `url` or another token.
