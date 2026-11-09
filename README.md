# Beluga

Personal Chat for DeepSeek Harness, named after one of the most vocal whales.

[中文](README.zh.md)

One plugin adds personal Chat beside Harness Work: conversations, ChatGPT history import, a reviewed personal profile, and controlled memory. Work keeps its own sessions and tools; Chat needs no repository.

The base plugin provides Chat and Memory. Office is a recommended but separately downloaded extension, `dsh-beluga-office`, installed only after explicit user consent. The base package does not depend on Office or ship its processing libraries. Neither models nor uploads can install extensions.

## Build from source

No release tarball or npm package exists yet. Build one with Node 24.9+ and pnpm:

```sh
git clone https://github.com/Subaru486desuwa/dsh-beluga.git
cd dsh-beluga
pnpm install --frozen-lockfile
pnpm run build
pnpm run pack
```

The tarballs are written to `dist/`. Use those paths in the commands below.

## Install the built plugin

Target: **unmodified DeepSeek Harness 0.2.1-rc.3**, Node **24.9+**. This is a pre-release candidate; it has not been published to npm or a public market.

Install a built release tarball into your chosen **web** profile, then restart that profile:

```sh
dsh plugin --profile web add ./dsh-beluga-0.1.0.tgz
dsh --profile web
```

Open **Chat** in the Harness sidebar and start a conversation. The chat's title sits at the top left: after the first reply, the model writes a short title from the first exchange, once; a chat you renamed keeps your name, and earlier chats keep theirs (`autoTitles` turns this off). The button at the right of the message box names the model and reasoning effort: open it to drag the effort slider, or pick the model name to switch models. While Chat is open, the sidebar lists your chats where the workspace browser usually is: pinned chats first, then the rest by date, or by what needs you (running, waiting for you, new reply) from the sort menu. A spinner marks a reply in progress, a ring a chat waiting for you (an action to approve or a memory to review), and a dot a reply that finished while the chat was not open. Search finds archived chats too and tags them. **Settings** at the foot of the list opens one dialog with General, Personalization, Apps and Data controls. The **Work** row above Chat returns to the Work view without changing its selected session; the New Session button at the top still starts a Work session. The bundle adds only its own loader row; it does not replace official plugins or patch Harness.

## Conversations and files

- Stream replies, stop generation, copy messages, edit a user message or regenerate an answer. Old branches remain selectable.
- Long chats keep their whole history in view. When a chat outgrows what one model request carries (`maxContextBytes`, 512 KiB by default, less for a model with a smaller context window), older tool results are left out first, then the model condenses the oldest turns in the background so later replies still know them.
- Search titles and message bodies; rename, archive, or delete a Chat and its owned attachments. Archiving only hides a chat from the list: search still finds it, the model can still search it, and it still feeds the memory summary. Deleting is how Beluga forgets a chat. Archived chats are opened, unarchived or deleted in **Settings → Data controls**.
- Pin a Chat to the top of the list, or export it as Markdown. Tool output and reasoning stay out of the export.
- Replies list their sources beneath them: web pages, the saved memories they used, earlier chats they found, which open on a click, and Work sessions they read, which open in Work. The memory summary and custom instructions go with every reply and are not listed. Read aloud uses only voices on your device; without one it says so rather than sending text to a speech service.
- Upload text documents, extractable-text PDFs, and supported images. Scanned PDFs need OCR outside this plugin. Images require the explicit inline route below.
- When Harness has a web provider, the model searches the web when a question needs it. Turn that off in **Settings → Apps**; then only a message sent with **Web search** picked from the + menu searches. Chat never receives shell, arbitrary filesystem or deployment tools.

## Import ChatGPT history

Open **Settings → Data controls → Import ChatGPT** → select an official export ZIP or conversation JSON → review counts and warnings → **Import**.

A ZIP can be far larger than the upload limit. The browser reads only its conversation JSON, either one `conversations.json` or numbered `conversations-000.json` files, and uploads that. Media stays on your device.

The importer retains the original JSON, unknown fields, roles, timestamps, `mapping` graph and `current_node`. Select any branch to inspect it. Voice messages are read from their transcriptions. Media references remain in the original archive; export media binaries are not imported or downloaded automatically. Reasoning steps stay in the original archive too, but are left out of the history view, Markdown export and model context. Repeated imports are skipped, changed conversations create revisions, and batch undo removes only that batch's archives. Later Chat continuations survive undo.

Continue directly below an imported branch. The model receives a bounded, explicitly untrusted snapshot of that selected branch, not forged native Work logs. Omitted nodes are reported; the complete original archive stays available for viewing.

Defaults: 64 MiB upload (for a ZIP, once media is left out), 256 MiB extracted conversation JSON, 10,000 conversations, 500,000 total mapping nodes and 512 MiB stored archives. An unsupported or malformed record rejects the preview instead of silently dropping it. Checked against one real official export from November 2026; repository fixtures stay synthetic. Other exports may differ.

## Personalization and memory

**Settings → Personalization** holds your custom instructions (about you, and how to respond), the memory switches, the memory summary, and saved memories with their review queue. Each switch saves as soon as it changes. Custom instructions are included independently of keyword recall. Only narrowly recognized, source-grounded low-risk preferences can save automatically; sensitive, inferred and conflicting proposals require confirmation. A memory a reply proposes appears under that reply: undo one saved automatically, or save or dismiss one awaiting review; until then the chat shows as waiting for you in the list. A memory another chat saves automatically gets a notice with undo. Correcting a fact supersedes it; forgetting suppresses automatic relearning of its text or old evidence.

The **memory summary** is an overview of you that the model writes from your normal chats once they are idle, at most every six hours; later normal chats use it as background. Temporary Chat and imported history never feed it. It records only what you said or confirmed: drafts, translations or role-play you asked for, text you pasted and hypotheticals are not taken as your views. An update changes only the sections it needs to and leaves the others exactly as they were. Choose **Edit** in its menu to change the text yourself or paste a summary you already have. It is saved as typed, without a model, except that credentials, long numbers and email addresses are removed. **Restore previous version** undoes the latest change.

Saved-memory text/JSON and instruction Markdown can be reviewed here. Importing `AGENTS.md` requires personal-scope review; it never edits the source file or Work rules. Do not import credentials. A conversation export does not automatically reconstruct ChatGPT's separate saved-memory store.

While replying, the model can search your earlier chats and quote excerpts, which go to the selected model provider. Turn this off in Personalization. Temporary Chat and imported originals are not searched, while archived chats are; imported history reaches a model only when you continue it. Forgetting a memory does not delete the chat it came from, so the model may still find it there; delete that chat if needed.

## Work crossings

Chat and Work read nothing of each other until you turn a crossing on. **Settings → Apps → Work** has a switch for each:

- **Let Work look up personal memory** gives the main agent of each Work session a read-only tool, `personal_memory_lookup`, that returns your saved memories and memory summary, filtered by words if it asks. It never returns your custom instructions or "about you". Calls from subagents or PTC code are refused. Each call and its result is logged in the Work session like any tool call.
- **Read Work records in Chat** lets the chat model find Work sessions you started in the workspaces you tick, by time and words, and read what you and the agent said; tool calls, reasoning and notices Harness added are left out. One search reads at most the 50 newest sessions (`maxWorkSessions`) and needs no full-text session search in Harness. A reply lists the Work sessions it read beneath it; a click opens one in Work. What it reads is tool output: once a reply has read Work, it proposes nothing to memory, and the memory summary skips what the assistant said after it.

**Hand off to Work**, in a chat's menu (in the header of a Temporary Chat), asks you for a workspace, then has the model write a task brief from the chat, without memory or custom instructions, and puts it in a new Work session's message box there for you to check and send. A draft already in that box is kept, with the brief added after it. Chat never starts or sends a Work session itself.

## Temporary Chat

Temporary Chat keeps its messages and attachments in RAM and does not read or write the profile or long-term memory. It has no history entry or persisted browser draft. Leaving the view closes it; an unobserved disconnected temporary chat expires after the configured idle interval (default 60 seconds). Restarting the host loses it.

The selected model provider still receives the request and applies its own retention policy. Other user-installed Harness observers or operating-system dumps are outside the plugin's storage boundary. The plugin calls text routes without a Work `sessionId` and avoids the stock durable image-upload pipeline.

## Optional inline image route

Text reuses Harness model routing. To use images, configure one OpenAI-compatible Chat Completions endpoint that accepts inline image data and a **Harness credential reference**, not a literal API key. In your profile patch:

```yaml
- id: personal-chat
  config:
    dataDir: !!js dshHomePath('personal-chat')
    inlineProvider:
      baseURL: https://YOUR-PROVIDER.example/v1
      credentialRef: YOUR_EXISTING_CREDENTIAL_REFERENCE
      models: [YOUR_IMAGE_MODEL]
```

Select the model labeled **Inline images**. This route uses the provider API, not a ChatGPT website subscription. It requires explicit provider configuration because rc.3's native attachment pipeline persists image bytes. OpenAI-compatible streaming and inline payloads are covered by a local HTTP fixture; a real provider/model pairing still needs its own acceptance check.

## Data and removal

Owned data lives under `$DSH_HOME/personal-chat`: a private SQLite database and attachments. Back up that directory while the profile is stopped. Deleting a chat removes its history/files but retains separately confirmed memories; forget those in **Settings → Personalization**. Uninstalling the package does not delete personal data:

A newer version upgrades the database in place on first start; older versions then refuse it, so back up first.

```sh
dsh plugin --profile web remove dsh-beluga
```

Use a distinct `dataDir` for each concurrently running profile; the writer lease prevents two instances from sharing the same database.

## Office candidate

After explicit installation of the Office extension:

- **Reading:** DOCX, XLSX and PPTX as source records, and any range of a worksheet, with formulas listed apart from their saved results.
- **Preview and PDF:** Office files render on this machine with the LibreOffice engine that ships with Harness. The layout can differ slightly from Word or Excel.
- **Word:** create documents with lists, tables, charts, a table of contents, page numbers and Chinese fonts; change paragraphs of any DOCX, uploads included, with optional tracked changes; fill `{{name}}` templates.
- **Excel:** create workbooks; change cells of any XLSX, uploads included, leaving everything else as it was. Formulas are recalculated and errors such as `#REF!` come back to the model.

Every change makes a new version and keeps the original. Chat does not run code, and formulas that fetch from the network or start programs are refused. Temporary Chat keeps files in memory, so it has no preview, PDF export, recalculation or layout check. PPT authoring is not available yet.

Install the Office tarball into the existing Chat profile only after the user agrees: `dsh plugin --profile web add ./dsh-beluga-office-0.1.0.tgz`, then restart that profile. It uses the engine already installed with Harness, so nothing large is downloaded. Removing `dsh-beluga-office` disables processing while retaining chats, memory and existing artifact downloads. Neither package is published to the public market yet.
