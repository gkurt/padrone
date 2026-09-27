---
packages:
  padrone: patch
---

## REPL context, prompt, test context and table fixes

- The `repl` command and `--repl` now pass the context given to `cli()` to every command in the session. `repl()` takes a `context` option.
- `testCli(program).context(value)` sets the context for `.run()` and `.repl()`, so programs that declare one can be tested.
- Bordered tables (`output: 'table'`, `ctx.context.output.table()`) line up in color terminals, and the divider is as wide as the rows.
- Interactive prompts coerce typed answers like CLI input, so number fields (`z.number()`) accept `42` instead of re-prompting forever.
