---
packages:
  padrone: minor
---

## REPL: `exit` and `quit`, and tab completion like shell completion

- Plain `exit` and `quit` leave the REPL, like `.exit`, unless the program or current scope has a command with that name.
- REPL tab completion offers options as help shows them (`--dry-run`, not `--dryRun`), never hidden ones, and deprecated commands and options only when nothing else matches what's typed.
