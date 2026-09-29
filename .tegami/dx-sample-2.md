---
packages:
  padrone: minor
---

## Global args for commands in their own files

- Commands added with `defineCommand()` and mounted programs take the program's global args in `run()`, `api()` and `InferArgsOutput`, as inline commands already did.
- `defineCommand<Context, typeof globals>()` types the global args inside the command. Its result can be reused for every command.

## Help and suggestions

- `--help` lists the options of `padroneFormat()` (`-o`), `padroneJson()` (`--json`, `--jq`, `--template`), `padroneLogger()` and `padroneTiming()`, leaving out short flags a command's own options use.
- A command group's help ends with the `Run "... --help"` hint instead of showing it before the options.
- Options and positionals without a description leave no trailing spaces in help.
- A mistyped command suggests each command once: `Did you mean "list"?`, not `"list" or "ls"`.
