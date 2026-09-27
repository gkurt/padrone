---
packages:
  padrone: minor
---

## Remote access controls for serve, MCP and tool()

- `.configure({ expose })` says which callers may run a command and its subcommands: `false` for local callers only, or a list such as `['cli', 'mcp']`. Servers don't list a command they can't run, and running it from another caller fails. Built-in commands (`config`, `alias`, `plugins`, `upgrade`, …) are local only; `help` and `version` stay available.
- `serve()` and `mcp()` take `include` / `exclude` (command paths, globs like `'db.**'`, or a predicate) to offer only some commands.
- `auth` (a function of the `Request`) and `bearer` (tokens) authenticate requests to `serve()` and MCP over HTTP; refused ones get 401. Actions, hooks and interceptors read the identity as `ctx.auth`, which `eval()` and `cli()` also take as `auth`.
- `allowedHosts` lists the `Host` names a server answers, protecting non-loopback bindings from DNS rebinding too; `true` turns the check off.
- `timeout` aborts a command that runs too long (serve: 504; MCP: a JSON-RPC error), and `maxConcurrent` refuses requests over a limit (serve: 503). `tool({ timeout })` works the same way.
- MCP HTTP sessions can expire after `sessionTtl` ms without requests, and `maxSessions` (1000 by default) drops the least recently used one.
- `serve()` and `mcp()` log the port they actually listen on, so `port: 0` works.
- With `auth` or `bearer`, an MCP session only answers the identity that created it.
