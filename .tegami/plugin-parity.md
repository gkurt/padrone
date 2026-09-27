---
packages:
  padrone: minor
---

## Logs on stderr, `--jq`/`--template`, layered config, task lists, a help pager, dry runs and `version --verbose`

- `padroneLogger()` writes every level to stderr by default, so logs never mix with command output; `stdout: true` sends `trace`, `debug` and `info` to stdout as before. Level labels are colored on color terminals, and `format: 'json'` writes JSON lines (`logger.info({ userId }, 'signed in')` adds fields, errors are written as `err`).
- `padroneJson()` adds `--jq <expression>` (a built-in jq subset, or plug in a full implementation with `jq`) and `--template '{{.name}}'` to filter and format the result.
- Errors print as JSON whenever output is JSON (`--json` or `format: 'json'`), including errors an error interceptor replaced.
- `padroneConfig()` adds `merge: true` to layer every config found (user config directory, then parent directories, then cwd), and follows `extends` keys in config files (disable with `extends: false`).
- `ctx.context.progress.tasks([...])` runs a list of tasks drawn live, like listr2, with subtasks, skips, concurrency and `exitOnError`. `taskRenderer` replaces the drawing.
- `--version` works on subcommands (single-character flags stay root-only), and `version --verbose` shows the runtime, platform, architecture and shell. `padroneVersion({ info })` adds fields.
- `builtins: { help: { pager: true } }` shows help taller than the terminal through a pager, like git: `$PAGER`, or `less -FRX`. Only in `cli()` on a terminal; `--no-pager` prints the help directly and `--pager` pages it even when it fits. The runtime's `terminal` gains `rows`.
- New `.dryRun(handler)` builder method: the command accepts `--dry-run` / `-n`, and under that flag the handler runs instead of the action (after validation) and its return value is printed. Only commands with a dry-run handler accept the flag or show it in help, so it's never silently ignored. Interceptors see `ctx.dryRun`, `padroneConfirm()` skips its prompt, `tool()` needs no approval, and MCP/serve take a `dryRun` argument.
- `--no-color` and `--color=…` apply to errors from failed parsing too.
- `padroneTracing()` records errors thrown while parsing in a root span.
- `padroneInk()` returns the first frame as text for serve, MCP and `tool()` calls instead of mounting the app.
