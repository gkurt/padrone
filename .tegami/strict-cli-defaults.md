---
packages:
  padrone: major
---

## Stricter CLI defaults

- Extra positional arguments are an error (`Too many arguments`) instead of being joined into the last positional with spaces. Positionals passed to a command that declares none are reported instead of silently dropped. Use a variadic (`...rest`) to accept any number.
- Numbers are only coerced from decimal notation; `0x10`, `Infinity` and whitespace-padded values are rejected.
- Routing and validation errors print to stderr followed by `Run "app build --help" for usage.` instead of the full help. Opt back in with `createPadrone(name, { builtins: { help: { showHelpOnError: true } } })` or `padroneHelp({ showHelpOnError: true })`.
- "Available commands" after an unknown command now goes to stderr.
- Using a deprecated option or command from `cli()` or the REPL prints a warning to stderr.
- `padroneLogger()` no longer consumes `--verbose`, `--quiet` and the other level flags when the command defines an option with that name.
- Validation issues without a path no longer print a `root:` prefix.
