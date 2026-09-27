---
packages:
  padrone: minor
---

## Option values from files, and response files

- `fromFile: true` field meta: a command-line value `@path` reads the file, `-` reads stdin, and `@@text` passes `@text`. Values from env, config files and serve/MCP/`tool()` calls are taken as given. Help marks such options `(@file or - for stdin)`.
- `padroneResponseFiles()` expands `@file` arguments into the arguments listed in the file (one or more per line, `#` comments, nested files), in `cli()`, `eval()` and the REPL. A missing file is an error; `@@` escapes a leading `@`.
