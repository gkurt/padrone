---
packages:
  padrone: minor
---

## Typing fixes and shorthands

- Commands from `defineCommand()` take the name they're registered under, so `run()`, `api()` and `find()` resolve them, and they no longer break the typing of other commands.
- `defineCommand<Context>()((c) => ...)` types a command with the program's context. `defineCommand<Context>(fn)` is now a type error: it lost the command's type.
- A program's `.context<T>()` must be passed to `cli()`, `eval()`, `run()`, `repl()` and `api()`. A `.context(() => ...)` transform on the program creates the context, so callers pass none.
- `InferCommand` works for programs with a context.
- `defineInterceptor(meta).provides<T>().factory(fn)` type-checks the `context` handlers pass to `next()`.
- `MaybePromiseCommandResult`, `PadroneAPI`, `MaybePromise` and `Thenable` are exported, so results can be exported from `declaration` builds.
- `stringify()` args can leave out fields that have defaults.
- `.extend()` takes several extensions: `.extend(padroneJson(), padroneFormat())`.
- `.describe(text)` sets a command's description.

## `run()` and `api()`

- `run()` checks args against the schema and applies its defaults. Invalid args return in `argsResult.issues`.
- `run()` and `api()` no longer print results.
- `api()` takes `{ context, signal }`. Its functions throw on invalid args or a failing action instead of returning `undefined`.

## Command-line output

- Error `suggestions` are printed after the message.
- Validation errors say `Missing required argument`/`Missing required option` and `Expected number, got "abc"`.
- Unknown options read `Unknown option: "x". Did you mean "--y"?`.
- Help lists `--yes` on commands `padroneConfirm()` may ask for, puts global options after the command's own, shows env variables inline as `(env: APP_PORT)`, and shows variadic positionals as `<files...>`.
- Table, csv and tsv cells show lists of plain values as `a, b`.
- Objects and arrays print as JSON when stdout isn't a terminal.
