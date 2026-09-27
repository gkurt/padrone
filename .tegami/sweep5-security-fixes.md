---
packages:
  padrone: patch
---

## Fifth sweep: security hardening and plugin fixes

- Serve and MCP no longer expose built-in commands (`config`, `alias`, `upgrade`, …), and `config`, `alias`, `completion`, `man`, `serve`, `mcp` and `upgrade` refuse serve, MCP and `tool()` calls.
- Serve rejects requests from other websites like MCP does: an `Origin` that isn't loopback, the server's own host or the `cors` origin gets 403.
- Serve and MCP bound to a loopback host reject a non-loopback `Host` header (DNS rebinding).
- New `maxBodySize` option for serve and MCP over HTTP (default 4 MiB); larger request bodies get 413.
- Serve rejects GET query values for whole objects or arrays that hold a `sensitive` field, and leaves them out of the OpenAPI GET parameters.
- A JSON, YAML or TOML config (or a `package.json` key) can no longer `extends` a script config.
- The REPL history file is created readable only by the user, and `historySize: 0` keeps no history.
- `runtime.editor()` and `padrone link` shims quote file paths for the shell; static completion scripts quote enum values.
- `padrone init` writes names and descriptions with quotes as valid JSON and TypeScript.
- Update checks ignore registry and cached values that aren't versions, and check again when the last check is in the future.
- Inside the REPL (`--repl` or the `repl` command), Ctrl+C interrupts the running command instead of the session; a Ctrl+C after a caller's `signal` aborted the run stops it instead of force-exiting.
- A throwing command-level shutdown handler no longer skips the root's shutdown handlers.
- Events and `getRootCommand()` work from the subcommands of mounted programs.
- Nested sensitive keys (`db.password`) get masked prompts, and under `-i` a blank answer to a masked prompt keeps the given value.
- Validation errors about nested config and env values name the right source.
- `.env` files: an unclosed quote is read as an unquoted value, a tab before `#` starts a comment, `$toString`-style names don't expand, and trailing whitespace on a multiline value's first line is kept.
- A runtime `stdin` with `isTTY: true` isn't read for `stdin` fields, and a `fromFile` `-` no longer conflicts with a `stdin` field that wouldn't read.
- `--jq`: `from_entries` follows jq 1.7.1, fractional slice bounds round like jq, strings sort by code point, and `__proto__` keys are kept in constructed objects.
- Logger `redact` also censors class instances.
- Progress spinners, bars and task lists redraw multi-line and wide-character text correctly.
- Man pages escape lines that would start with `.`.
