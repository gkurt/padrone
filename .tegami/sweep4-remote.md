---
packages:
  padrone: patch
---

## Fourth extension sweep: MCP, serve, tracing and Ink

- Serve and MCP arguments round-trip better: `false` reaches booleans whose `--no-` prefix is disabled, empty arrays stay empty instead of taking the default, and array items like `[x]` aren't split as list syntax. `stringify()` follows.
- Serve GET: a param without a value (`?name=`) is an empty string instead of taking the next param as its value; for a boolean (`?verbose`) it still turns it on.
- MCP `tools/call` with `arguments` that aren't an object is an invalid-params error.
- `tool()`: what a successful command writes to stderr (warnings, logs) is in `logs`, not `error`.
