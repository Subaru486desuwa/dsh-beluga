# First-release candidate acceptance

Validated on 2026-11-06. This is a local release candidate, not a public npm/market release.

> Snapshot of the first local candidate. Storage was rebuilt afterwards and checked with 100 automated tests and an isolated Host over HTTP. The browser flows below have not been repeated against that rebuild.

## Evidence

- Build and type compilation: Node 24.22.1, Linux x86_64 on the development host. Generated strict Remote descriptors, host ESM and browser lazy-CJS output compile successfully.
- 35 focused test cases across 11 files have passing evidence. The 31-test consolidated suite was followed by affected checks for cyclic ZIP/graph inputs, interrupted import recovery, IME composition, delayed HTTP receipts and actionable Remote errors. Unchanged host/bridge/asset checks were reused.
- Packed `dsh-beluga-0.1.0.tgz` installed through `dsh plugin` in a separate home/profile on the **unmodified globally installed 0.2.1-rc.3** release. Browser client and generated Remote codecs activated. Package updates unloaded/reloaded the plugin cleanly and returned the selected panel to Work.
- Actual macOS Chrome flows: open Chat without a workspace; stream Markdown/table/code/TeX replies; stop a long response; recover both ordinary and imported history after a full isolated Host restart; import a synthetic official-shaped JSON; select either source branch; continue in the same view; edit into a new branch and recover the old one; save a profile; propose and approve memory; return to Work.
- Strict temporary flow: memory/import controls disabled, no history row, Stop and End temporary chat exercised. Its sentinel was absent from all 11 inspected persistent files in the isolated home, including SQLite/WAL. DevTools showed only a durable conversation id in plugin localStorage, no sessionStorage entries and no IndexedDB database.
- Visual inspection at desktop size and a 400 CSS-pixel viewport. A long title that squeezed into a vertical column was corrected to an ellipsis with compact labeled controls. The narrow history/detail transition and composer remain accessible.
- Keyboard test renders the actual composer: IME composition and Shift+Enter do not submit; ordinary Enter submits once.
- Synthetic images are decoded/normalized with Sharp without temporary writes; an actual PDF fixture is extracted. A loopback HTTP server validates the OpenAI SDK inline-image request, credential-reference resolution and premature-stream failure.

Local execution logs are under `.artifacts/acceptance/checks/` (gitignored). Tests never use a personal export or a live model account.

## Corrections found during acceptance

- Registered installed SDK declarations for rc.3's build-time Typert analyzer; marked the two follow methods as streams.
- Kept the optional image-provider schema truly optional.
- Mounted the plugin's Remote contribution before injecting `remote.personalChat` into its UI scope.
- Prevented a late HTTP receipt from erasing already streamed text.
- Matched the Markdown image filter to the renderer's streaming/settled grammars.
- Kept user-approved instructions distinct from untrusted archive context.
- Reported pending memory as awaiting review, not saved; kept actionable Remote failure messages.

## Remaining release gates

- A real ChatGPT official export: intentionally deferred until the requested export arrives. Large/novel export shapes and media-format compatibility are not inferred from synthetic tests.
- A selected real text model and real inline-image provider: the current preview is a deterministic local model, not a model-quality evaluation. Web provider integration and native Desktop application packaging were not exercised.
- Independent code review: unavailable in this run because the assigned review/implementation agents hit their usage limit. The implementation has self-review and the checks above; it has not been independently approved or committed for release.
- A reviewed public Git repository, npm owner/name and target market index before publishing. Source and tarball are prepared; no push, npm publish or market submission occurred.

The existing daily Harness installation and its Work data were not changed. No core patch is part of this candidate.

## Word and Excel candidate (2026-11-07)

Checked with 202 automated tests, then with the packed `dsh-beluga` and `dsh-beluga-office` tarballs in an isolated Harness 0.2.1-rc.3 profile on Linux. The daily installation was not touched.

- The isolated database upgraded from version 3 to 4 and kept its chats.
- `dsh plugin add` succeeded with both tarballs, and the engine came from Harness.
- Over the real Host transport: read a range, edited an uploaded workbook, created a workbook, previewed sheets, exported a PDF, edited an uploaded document with tracked changes, filled a template and created a report with a table of contents and a chart.
- In headless Chrome: previewed a workbook, switched worksheets, downloaded a PDF and previewed a document, with no page errors.
- python-docx and openpyxl read every delivered file. The edited workbook kept its chart, comment, conditional formatting, data validation, table, defined name, hidden sheet and merged cells.
- No engine temporary files remained.

Not checked: opening the files in real Word or Excel, a real model choosing these tools, and macOS or Windows.

## Real ChatGPT export (2026-11-07)

Checked with the packed `dsh-beluga` tarball in an isolated Harness 0.2.1-rc.3 profile on Linux, using the local fixture model in headless Chromium. The input was one real official export of 698 MiB holding 339 conversations; it is not in this repository. Before this work every conversation was refused, and earlier checks had only used synthetic JSON.

The export differed from the synthetic shape in three ways: conversations were split into `conversations-000.json` to `-003.json`, mapping nodes had no `children`, and 3,267 of 5,174 messages were reasoning nodes with no spoken text.

- The browser reduced the ZIP to 10.7 MiB in about a second, adding 106 MiB of memory. Streaming it through fflate's `Unzip` took 816 MiB, because skipped entries stay referenced until the end.
- A 14.2 MiB request crossed the real Remote transport.
- Preview listed all 339 as new, with 111 warnings for media messages.
- Commit, reading 25 chats, a full Host restart, continuing a chat, re-importing (339 skipped) and batch undo (the continued chat kept) all passed with no page errors.

The packed plugin was then installed into a daily `web` profile beside `@linxin666/dsh-ssh` and `@shiqyka/dsh-ssh-workspace`. After a service restart all their sidebar entries and the Chat import page loaded with no page errors, and only `dsh-beluga` was added to the profile's dependencies.

### Reachability and continuation

The first real attempt on the daily profile stopped at the preview: nothing was committed, so no chat appeared. Two faults were behind it, and the acceptance above missed both.

- The confirm button sat below all 339 rows, 43 screens down. Playwright's `click()` scrolls to its target, so the script reached a button a person would not find. Checks now measure the button's box and run `elementFromPoint` with no auto-scroll.
- Once a chat was continued, its history collapsed into a closed disclosure.

The confirm and discard buttons now come before the list and stay pinned while it scrolls, and a continued chat shows history and new messages in one scroll region. In headless Chromium at 1000×695 with 339 synthetic rows, the button stayed in view and took the hit test after scrolling 12,000 px. A continued chat opened on the newest message with its history above it.

40 of the export's 1,892 visible messages were voice messages whose text sits in `audio_transcription` parts, and they had imported blank. They now import as text, which also puts them in search and in the snapshot sent to the model. The 11 blank messages left are 3 image-only messages and 8 that are empty in the source.

The real export then passed the full flow again in the isolated profile, with the fixture model.

On the daily profile a one-conversation synthetic export was imported, and a real configured model was asked for a codeword that existed only in the imported history. It answered correctly on two turns, and the conversation and batch were then removed.

Not checked: importing this real export into the daily profile, a real model on a real imported chat, a real snapshot at the 24 KB budget, real Chrome on macOS or Windows, exports other than this one, and ZIP64 on a real file (covered by a built fixture only).
