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
