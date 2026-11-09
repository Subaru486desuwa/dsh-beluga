# Beluga

Personal Chat for DeepSeek Harness, named after one of the most vocal whales.

[中文](README.zh.md)

One plugin adds personal Chat beside Harness Work: conversations, ChatGPT history import, a reviewed personal profile, and controlled memory. Work keeps its own sessions and tools; Chat needs no repository.

The base plugin provides Chat and Memory. Office is a recommended but separately downloaded extension, `dsh-beluga-office`, installed only after explicit user consent. The base package does not depend on Office or ship its processing libraries. Neither models nor uploads can install extensions.

## Install the built plugin

Target: **unmodified DeepSeek Harness 0.2.1-rc.3**, Node **24.9+**. This is a pre-release candidate; it has not been published to npm or a public market.

Install a built release tarball into your chosen **web** profile, then restart that profile:

```sh
dsh plugin --profile web add ./dsh-beluga-0.1.0.tgz
dsh --profile web
```

Open **Chat** in the Harness sidebar. Choose a configured model and start a conversation. The **Work** button returns to the existing Work view without changing its selected session. The bundle adds only its own loader row; it does not replace official plugins or patch Harness.

## Conversations and files

- Stream replies, stop generation, copy messages, edit a user message or regenerate an answer. Old branches remain selectable.
- Search titles and message bodies; rename, archive/restore, or delete a Chat and its owned attachments.
- Pin a Chat to the top of the list, or export it as Markdown. Tool output and reasoning stay out of the export.
- Replies list the web pages, saved memories, earlier chats and Work sessions they used beneath them. Read aloud uses only voices on your device; without one it says so rather than sending text to a speech service.
- Upload text documents, extractable-text PDFs, and supported images. Scanned PDFs need OCR outside this plugin. Images require the explicit inline route below.
- Web access is off by default. Turn it on for a request to use an existing Harness web provider; Chat never receives shell, arbitrary filesystem or deployment tools.

## Import ChatGPT history

Open **Import** → select an official export ZIP or conversation JSON → review counts and warnings → **Import**.

A ZIP can be far larger than the upload limit. The browser reads only its conversation JSON, either one `conversations.json` or numbered `conversations-000.json` files, and uploads that. Media stays on your device.

The importer retains the original JSON, unknown fields, roles, timestamps, `mapping` graph and `current_node`. Select any branch to inspect it. Voice messages are read from their transcriptions. Media references remain in the original archive; export media binaries are not imported or downloaded automatically. Reasoning steps stay in the original archive too, but are left out of the history view, Markdown export and model context. Repeated imports are skipped, changed conversations create revisions, and batch undo removes only that batch's archives. Later Chat continuations survive undo.

Continue directly below an imported branch. The model receives a bounded, explicitly untrusted snapshot of that selected branch, not forged native Work logs. Omitted nodes are reported; the complete original archive stays available for viewing.

Defaults: 64 MiB upload (for a ZIP, once media is left out), 256 MiB extracted conversation JSON, 10,000 conversations, 500,000 total mapping nodes and 512 MiB stored archives. An unsupported or malformed record rejects the preview instead of silently dropping it. Checked against one real official export from November 2026; repository fixtures stay synthetic. Other exports may differ.

## Profile and memory

**Memory** contains your background, personal instructions, confirmed facts and review queue. The profile is included independently of keyword recall. Only narrowly recognized, source-grounded low-risk preferences can save automatically; sensitive, inferred and conflicting proposals require confirmation. New automatic memories offer undo. Correcting a fact supersedes it; forgetting suppresses automatic relearning of its text or old evidence.

Saved-memory text/JSON and instruction Markdown can be reviewed here. Importing `AGENTS.md` requires personal-scope review; it never edits the source file or Work rules. Do not import credentials. A conversation export does not automatically reconstruct ChatGPT's separate saved-memory store.

While replying, the model can search your earlier chats and quote excerpts, which go to the selected model provider. Turn this off on the Memory page. Temporary Chat, archived chats and imported originals are not searched; imported history reaches a model only when you continue it. Forgetting a memory does not delete the chat it came from, so the model may still find it there; delete that chat if needed.

## Work crossings

Chat and Work read nothing of each other until a switch under **Settings → Apps → Work** is turned on; both start off.

- **Memory Lookup** registers `personal_memory_lookup`, a read-only tool for the main agent of a Work session. It returns saved memories and the memory summary, never custom instructions or the background. Subagents and PTC code are refused.
- **Work Records** lets the chat model search and read Work sessions you started in the workspaces you tick: only what you and the agent said, at most the 50 newest sessions per search (`maxWorkSessions`), at most `maxWorkBytes` per result. A reply that read Work proposes nothing to memory, and the memory summary skips what the assistant said after it.
- **Hand off to Work**, in the chat menu, writes a task brief from the chat without memory or instructions and puts it in a new Work session's message box in the workspace you choose. You send it; Chat never starts a Work session itself.

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

Owned data lives under `$DSH_HOME/personal-chat`: a private SQLite database and attachments. Back up that directory while the profile is stopped. Deleting a chat removes its history/files but retains separately confirmed memories; forget those in Memory. Uninstalling the package does not delete personal data:

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
