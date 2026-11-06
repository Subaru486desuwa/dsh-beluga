# Personal Chat owns its conversation lifecycle

Personal Chat is one installable community plugin. It owns conversation history, branches, attachments, memory and temporary lifetimes while using the Harness's public model routing, authenticated plugin transport and application shell. Work remains unchanged.

Reusing native Work Sessions would require new core retention, deletion and UI ownership interfaces. Owning the Chat data model avoids that coupling and allows a real temporary mode and complete deletion without patching the host. It costs a plugin-specific message view and turn runner; provider integrations and safe public UI primitives remain reused.
