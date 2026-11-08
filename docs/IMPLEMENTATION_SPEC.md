# Personal Chat: base plugin and opt-in Office extension

## Agreed outcome

Ship a base community DeepSeek Harness plugin for Chat and Memory, installed into the existing Web/Desktop shell. Office processing is a separate opt-in extension installed only after explicit user consent. It adds Chat beside unchanged Work. It must not require a modified Harness, an upstream patch, a private fork, a native Work Session, or an embedded third-party website.

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
