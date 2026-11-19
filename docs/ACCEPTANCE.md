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

## ChatGPT-style chat pane (2026-11-07)

Checked with 257 automated tests, then with the packed `dsh-beluga` tarball in an isolated Harness 0.2.1-rc.3 profile on Linux, in headless Chromium at 1280×800 and 400×780, with the local fixture model. The fixture now offers two reasoning efforts, streams reasoning for `THINK` messages and walks a three-step to-do list for `PLAN` messages. The daily installation was not touched.

- A new chat opens on a centred greeting and composer, and is saved only by its first message.
- Choosing the low effort sent `low` to the model; the chip and the reply both showed it.
- While reasoning streamed the row read 正在思考; afterwards it read 已思考 and expanded to the reasoning text.
- The to-do list stayed open while the turn ran, with the current step in progress, and folded to 已完成 3 个步骤 when the reply finished. No tool result was shown.
- Editing a message in place made a new version, switched under the message as 2/2. Regenerating a reply put its 2/2 under the reply.
- A pasted image popped into the tray. On this text-only route the composer said it can't read images and kept Send disabled. A dragged file showed the full-pane drop overlay, and dropping it added a second card.
- After scrolling up, the scroll-to-bottom button was in view and took the hit test, and it returned to the bottom.
- The latest reply's actions were visible and hit-testable without hovering; a user message's actions appeared on hover.
- At 400 px the list and chat took turns, nothing overflowed sideways, and the back, send and copy controls took the hit test.
- In the dark theme the page, composer, bubble and send button followed the Harness tokens.
- No page errors.

Not checked: measured values from ChatGPT itself (the reference browser was not connected), a real model, an image route (none is configured in the isolated profile), the reduced-motion setting, touch devices, and real Chrome on macOS or Windows.


## Memory Summary (2026-11-08)

Checked with 276 automated tests, then with the packed `dsh-beluga` tarball in an isolated Harness 0.2.1-rc.3 profile on Linux, in headless Chromium at 1280×800 (light and dark) and 400×780, with the local fixture model.

- The memory page opens on an empty summary card. After two normal chats, Refresh wrote a summary with an overview, `##` sections and three Dive deeper prompts, and showed when it was last updated.
- A question typed in "询问或更新" showed the model's answer under the summary and left the summary as it was. A correction rewrote it; Restore previous version brought the earlier text back.
- Clear asked for confirmation, then left the card empty; Restore previous version brought the text back again.
- The model chip listed "跟随上次聊天" and each route; choosing a route renamed the chip. Record sensitive topics toggled in the ⋯ menu; screen readers hear its state in the row name, because the menu marks selection only with a check mark.
- A Dive deeper prompt opened a new normal chat and sent the prompt as its first message.
- Summary text and chat replies render at 16/28 px, plus the Harness content-size offset. Before this change, chat replies rendered at 14/24 px, because the Markdown primitive takes its font from its own tokens.
- The ask box's text and send button share a centre line. The ⋯ button, model chip, first Dive deeper prompt and ask box were in view and took the hit test at every size. At 400 px nothing overflowed sideways.
- No page errors.

Runtime tests cover what the browser cannot show:
- a Temporary Chat never reaches the summary;
- later normal chats receive it and Temporary Chat does not;
- a refresh with nothing new makes no model request;
- an automatic update waits until chats have been quiet for 30 minutes and starts at most every 6 hours;
- referring to earlier chats turned off stops both updates and use;
- with no chosen model and no last chat to follow, an automatic update waits instead of recording a failure;
- the summary survives a restart.

Installed on the daily service the same day, after 277 automated tests. Its chats came from builds that did not remember the last route, so the first automatic update would have failed for want of a model and then waited six hours; it now waits for a chosen model or a new chat instead. A read-only check there, with fixed labels and no screenshots, found the empty card with no failure notice, "跟随上次聊天" and six routes in the model menu, Restore previous version and Clear disabled in the ⋯ menu, every control in view and hit-tested, the 16 px reply rule loaded, nothing overflowing sideways at 400 px, and no page errors.

DeepSeek-V4.1-Flash was then chosen on that page, at the person's request. The next 5-minute check started the first update, which finished in 9 seconds without an error. Checked without reading the text:
- it is 1.5 KB: an overview, then three `##` sections, with three Dive deeper prompts;
- it is in the language of the person's messages;
- it renders at 16/28 px;
- Restore previous version stays disabled on a first version, and Clear is enabled.

The person then read it and found it wrong. Phrase counts on the stored chat, taken without printing any of it, showed what went wrong:
- It came from one chat: three short messages from the person and a piece of writing the assistant drafted for them. The key phrases of one whole section occur only in the assistant's replies, and two stated preferences occur in neither. The summary recorded the assistant's draft as the person's views, although the instructions said to leave out what the assistant said unconfirmed.
- The ChatGPT memory summary the person had shared for their own use was never loaded. The record held no earlier version, so nothing was overwritten, but the daily profile started without it. Every update also returns the whole summary, so a loaded one could drift each time.

The record also kept a zero reading position for each of the 339 imported chats with no Beluga turns. The source now keeps only positions above zero and drops old zeros. The daily installation picks this up with its next update.

Not checked:
- a real model rewriting the summary from a question or a correction;
- a long real history spread over several requests;
- the Harness content-size setting at values other than its default;
- touch input;
- the reduced-motion setting.

## GitHub app and automatic web search (2026-11-08)

Checked with 303 automated tests, then with the packed `dsh-beluga`, `dsh-beluga-office` and `dsh-beluga-github` tarballs in an isolated Harness 0.2.1-rc.3 profile on Linux, in headless Chromium at 1280×800 (light and dark) and 400×780. A local MCP server stood in for GitHub with a fixture token. The fixture model now takes a `GITHUB <tool> <arguments>` message, which loads that tool and calls it. Before each click, the control was measured in view and hit-tested, then clicked at its centre without scrolling.

- The Apps page offered the GitHub CLI sign-in and a password field for a token, with Connect disabled while the field was empty. Pasting the fixture token connected as @octo-fixture. The field went away, and the token was not in the page.
- The + menu listed GitHub. Picking it showed a chip, and the chip turned it off.
- A read ran without asking, and its result reached the reply.
- A comment waited on a card naming the action, the target `o/r#7`, its risk and the JSON to be sent. Nothing reached the server until Allow; then it ran once.
- A declined merge and a deletion stopped with Stop never reached the server.
- With low-risk actions allowed, a comment ran at once and a deletion still waited.
- At 400 px the card's buttons and details were in view and took the hit test. Neither the chat nor the Apps page overflowed sideways.
- Disconnect brought back the sign-in choices. The + menu then offered 连接 GitHub…, which led to the Apps page.
- No page errors.

One fault was found and fixed. In the dark theme the high-risk badge was red text on red, because Harness's two dark error tokens share one value. The badge now keeps the label colour on a tint of the state colour, at a contrast of 13:1 in both themes.

Not checked: GitHub's real server and a real account, the GitHub CLI sign-in in a browser (tests cover it with a stand-in `gh`), a real model choosing GitHub tools, a real web provider, and real Chrome on macOS or Windows.

Installed on the daily service the same day with `dsh-beluga-office`, after a backup taken with the service stopped. The GitHub extension was not installed there. A read-only check there, with fixed labels and no screenshots, found:
- The Apps page showed web search available and on, and the GitHub extension not installed.
- In a Temporary Chat, a synthetic Word file showed no Office notice before sending, and a real model returned the codeword only that file held. Before, a Word file pasted there came back `unsupported`, because the daily profile had no Office extension.
- Asked to search, the real model ran web search and web fetch without Web search picked from the + menu, and the reply listed its source. Before this change the model had no web tools unless the person turned them on.
- No page errors.

At the person's request, `dsh-beluga-github` was then installed there too, after another backup taken with the service stopped. The Apps page offered the GitHub CLI sign-in and the token field, both in view and hit-tested, and the + menu offered 连接 GitHub…, with no page errors. GitHub's MCP endpoint answered from this machine both directly and through the service's HTTP proxy. Connecting a real account is left to the person.

## Tool budget (2026-11-08)

A real reply on the daily service ended with 回复未完成：tool-limit and no answer. Counts taken from its stored turn, without reading any text, showed 8 model steps of distinct, successful calls: reading an attachment, searching repositories, reading files and searching earlier chats. There were no repeated calls and no tool errors. The reply had simply reached `maxToolSteps`, which then ended it without asking the model to answer. The turn had also grown to about 110 KB of the 128 KiB context budget, so a few more GitHub results would have ended it with `context-limit` instead.

- After its last allowed step, a reply now gets one more request and answers from what it gathered. A tool call made anyway runs nothing and is not kept.
- A reply that outgrows the context budget has its oldest tool results cleared from the request; the latest step's results and the stored history stay whole.
- `maxToolSteps` now defaults to 16.

Checked with 308 automated tests. All five new tests failed before the change, on `tool-limit`, `context-limit` and the missing final request. Then, in the isolated profile with the packed tarball, a fixture reply that kept calling tools answered after 16 steps in 7 seconds, with no failure notice and no page errors. Installed on the daily service after a backup taken with the service stopped. Not checked: the original request again with the real model and GitHub.


## Long chats condense (2026-11-08)

Replies on the daily service carried notes such as "44 earlier messages were omitted from this request". Byte counts taken from that chat's stored branch, without reading any text, showed 66 messages over 7 turns: tool results took about 223 KiB, reasoning about 62 KiB and the words of both sides about 35 KiB, against a 128 KiB budget. The model therefore saw only the newest turns, and nothing told it so.

- `maxContextBytes` now defaults to 512 KiB, held to two bytes per token of what a route's disclosed context window leaves after the reply. That chat now fits whole.
- A request over the budget first clears earlier turns' tool results, a whole turn at a time, in quarter-budget steps, then the current reply's older results. Reasoning stays in every turn a request carries, because DeepSeek's thinking mode answers 400 without it when tools are declared.
- When earlier turns would still leave, the model condenses the oldest turns into Condensed History, after a reply in the background, or before a request that would otherwise lose them. If condensing fails, the reply still runs without those turns.
- The notice and the stored count behind it are gone; the person still sees the whole chat.

Checked with 325 automated tests and the type check; the new context-window and condensing unit tests failed before the change. Then, in an isolated profile with the packed tarball and a 16 KiB budget, a fixture chat of six long turns condensed in two background passes; the next request carried the three newest turns as written plus the condensed text for the first four, the first turn stayed shown and reachable, and there was no notice, failure or page error. Installed on the daily service after a backup taken with the service stopped; the three newest chats opened with no notice and no page errors. Not checked: condensing with a real model, and how well its text keeps what later replies need.

## Excel charts (2026-11-08)

`create_workbook` and `edit_workbook` take `charts`: column, bar, line and pie charts whose series read cells of their sheet, so Excel and LibreOffice redraw them from the data. Uploaded workbooks can get charts too. Charts are added after recalculation, so the values they save are the calculated ones. New sheets print one page wide, across the page when they are wider than six columns or have charts.

- Each chart goes to the right of its sheet's data, one column clear, below any picture or chart already there. `check.charts` says where, and which value cells are not numbers.
- Column and bar charts start at 0 when every value is known and none is negative; category labels sit at the low end, clear of bars below zero. Values and axes carry their cells' number format, so `#,##0` shows thousands separators in Excel and in the LibreOffice preview and PDF.
- The file preview dialog is now up to 920 px wide. Its width had been set on the content inside the 380 px card, which clipped wide sheet images and pushed the close button out of view.

Checked with 338 automated tests and the type check; the number-format test failed before its change. `scripts/ooxml-schema-check.py` found every hand-written chart, drawing and sheet part valid against the ECMA-376 transitional schemas, and rejected a deliberately broken copy. LibreOffice kept the charts through a round trip, and openpyxl read their types, anchors and references. Then, in an isolated profile with the packed tarballs, a fixture reply created a two-chart workbook in 7 seconds; preview, download and PDF export worked with no page errors, the axes showed thousands separators, and at 1280 and 390 px wide the preview showed the whole image with the close button reachable. Installed on the daily service after a backup taken with the service stopped; the three newest chats opened with no notice and no page errors. Not checked: opening the files in real Excel or Numbers, a real model choosing charts, and charts below the preview's first 60 rows.

## PowerPoint P0 (2026-11-08)

`create_presentation` makes a 16:9 PPTX from slides in eight fixed layouts: title, section, bullets, two columns, chart, table, key figures and image. The model gives content only. The engine places it on a built-in theme (primary `#1F4E79`, Calibri, with Microsoft YaHei for East Asian text) and sizes each region by estimate, from 32 pt titles and 22 pt body text down to 24 and 16 pt. Text that still does not fit is reported in `check.issues` by slide and region, and the file is delivered anyway. Charts are native, with their data in an embedded workbook; column and bar charts start at 0 when no value is negative. Columns of figures in tables are right-aligned. Images are PNG or JPEG files attached on the branch, passed to the engine as bytes; links and paths fail validation. Speaker notes are kept.

- The model now sees an image's id, `[Image: name, attachmentId=…]`, as it already saw a document's, so it can put that image on a slide. Sending an image still needs the inline image route.
- Reading a PPTX with PowerPoint sections failed with `Missing or external Office relationship`: the section list repeats every slide in an extension, without a relationship, and the reader took every `sldId` it found. It now reads only the presentation's own slide list. Found on the daily service with an uploaded 15-slide deck, which now reads as 15 slides with their notes; a synthetic deck with sections is the regression test.
- pptxgenjs 4.0.1, pinned, writes the deck. Afterwards every typeface points at the theme, the notes master gets its own theme, and `[Content_Types].xml` declares only parts that exist; pptxgenjs had declared a slide master per slide. Its `presentation.xml` element order is kept although the schema rejects it, because PowerPoint for Mac was reported not to open the schema's order (pptxgenjs issues 1443 and 1449).

Checked with 360 automated tests and the type check. Breaking the theme fonts, title alignment, zero baseline, figure alignment, content types, notes master theme or image id each failed a test. The engine opened the synthetic 8-slide budget deck as 8 pages with Chinese text and no missing font, and exported a PDF; 230,000, 235,000, 5,000 and 2.17% match the Word and Excel files. A runtime test sent a picture through a local inline route: the model read its id, and the deck embedded the picture's bytes. Temporary Chat wrote nothing to disk or the engine and still reported overflow. Then, in an isolated profile with the packed tarballs, a fixture reply created a 7-slide deck in 7 seconds, every layout but image, which needs an inline route. The running label read 正在制作演示文稿; preview, download and PDF export (7 pages) worked with no page errors, and at 1280 and 390 px wide the preview fit with the close button reachable. Installed on the daily service after a backup taken with the service stopped; the three newest chats opened with no notice and no page errors. Not checked: opening the files in real PowerPoint or Keynote, which the pptxgenjs reports make the main risk, and a real model choosing layouts and writing slides.

## Work crossings (2026-11-09)

Checked with 424 automated tests and the type check, then installed on the daily service after a backup taken with the service stopped. Settings → Apps showed the Work card with both switches off and available, so the host provides the tool, agent, session-query and workspace services. Turning Work Records on listed 12 workspaces, the most recently changed first, where Harness's own registry order starts elsewhere; ticking one cleared the note asking for a workspace. In a Temporary Chat with that workspace allowed, a real model called `search_work`, answered that it found 3 sessions, and the reply listed the three as Work sources; clicking one opened that session in Work. The settings were then returned to their defaults, and the stored values confirmed it.

- Hand-off to Work opened Work on the previously selected session, without the brief. Beluga selected a panel right after `uiWorkspace.startSession`, and `layout.selectPanel` aborts the navigation that `startSession` starts before it opens the blank session. Harness reveals Work itself once the session opens, so Beluga no longer selects a panel after `startSession` or `openSession`. After redeploying, the dialog listed the 12 workspaces most recently changed first and kept its button disabled until one was picked. A real model wrote a 259-character brief in 7 seconds from a Temporary Chat, and it appeared unsent in a new Work session in that workspace; the test brief was then cleared, and the draft stayed empty after a reload. A Work source still opened its session in Work, and the Work settings were returned to their defaults.

- Memory Lookup, with the person's agreement to leave one archived Work session: with the switch on, the main agent of a new Work session called `personal_memory_lookup` once with a query that matched nothing. The logged result had only `memories`, empty, and `summary`, and no error. After the switch was turned off, the same session's next call got `unknown tool "personal_memory_lookup"` from Harness. The session was then archived, and the switch left off.

Not checked: the subagent and PTC refusals on the daily service, which the automated tests cover; the `memory_propose` refusal and the summary skip with a real model.

## Multi-file replies (2026-11-17)

A real reply on the daily service, given four attachments and a one-sentence request, ended after its opening sentence with "The reply hit the output limit and is incomplete". Lengths taken from its stored turn, without reading any text, showed two attempts alike: four reads over two steps, then a third step of about 20,000 characters of thinking with no text and no tool call, ended by the 8,192-token `maxOutputTokens`. Replayed in an isolated profile on the same route and effort, three runs per build, the installed build failed 3 of 3 the same way. Removing one limit exposed the next: without the token limit the same step thought for 35,000 to 71,000 characters and was cut by the 512 KiB stream limit, which counted the JSON of every chunk; with that corrected, 4 of 6 replies ran out of `maxToolSteps` at 16 while correcting their files, and all 4 answered the request that told them to stop with another tool call. Two later replies ended on a `TRANSPORT` failure of the provider.

- A reply step no longer sends `maxOutputTokens`; the route's own output limit applies. `maxOutputTokens` still bounds background answers and the room a request leaves for the reply.
- The stream limit counts the text, thinking and tool arguments one request streams, 2 MiB in all, instead of the JSON of its chunks.
- `maxToolSteps` now defaults to 48. The notice that the budget is spent is the last message of that request instead of the end of the system prompt.
- A step that fails in a way its provider's retry policy retries is asked again, and nothing of the failed step is kept.
- The system prompt asks for multi-step work in order: read every source, settle the work items, produce them one at a time, check each result once and correct it in one pass. It asks for a sentence in the same response as the first tool call and at each change of phase, and for thinking kept to decisions and outlines. The to-do tool asks for the list after reading and before the first result, ending with a checking item, updated as items finish and closed before the final answer.

Checked with 441 automated tests and the type check; the four new tests cover the missing output limit, the stream limit, the retry and the instructions, and the two tool-budget tests now read the notice from the last message. Then with the packed tarball in isolated profiles on the real route, `deepseek-flash` at high effort, three runs per case:

| Case | Installed build | This build |
|---|---|---|
| The four-attachment request | 0 of 3 finished, all `max-tokens` after 3 steps | 3 of 3 finished: opening sentence, list written before the first file, list closed, final answer; 15, 18 and 45 steps in 5.5, 7.5 and 15.4 minutes |
| A synthetic task of four files and two forms | 3 of 3 finished, 1 with a list | 3 of 3 finished, 3 with a list written before the first file, 2 closed |
| A question about one attachment | 3 of 3 answered, no list | 3 of 3 answered, no list |
| A plain question | 3 of 3 answered, no list | 3 of 3 answered, no list |

Held to 6 tool steps, the 2 replies that reached the budget both ended with a written account of what was finished and what was left. Installed on the daily service after a backup taken with the service stopped.

Not checked: the reply in the browser; the retry against a real provider failure, which only the fixture exercised. Known limits: a reply still spends most of its steps correcting its files, because an edit refused after an earlier edit moved the paragraphs costs a step and a reread; the list is seldom updated between its first and last version; and one run ended on `MALFORMED_RESPONSE`, which the default retry policy does not retry.

## One version per reply, looks, and worksheet structure (2026-11-17)

A reply on the daily service that filled two forms left 14 file cards, one per `edit_document` call. This round makes a Version the state of an Artifact at the end of a Turn, lets a read tell the look of text, cells and tables, and extends what a change can do to Word and Excel files.

- Changes during one reply overwrite the version that reply made; the chat shows one card per Artifact per reply, marked in progress while the reply runs. Chats stored earlier show the last version each reply made, and their stored files are untouched.
- Within one reply, an id of the file as it was means the changed file, for reads and for changes.
- `edit_document` takes all changes to a file in one call, finds a moved paragraph by its expected text or the first 20 characters of it, returns each changed paragraph with its location and character count, sets font, size, weight, italic, underline, colour, highlight and alignment, and adds or deletes table rows.
- `read_attachment` gives each Word paragraph's differences from the default look and one line per table: rows and columns, column widths, borders, merged and shaded cells.
- `read_sheet` gives the ranges that share a look, column widths, row heights and merged ranges. `edit_workbook` sets looks, column widths, row heights and merges, adds rows below the data, adds sheets, and inserts or deletes rows and columns.

Checked with 508 automated tests and the type check. Then with the packed tarballs in isolated profiles on the real route, `deepseek-flash` at high effort, three runs per case, on synthetic files:

| Case | Installed build | This build |
|---|---|---|
| Fill two Word forms from two source files | 3 of 3 finished; 7.0 files stored, 18.3 steps and 3.3 refused calls on average | 3 of 3 finished; 2.0 files stored, one per form; 20.3 steps and 4.7 refused calls on average |
| Insert a row into a workbook with totals, format it and add a summary sheet | not possible | 3 of 3 finished in 36 to 47 seconds; 1 file stored, 6.3 steps, no refused call; read back, each had the row in place, both totals right, the looks asked for and the summary sheet |

The first evaluation of this build found that the model named the upload's id again for each further change, so every change started over from the upload: one workbook run stored three files and lost its earlier changes, and one form run took 49 steps with 12 refused calls. The id rule above was added for this, and the table reports the build with it. Installed on the daily service, plugin and Office extension together because the engine interface changed, after a backup taken with the service stopped; the service came back active and the stored data version was unchanged.

Not checked: the cards in the browser; the look of the changed files in Word and Excel themselves. Known limits: form replies still vary from 7 to 37 steps, and the refused calls that remain are changes whose expected text the model's own earlier change replaced; a deletion is not compared by calculation, only its `#REF!` formulas are reported; rows and columns cannot be inserted or deleted on a sheet with a pivot table, notes, embedded objects, sparklines, a data table, or a formula that ranges across several sheets; a range that ends just before an insertion does not grow; Word table styles and Excel conditional formats, table styles and whole-row or whole-column styles do not appear in a read; cell borders are set as all sides or none; PowerPoint files are unchanged.

### Whole-cell writes (2026-11-17)

The form replies above still took 7 to 37 steps. Their traces showed one `edit_document` call per paragraph, a recount after each, and refused calls whose expected text the reply's own earlier change had replaced; a form cell often holds several paragraphs, and a form's length limit is on the cell. `edit_document` now has `set_cell`: it gives a table cell its whole text, one paragraph per line, needs no expected text, and returns the cell's text, character count and paragraph count.

Checked with 513 automated tests and the type check, then on the same synthetic task and route, five runs: 5 of 5 finished, 2.0 files stored, 8.0 steps (5 to 10), 0.2 refused calls and 122 seconds on average, against 20.3 steps, 4.7 refused calls and 279 seconds for the build before it. All ten filled forms, read back, kept the three length limits the task sets. Installed on the daily service, plugin and Office extension together, after a backup taken with the service stopped; the service came back active with no activation failure in its log, and the stored data version and chat count were unchanged.

Not checked: forms whose cells hold nested tables, which `set_cell` refuses; a form filled outside tables, where paragraphs are still changed one by one.


### Office 97–2003 files (2026-11-17)

A reply on the daily service said it could not read an attached `.xls` and asked for an XLSX: `read_attachment` treated anything but DOCX, XLSX and PPTX as text and returned "not valid UTF-8 text". DOC, XLS and PPT files are now converted by LibreOffice to DOCX, XLSX and PPTX before they are read, previewed, exported to PDF or changed. A change gives a new version in the current format, and the upload stays as it was. Temporary Chat keeps files away from the engine, so there `read_attachment` reports that the file must be saved in the current format or read in a regular chat.

Checked with two runtime tests on an XLS written by SheetJS and a DOC saved by LibreOffice Writer, both red before the change, and the full suite: 514 of 515 passed, and the one failure, a storage test that timed out at 20 seconds under the full run, passed on its own. Then, with the packed tarballs in an isolated profile on the real route, `deepseek-flash` at high effort, one run: the model read A1, B1 and the formula `A1*2` from the XLS, changed A1 to 300 into version 2 `汇总表.xlsx`, and read back 600 in B1, in 4 steps and 23 seconds with no refused call. Installed on the daily service, plugin and Office extension together because the engine interface changed, after a backup taken with the service stopped; the service came back active with no activation failure in its log, and the stored data version (5) and chat count (348) were unchanged.

Not checked: a PPT file; a legacy file the user saved in a real Excel or Word; the preview and PDF buttons in the browser.

## DeepSeek Flash reads images (2026-11-18)

On the daily service, a chat with an image and DeepSeek-V4.1-Flash selected said "This model can't read images". Beluga sends images only through its inline route, which took one endpoint and one credential reference, and on the daily profile that reference's channel does not serve `deepseek-flash`. A direct request to the same OpenAI-compatible endpoint answered "Red" for a red test image with the DeepSeek credential and returned `model_not_found` with the inline route's credential. An entry in `inlineProvider.models` may now name its own `baseURL` or `credentialRef`; plain model names keep the route's.

Checked with two model-bridge tests, red before the change, and the full suite: 521 of 521 passed, with the type check. Then with the packed tarballs in an isolated profile, the inline route configured as on the daily service plus `deepseek-flash` under `DEEPSEEK_API_KEY`, two runs: Personal Chat listed `deepseek-flash` as an inline route, and for an uploaded red PNG asking for its colour it answered "Red" in one step. Installed on the daily service, plugin and Office extension together, after a backup taken with the service stopped, with the `deepseek-flash` entry added to the profile patch; the service came back active with no activation failure in its log, and the stored data version (5) and chat count (350) were unchanged.

Not checked: the picker and a reply in the browser. Known limits: every DeepSeek Flash chat, with or without images, now goes through the inline route, which has no Harness retry policy; on this endpoint `reasoning_effort: none` still returns reasoning, so Off may not turn thinking off.

## Chat first, and New chat as the primary action (2026-11-18)

Harness opened on Work, listed Chat below Work, and kept New Session at the top of the sidebar while Chat added its own New chat under every panel row. Chat is now listed above Work and opens at launch (`startMode`, default `chat`). The sidebar serves a Mode: Chat's page enters Chat, the Conversation and the Work row enter Work, and Plugins and other pages keep the Mode. On a Harness that provides the sidebar primary action, New chat is that action in Chat mode, and New Session returns in Work mode. The plugin, Office extension and GitHub extension now declare `engines.dsh` as `>=0.2.1-rc.3 <0.3.0` instead of exactly 0.2.1-rc.3, which a later Harness refused to load.

Checked with 530 automated tests, the type check and the build; the first full run under a concurrent Harness build had two errors, and the rerun passed 530 of 530. Then with the packed `dsh-beluga` and `dsh-beluga-office` tarballs in two isolated homes on Linux, in headless Chromium at 1280×800:

- On a 0.2.2-alpha.2 Harness built from a working tree that adds `ctx.sidebarPrimaryAction`, Harness opened on Chat with New chat as the top button and no second New chat in Chat's list. Plugins kept New chat and Chat's list, and New chat from Plugins returned to Chat's page with a normal chat. The Work row brought back New Session and the workspace browser, Plugins kept them, and the Chat row returned New chat. With a Windows browser's platform, Ctrl+Alt+N turned a Temporary chat into a normal chat, and from Plugins in Chat mode it returned to a normal chat.
- On the globally installed 0.2.1-rc.3, New Session stayed at the top in both Modes, and New chat and Temporary chat stayed at the head of Chat's list; the order, the start mode and the Mode followed the same steps.

Installed on the daily 0.2.1-rc.3 service, plugin and Office extension together, after a backup taken with the service stopped; the service came back active with no activation failure in its log, and the stored data version (5) and chat count (350) were unchanged. A read-only browser pass showed Chat above Work and selected at launch, Chat's list on Plugins, and New Session with the workspace browser on Work.

Not checked: the macOS title-bar button and the desktop Ctrl/Cmd+N binding; Linux browsers, where Harness binds no New shortcut; New chat while a reply is running, outside the automated tests. The daily GitHub extension is the earlier tarball, which still declares exactly 0.2.1-rc.3, and the daily Harness does not have the primary action yet.

### New Session starts a chat on 0.2.1-rc.3, and Temporary chat moves to the header (2026-11-18)

On the daily 0.2.1-rc.3 service, New Session at the top still started a Work session while Chat's page was open, and Chat's list repeated New chat and Temporary chat under the panel rows. Harness 0.2.1-rc.3 has no sidebar primary action, but its New Session button, brand, title-bar control and shortcut all call `uiWorkspace.startSession` without a target. While Chat's page is open, Beluga now answers that call with a new chat; on other pages, including Automation tasks' New task, the call reaches Work unchanged. Chat's list lists New chat only when neither that answer nor the primary action is available. Temporary chat is now a switch at the top right of an empty new chat, which keeps the composer's text, and it is no longer in the list.

Checked with 536 automated tests, the type check and the build. Then with the packed `dsh-beluga` and `dsh-beluga-office` tarballs in two isolated homes on Linux, in headless Chromium at 1280×800 in dark mode with a macOS browser's platform:

- On 0.2.1-rc.3, the top button kept its New Session label. On Chat's page, the button and Cmd+Alt+N each turned a Temporary chat into a normal chat. On Automation tasks, the same button opened Work's new-session composer. The switch turned Temporary chat on and off with "draft kept" still in the composer, and Chat's list held neither New chat nor Temporary chat.
- On the 0.2.2-alpha.2 build with the primary action, the top button read New chat, and the same steps gave the same results, except that New chat from Automation tasks started a chat, as its label says. The Work row brought back New Session.

Installed on the daily service, plugin, Office extension and GitHub extension together, after a backup taken with the service stopped. The GitHub extension now declares the same `>=0.2.1-rc.3 <0.3.0` range. The service came back active with no activation failure in its log, and the stored data version (5) and chat count (350) were unchanged. A browser pass on it turned the switch on and pressed New Session on Chat's page, which gave an empty normal chat without opening Work; nothing was sent or saved.

Not checked: the macOS title-bar control on the desktop app; whether other plugins call `startSession` with no target while Chat's page is open, which would now start a chat.
