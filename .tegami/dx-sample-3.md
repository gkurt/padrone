---
packages:
  padrone: patch
---

## Fix typing and context gaps found writing a third sample program

- Aliased subcommands inside a `defineCommand()` group keep their names, so `eval()`, `parse()` and `testCli()` still infer the command instead of `never`
- `run()` rejects a command name it doesn't know (`run('lsit', {})`); a `string` variable is still accepted
- `tool()`, `serve()` and `mcp()` take a `context`, required when the program declares one; the `serve` and `mcp` commands pass on the context given to `cli()`
- `defineInterceptor({ name }).on(event, handler)` defines an interceptor that only handles an event
- `Option "-l" requires a value` is no longer prefixed with the option's name
- A program's `.context(transform)` no longer changes the context callers pass: after `.context<{ url: string }>().context((ctx) => ({ db: connect(ctx.url) }))`, `cli()`/`eval()`/`run()` take `{ url }` and commands get `{ db }`; later transforms get the previous one's output
- Commands that require no args take none, `undefined` or `{}` in `run()` and `api()` (`program.run('status')`, `api.status()`), and serve accepts a `null` body for them
