# Personal Chat for DeepSeek Harness

[中文](README.zh.md)

One plugin adds personal Chat beside Harness Work: conversations, ChatGPT history import, a reviewed personal profile, and controlled memory. Work keeps its own sessions and tools; Chat needs no repository.

The base plugin provides Chat and Memory. Office is a recommended but separately downloaded extension, `dsh-personal-chat-office`, installed only after explicit user consent. The base package does not depend on Office or ship its processing libraries. Neither models nor uploads can install extensions.

## Build from source

No release tarball or npm package exists yet. Build one with Node 24.9+ and pnpm:

```sh
git clone https://github.com/Subaru486desuwa/dsh-chat.git
cd dsh-chat
pnpm install --frozen-lockfile
pnpm run build
pnpm run pack
```

The tarballs are written to `dist/`. Use those paths in the commands below.

## Install the built plugin

Target: **unmodified DeepSeek Harness 0.2.1-rc.3**, Node **24.9+**. This is a pre-release candidate; it has not been published to npm or a public market.

Install a built release tarball into your chosen **web** profile, then restart that profile:

```sh
dsh plugin --profile web add ./dsh-personal-chat-0.1.0.tgz
dsh --profile web
```

Open **Chat** in the Harness sidebar. Choose a configured model and start a conversation. The **Work** button returns to the existing Work view without changing its selected session. The bundle adds only its own loader row; it does not replace official plugins or patch Harness.

## Conversations and files

- Stream replies, stop generation, copy messages, edit a user message or regenerate an answer. Old branches remain selectable.
- Search titles and message bodies; rename, archive/restore, or delete a Chat and its owned attachments.
- Upload text documents, extractable-text PDFs, and supported images. Scanned PDFs need OCR outside this plugin. Images require the explicit inline route below.
- Web access is off by default. Turn it on for a request to use an existing Harness web provider; Chat never receives shell, arbitrary filesystem or deployment tools.

## Import ChatGPT history

Open **Import** → select an official export ZIP or `conversations.json` → review counts and warnings → **Import**.

The importer retains the original JSON, unknown fields, roles, timestamps, `mapping` graph and `current_node`. Select any branch to inspect it. Media references remain in the original archive; export media binaries are not imported or downloaded automatically. Repeated imports are skipped, changed conversations create revisions, and batch undo removes only that batch's archives. Later Chat continuations survive undo.

Continue directly below an imported branch. The model receives a bounded, explicitly untrusted snapshot of that selected branch, not forged native Work logs. Omitted nodes are reported; the complete original archive stays available for viewing.

Defaults: 64 MiB upload, 256 MiB extracted conversation JSON, 10,000 conversations, 500,000 total mapping nodes and 512 MiB stored archives. An unsupported or malformed record rejects the preview instead of silently dropping it. Real official-export compatibility is a separate acceptance step when the user's requested export arrives; current fixtures are synthetic.

## Profile and memory

**Memory** contains your background, personal instructions, confirmed facts and review queue. The profile is included independently of keyword recall. Only narrowly recognized, source-grounded low-risk preferences can save automatically; sensitive, inferred and conflicting proposals require confirmation. New automatic memories offer undo. Correcting a fact supersedes it; forgetting suppresses automatic relearning of its text or old evidence.

Saved-memory text/JSON and instruction Markdown can be reviewed here. Importing `AGENTS.md` requires personal-scope review; it never edits the source file or Work rules. Do not import credentials. A conversation export does not automatically reconstruct ChatGPT's separate saved-memory store.

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

```sh
dsh plugin --profile web remove dsh-personal-chat
```

Use a distinct `dataDir` for each concurrently running profile; the writer lease prevents two instances from sharing the same database.

## Office candidate

After explicit installation of the Office extension, DOCX, XLSX and PPTX support structured source reading. Word generation creates editable headings, paragraphs and tables; subsequent block edits preserve previous artifact versions. Editing uploaded templates, Excel/PPT authoring and in-chat Office previews are not yet available.

Install the Office tarball into the existing Chat profile only after the user agrees: `dsh plugin --profile web add ./dsh-personal-chat-office-0.1.0.tgz`, then restart that profile. Removing `dsh-personal-chat-office` disables processing while retaining chats, memory and existing artifact downloads. Neither package is published to the public market yet.
