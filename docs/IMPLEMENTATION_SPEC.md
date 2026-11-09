# Personal Chat: base plugin and opt-in Office extension

## Agreed outcome

Ship a base community DeepSeek Harness plugin for Chat and Memory, installed into the existing Web/Desktop shell. Office processing is a separate opt-in extension installed only after explicit user consent. It adds Chat beside Work as a peer top-level mode. It must not require a patched or forked Harness, a native Work Session, or an embedded third-party website; its Chat sidebar shadows the stock workspace browser only while Chat is open (ADR 0005). Work changes only where the person turns on a crossing from ADR 0006.

Deliver independently installable base and Office tarballs with their source; the base must not depend on or auto-install Office. Installation and compatibility claims require packed-artifact acceptance. Real official ChatGPT export validation follows when that separately requested input becomes available.

The base plugin contains Chat and Memory. Office capabilities are a separately downloaded extension, recommended but never preinstalled, automatically installed or enabled by a model request. Only explicit user installation enables Office tools. Removing the extension retains existing conversations, memory and artifact downloads; no default Harness profile is modified.

## First-release behavior

- Open Chat without selecting a repository. Reuse public DSH model routing/credentials, global slots, authenticated Remote transport and safe UI primitives.
- The plugin owns its message journal, model turns, attachments, catalog, branches and persistence. It never creates, forks, deletes or claims a native Work Session and does not patch or replace official module ids.
- Stream replies, Stop and recover from errors/reconnection. Edit a historical user message or regenerate an assistant reply into a new persistent branch; retain the old branch.
- Search titles/body, rename, archive/restore and actually delete the owned Chat plus its owned attachments. Deletion stops active writers and remains retryable after failures.
- Pin a Chat to the top of its list without counting as activity. Export a saved Chat as Markdown in the browser; tool output and reasoning stay out.
- List the web pages a reply consulted beneath it as links. Read a reply aloud with voices on the user's device only; never fall back to a network voice.
- Support owned text documents and extractable-text PDFs, images on explicitly supported model routes, and optional existing web search/fetch. Unsupported image/model or scanned PDF paths must fail clearly before pretending content was read. No arbitrary filesystem, shell, deployment, subagent or plugin-install tools.
- A reply may take up to `maxToolSteps` model steps with tool calls (16 by default). After the last one the model gets one more request and answers from what it gathered, instead of the reply ending without an answer; a tool call it makes anyway runs nothing and is not kept. When a long reply outgrows the context budget, its oldest tool results are cleared from the request, never the latest step's, and the stored history keeps them.
- A chat longer than its request budget condenses instead of losing turns (ADR 0004). A request first clears the tool results of earlier turns, then the current reply's older ones. When earlier turns would still have to leave, the model rewrites the oldest turns into Condensed History, normally in the background after a reply, and requests carry it in their place. Reasoning stays in every turn a request carries. Nothing about this is shown to the person, and the stored history is unchanged. `maxContextBytes` defaults to 512 KiB and is held to what a route's disclosed context window leaves after the reply.
- Web search and fetch are offered to the model whenever a Harness web provider exists. Once the person turns automatic use off, only a message that picks them gets them.
- A compact stable profile and custom instructions do not depend on keyword recall. Relevant memories keep source/scope/revision. Explicit remember and clear low-risk facts can save with feedback/undo; sensitive, inferred or conflicting candidates require confirmation. Corrections supersede old facts and forget suppresses automatic relearning.
- While replying, the model may search the user's earlier active plugin chats for bounded excerpts, behind a default-on profile switch. Temporary Chat never has this tool or reads the store for it. Imported originals stay out, and tool output is not indexed.
- Temporary Chat is immutable per new conversation: no local persistent history, drafts, attachments, snapshots or long-term memory read/write. Keep bytes and live state in memory; close disposes the lifecycle. No native Session is created just to obtain LLM access. Validate official no-sessionId text provider paths; image paths must use a verified in-memory resolver/adapter, not stock attachment storage or forced-error fallback.
- One-click official ChatGPT ZIP/JSON import: select, preview recognized conversations/warnings/limits, confirm once, commit and report. Preserve original JSON, roles, times, complete mapping graph/current_node, all branches and unknown fields/media references. Do not flatten branches by timestamp, silently truncate records, fetch embedded URLs or extract arbitrary ZIP paths.
- Accept one `conversations.json` or contiguous numbered `conversations-NNN.json` shards, and take edges from `parent` when a mapping declares no `children`. Read voice messages from their `audio_transcription` parts. The browser reads only those members by byte range and uploads a reduced ZIP, so media never leaves the device; the Host validates that ZIP in full. Reasoning nodes (`thoughts`, `reasoning_recap`) stay in the original but out of the branch view, Markdown export and model context, and the view states how many are hidden.
- Deduplicate repeated import; preserve revisions for changed source content. Batch undo removes only that batch's ownership, not previous imports or later plugin conversations.
- Imported original history remains read-only. In the same detail, continue from the selected branch into the plugin's own new conversation branch using a bounded explicitly untrusted snapshot. Preserve full archive for viewing, disclose model-context omissions, never elevate imported system/developer text into active authority.
- Import reviewed saved-memory text/JSON and personal instructions/Markdown with source file names. AGENTS input requires visible review and an explicit personal scope; it does not rewrite Work AGENTS or automatically promote engineering rules.
- Single self-hosted owner first. No multi-tenant billing, voice/realtime screen, image generation or scheduled tasks in this release.
- Source files, existing Work data and daily DSH are untouched. No personal export bodies or credentials in Git, fixtures, diagnostics or screenshots used for public contribution.
- Stored data carries a version. Additive upgrades run in one transaction on open; a version with no upgrade path is refused and left untouched.

## Next-phase behavior

Agreed on 2026-11-08; terms follow GLOSSARY.md. The compatibility target follows the Harness release line in daily use instead of 0.2.1-rc.3. Where a first-release bullet above differs, this section replaces it. Stages land in this order; Canvas, a file library, deep research, data analysis, image generation and scheduled tasks come later, and follow-up suggestions under replies are not planned.

1. **Memory Summary fixes.**
   - It records only what the person said or confirmed. Drafts, translations or role-play the person asked for, pasted material and hypotheticals are not the person's views. Assistant text only helps interpret short replies, and every new fact rests on a user message.
   - An automatic update returns only the sections it changes, each in full, plus the sections it removes; every other section keeps its exact text. A change the person made is revised only when the person later says otherwise.
   - The person can edit the summary text directly. It is saved as typed without a model, except that credential lines, long numbers and email addresses are removed as from any summary text, and it then takes part in later updates like any other text. Ask-or-update stays for questions and model-applied changes, which also return only the parts they change.
2. **Information architecture.**
   - Chat and Work are peer top-level modes, switched from the panel list, which gains a built-in Work row. In Chat mode one sidebar shows New chat as its primary action, then search, Projects and the chat list, with Settings at the bottom; Work mode stays stock. Beluga shadows the workspace browser while Chat is open (ADR 0005); the stock New Session button stays at the top and starts a Work session.
   - Pinned chats stay on top. Unpinned chats sort by last activity, grouped Today, Yesterday, Previous 7 days, Previous 30 days and by month, without a per-row date; or by Chat Activity State: running, waiting for the person, new reply, then the rest by time. The choice is remembered.
   - Each row shows its Chat Activity State: a shimmering title and spinner while running, a needs-confirmation mark while waiting, a dot for a reply that finished while the person was elsewhere until the chat is opened, and nothing when idle.
   - While the model thinks, the reply shows the elapsed seconds, advancing every second; afterwards it shows the duration the Host stored. Reasoning text streams smoothly. Durations that advance only in 3-second steps are a defect.
   - One Settings button opens a Beluga dialog: General; Personalization with Custom Instructions, memory switches, the Memory Summary and saved memories; Apps with web search and Work Records; Data controls with ChatGPT import and archived chats. The archived filter leaves the sidebar.
   - An automatically saved memory shows Undo, and a candidate shows Save and Dismiss, under the reply that proposed it; that chat then waits for the person in the list.
   - Sources under a reply list the Saved Memories recalled and the chats referenced beside web pages. The Memory Summary and Custom Instructions are not listed.
   - Archiving only hides a chat: it stays searchable, including by `search_chats`, and still feeds the Memory Summary. Deleting is how the person makes Beluga forget a chat.
   - Temporary Chat still neither reads nor writes personal memory.
3. **Work crossings (ADR 0006).** Memory Lookup reaches top-level Work sessions only and is off by default. Work Records reads only the workspaces the person allows, is off by default, and matches a time range and words against what the person and the agent said in the newest sessions, without full-text search; replies list the Work sessions they read. Nothing learns from Work: a reply that read Work proposes no memory, and the Memory Summary skips what the assistant said after the read. Hand-off to Work asks for a workspace, most recently changed first, and appends the brief to any existing draft without sending it.
4. **Projects.** A Project groups chats with its own files, instructions and a Memory Scope, Default or Project-only, changeable after creation. Under Project-only, outside Saved Memories and the Memory Summary stay out, `search_chats` reaches only the project, outside chats cannot reach it, and its chats never feed the Memory Summary; Custom Instructions still apply. A Project never binds a workspace directory.
5. **Personalization.** Custom Instructions gain a base style (Default, Professional, Friendly, Candid, Efficient) and four characteristics (warm, enthusiastic, headers and lists, emoji), each Default, More or Less. Temporary Chat does not use them.
6. **Automatic titles.** After the first reply, the chat's own route writes one short title in the person's language. A rename is final, titles are not rewritten later, and existing chats and imported history keep theirs.

## Implementation approach

Office files follow these rules:

- Official tools come first: the Harness LibreOffice Kit renders and recalculates, `docx` writes Word, and ExcelJS writes new workbooks only, because it loses parts of workbooks it reads.
- A change to an existing file rewrites only the XML parts it touches, and every other part keeps its exact content. Filling a template is the exception: `patchDocument` reserializes the XML parts without changing what they say.
- LibreOffice's output is read and never delivered. Calculated values are copied beside the formulas in the original file, and Excel is told to calculate on opening.
- Formulas written by a model cannot fetch from the network, reach another workbook or start a program. A workbook that already can, through a formula, a defined name or a link part, is not sent to the engine.
- A paragraph edit names the text it expects. If the file no longer reads that way, the edit is refused.
- An edit that would remove an image or field, or land inside another author's tracked change while tracking, is refused rather than approximated.
- Temporary Chat bytes never reach the engine, because it needs files on disk. Its tool results say that nothing was calculated or checked.

The base package contains its Host service, browser plugin, generated Remote descriptors and an installable bundle patch. The separate Office package owns XML parsing and document-rendering dependencies and registers its engine only when explicitly installed and enabled. Normal conversations use one plugin-owned durable data model; temporary conversations and attachments remain in memory. The plugin does not create native Work Sessions or modify stock provider instances.

The initial compatibility target is DSH 0.2.1-rc.3. Model/image route support is declared from verified public adapter behavior, not inferred from a model name.

## Acceptance

1. Packed single tarball installs/loads/unloads in a clean unmodified rc.3 profile, with declared dependencies and generated Host/Client codecs.
2. Normal Chat persists across plugin/Host restart; no new native Work Session files or Work navigation/list mutations.
3. Streaming/Stop/tool steps/errors/reconnect and edit/regenerate branches work through real plugin services with only model/network mocked.
4. Import graph fidelity, invalid/cyclic graphs, ZIP bounds, repeated/revised imports, interrupted commit/restart and undo ownership all pass.
5. Actual delete removes owned records/assets and cannot be resurrected by an in-flight turn.
6. Profile/recall exact input snapshots, corrections, review/undo/forget and temporary direct-call denial pass.
7. Owned PDF/text/image and cross-conversation attachment denial pass. Real image/provider support is reported per verified route.
8. Temporary sentinel appears nowhere in the isolated persistent data/history/index/cache/draft locations after send/Stop/error/close/restart; source contexts use no sessionId and no stock durable image pipeline.
9. Browser desktop/narrow view and keyboard/IME paths work; no imported remote image fetch, no private data in browser persistent stores.
10. The user's real export is a separately tracked later acceptance input, explicitly deferred by user. No synthetic fixture is represented as real data.
