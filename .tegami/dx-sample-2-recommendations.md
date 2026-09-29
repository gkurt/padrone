---
packages:
  padrone: minor
---

## Clearer help and errors

- Help shows `<value>` for options that take a value and `[value]` only where it can be left out (`--json [fields]`), marks required options `(required)`, and shows `boolean | string` options as `[string]`.
- Unknown options read `Unknown option "--limt". Did you mean "--limit"?`, without the `limt:` in front.
- Text tables no longer end lines in blanks.

## Config and env

- Config files apply per-command sections by default (`sections: 'auto'`): `{ "list": { "limit": 1 } }` sets `--limit` for `list`, unless the running command has an option named `list`. `sections: false` restores the old behavior.
- `padroneEnv({ prefix: 'APP', scope: 'command' })` reads a subcommand's own options from `APP_<COMMAND>_<OPTION>` (`APP_LIST_LIMIT`), so commands don't share variables. Global options keep `APP_<OPTION>`.

## Typing

- `conflicts`, `implies`, `requires`, `requiredIf` and `requiredUnless` in `.arguments()` fields only accept the command's options and global options.
- `testCli(program).run(input)` types `result`, `args` and `command` by the command the input names, and `.context()` by the program's context.
