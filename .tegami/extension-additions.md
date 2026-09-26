---
packages:
  padrone: minor
---

## New extensions and extension options

- `padroneJson()` adds a `--json` flag: the result is printed as JSON (iterator items one per line), and in `cli()` errors are printed as `{ "error": { ... } }` on stdout, with validation issues. With `format: 'json'`, auto-output prints values as JSON in `cli()`, `eval()` and the REPL.
- `padroneConfirm()` asks before running `mutation: true` commands in `cli()` and the REPL. `--yes`/`-y` skips the question; without a terminal the command fails unless `--yes` is given.
- Dynamic shell completion: with `padroneCompletion()`, the generated scripts ask the program (`<program> __complete ...`) and complete per command — its subcommands, options and inherited global options, enum values, and values from a field's new `complete` callback.
- `padroneLogger()`: `--verbose` can be repeated (twice is `trace`), and `shortFlags: true` adds `-v`, `-vv` and `-q`. Interceptors can declare `count` options.
- `padroneTracing()`: pass `api: { context, trace }` from `@opentelemetry/api` so `tracing.span()` children and instrumented libraries are parented to the command's span.
- Stack traces: set `DEBUG=1` or `builtins: { autoOutput: { errorStack: true } }` to print an error's stack and `cause` chain in `cli()`.
- `serve()` aborts a command's `ctx.signal` when the client disconnects, and MCP aborts a tool call on `notifications/cancelled` or disconnect. The MCP stdio transport handles messages concurrently.
- `-i`/`--interactive` is accepted, and ignored, on commands without interactive fields instead of failing as an unknown option.
- A `stdin` field makes the command async, so reading piped input no longer warns about a missing `.async()`.
- On commands with interactive fields, options declared by extensions (e.g. `--yes`) are no longer rejected as unknown before prompting.
