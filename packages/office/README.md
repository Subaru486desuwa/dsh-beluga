# Beluga Office (opt-in)

Requires an existing Beluga installation. Recommended, but never installed with the base Chat/Memory package.

After explicit user consent, install the locally built tarball in the same profile:

```sh
dsh plugin --profile web add ./dsh-beluga-office-0.1.0.tgz
```

Restart the profile. Current capabilities: bounded DOCX/XLSX/PPTX reading and generated Word creation/revision. Excel/PPT authoring and in-chat previews are unfinished. No shell or install tool is exposed to models. Temporary processing stays in memory.

Remove with `dsh plugin --profile web remove dsh-beluga-office`; existing chats and downloadable artifacts remain. This candidate is not publicly published.
