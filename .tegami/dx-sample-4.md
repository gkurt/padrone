---
packages:
  padrone: minor
---

## Results and running other commands

- `run()` awaits an async action's result, like `eval()`: `(await program.run('sync')).result` is the resolved value, and a rejected action is reported in `error`. Results are typed as the awaited value, and the call as a promise when the action is async.
- Actions and hooks get `ctx.run(name, args)`, which runs another command with this run's context and signal and resolves to its result.
- `ctx.program.run()` accepts args again (it rejected every args object).

## Typing

- A `defineCommand().requires<T>()` command is a type error at `.command()` when nothing provides `T`.
- Event handlers' `ctx.context` is typed by the interceptor's `.requires<T>()`.
- `defineArgsMeta(schema, meta)` types an arguments meta kept apart from `.arguments()` / `.globalArgs()`, with no `as const`.
- `.configure()` callbacks used before `.arguments()` now get an error that says to call `.configure()` after `.arguments()`.

## Parsing

- An optional positional before a required one (`[method] <url>`) only takes a value when the required one still gets one: `http https://x` sets `url`.
- Object and record options take `key=value`: `-q page=2 -q sort=asc`.
- Reading stdin again in the same process (a second `eval()`) gives nothing instead of failing with `Premature close`.

## Help and errors

- Object defaults show as JSON (`{"max":5}`) instead of `[object Object]`; empty objects are left out.
- Options that extensions add to every command (`--json`, `-o`, `--config`, …) are listed under Global Options, after the program's global args.
- An option read from stdin says so once, in its notes.
- An invalid list item reads `Invalid value "nocolon" for "--header": …` instead of `header.0: …`.
- Object options show `<key=value>` in help.

## Testing

- `testCli(program).cli(input)` runs a command as `cli()` does: confirmations, printed errors and deprecation warnings.
- Test results have `exitCode`.
