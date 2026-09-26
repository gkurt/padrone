---
packages:
  padrone: patch
---

## Extension fixes and additions

- `cli()` prints errors from every phase: errors thrown in a `route` interceptor, by a config file or by a validate interceptor were silent. An error is printed once even when auto-output is applied to the command too.
- `padroneUpdateCheck()` shows its notice (it never did), including after sync commands. The check only runs in `cli()`, is skipped with `--no-update-check` or `NO_UPDATE_NOTIFIER`, and times out after 3 seconds. A release now counts as newer than its own pre-releases. New `updateCommand` option customizes the suggested command.
- `padroneConfig()`: a missing `--config` file or an unparsable config file is a `ConfigError` instead of being ignored. JSON config files load outside Bun, with comments and trailing commas allowed.
- `--no-color` and `--color=false` disable colors, and `--color` forces them; they only changed the theme before. `FORCE_COLOR` is honored.
- `padroneLogger()` prints errors with their stack instead of `{}`, and no longer throws on bigints or circular objects. New `env` option reads the level from an environment variable, and `stderr: true` sends every level to stderr.
- `padroneTracing()` works with `run()`, names spans by the full command path, and adds `padrone.command` and `padrone.caller` attributes.
- A command's own `--repl` option is no longer taken over by the REPL flag, and `--repl` after positional values scopes to the command.
- A stdin field given as a positional argument is no longer reported as ambiguous when stdin is piped.
- `<cmd> help` shows the command's help for commands without positionals, and no longer swallows a `help` value of a positional argument.
- `padroneEnv()` loads `.env` files when any file option (`dir`, `local`, `base`, `override`) is set, not only `modes`.
- `cli({ runtime: { argv } })` reads `argv` from the given runtime.
- New `signal` preference for `eval()`, `cli()` and `run()` cancels a run through `ctx.signal`.
- `markErrorReported()` is exported for extensions that print errors themselves.
