---
packages:
  padrone: patch
---

## Extension fixes

- MCP and serve pass arguments intact: values with spaces or quotes, arrays, nested objects and booleans with a custom `negative` keyword. MCP no longer returns a command's output twice, and `tool()` no longer repeats the result in `logs`.
- MCP: the root command's tool is named after the program instead of `""`, each HTTP client gets its own session, `/mcp?x=1` matches the endpoint, and notifications get no response.
- Serve: `basePath` works without a trailing slash, and paths outside it are 404s. Bad input (e.g. an extra positional) is a 400 `bad_request` instead of a 404, validation errors go through `onError` with a `message`, an empty POST body means no arguments, and a throwing `onRequest` or `onError` gives a 500 instead of a hung request.
- `--yes=false`, `--json=false`, `--help=false`, `--no-repl` and similar are off, not on.
- A config file only fills options the command has (by name, alias or kebab-case key), so a program-wide config no longer breaks other commands. `null` means unset, nested objects merge under CLI values, and a positional typed on the command line wins over config and env. Config values are applied before interactive prompts. `.env` variables that aren't options are no longer rejected as unknown, and are visible to `runtime.env()`.
- Config and env loading no longer print a "not marked as async" warning.
- Auto-output prints a returned `Set`, `Map` or `Uint8Array` as one value instead of item by item, and `--jq` applies to commands with a declarative `output` format.
- Signals: the abort `reason` is a `SignalError`, so `ctx.signal.throwIfAborted()` exits 130/143. A repeated SIGTERM or SIGHUP force-exits.
- Progress: shutdown interceptors registered after it run again, the spinner hides during `padroneConfirm` prompts, a streamed result succeeds or fails when it's consumed, `--dry-run` shows no success message, and a task whose `skip()` throws is marked failed.
- `--log-level` accepts any case and rejects unknown levels.
- Empty piped stdin leaves an array field to its default.
- `padroneUpdateCheck()` works on a command, and a failed check is cached so offline machines don't wait every run.
- `padroneTracing()` marks validation failures on the span and records the failing phase.
- `padroneInk()` keeps sync commands sync. New `remote: 'exit'` option mounts the app headlessly for serve, MCP and `tool()` calls and returns its last frame.
- Help: `--help` no longer reads piped stdin first; `help <unknown>` is an unknown-command error; `--all` lists only registered built-ins; the subcommand hint includes the program name; option suggestions use kebab-case names and catch case-only typos.
- `--version` keeps flags like `--json`.
- REPL: the `repl` command no longer prints the session's results when it ends, uses the runtime passed to `cli()` (new `runtime` REPL option), honors `FORCE_COLOR`, and doesn't crash when started inside a REPL.
- Man pages for subcommands are named `<program>-<command>.1` so they can't shadow system pages, and lines starting with `.` are escaped.
- Completion: dynamic completion skips the value of extension options (`-c file`); the bash script handles `:` in words and quotes candidates with spaces; static scripts fix fish long aliases, bash spacing and PowerShell enum values.
- New interceptor meta `async: true` marks interceptors that may make validation async.
