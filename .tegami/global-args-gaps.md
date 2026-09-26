---
packages:
  padrone: patch
---

## Global args in prompts, completions and docs

- A command with `interactive: true` also prompts for missing required global args, and `.globalArgs(schema, { interactive })` prompts for them in every command of the subtree.
- Shell completions include global options; man pages and generated docs list them under "Global Options".
- Commands under async global args are typed as async.
