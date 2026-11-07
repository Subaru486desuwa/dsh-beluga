# Beluga Office (opt-in)

Requires an existing Beluga installation. Recommended, but never installed with the base Chat/Memory package.

After explicit user consent, install the locally built tarball in the same profile:

```sh
dsh plugin --profile web add ./dsh-beluga-office-0.1.0.tgz
```

Restart the profile. It adds:

- `read_sheet`, and DOCX, XLSX and PPTX reading through `read_attachment`.
- `create_document`, `edit_document`, `fill_template` for Word.
- `create_workbook`, `edit_workbook` for Excel, with recalculation and an error report.
- Preview and PDF export on file cards.

Rendering and recalculation use `@deepseek-ai/libreoffice-kit` (MPL-2.0) as a peer: Harness ships it, so this package does not download the engine. LibreOffice's copy of a workbook is only read for its values; the delivered file stays the original plus the requested changes.

No shell or install tool is exposed to models. Temporary Chat stays in memory, so nothing it holds reaches the engine, which needs files on disk.

The engine made no network requests in tests on Linux, where it runs as WebAssembly. Its native builds for macOS and Windows have not been tested for this.

Remove with `dsh plugin --profile web remove dsh-beluga-office`; existing chats and downloadable artifacts remain. This candidate is not publicly published.
