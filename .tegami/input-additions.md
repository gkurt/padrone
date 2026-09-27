---
packages:
  padrone: minor
---

## Input improvements: aliases, response files, prompts, stdin and confirm

- "Did you mean" for an unknown command also suggests `padroneAliases()` names, and unknown options are matched against options extensions declare (`--json`, `--yes`, `--interactive`, …), leaving out help's own options. A default command's empty name is never suggested.
- Aliases take a `$@` placeholder for the words no `$N` takes (without `$@` they're still appended), and `@file` words in an alias expand as response files.
- `alias set co checkout --force` works without quotes: every word after the name is the expansion.
- With `padroneResponseFiles()`, the value of a `fromFile` option (`--body @notes.md`) is read by `fromFile` instead of expanded as a response file, so `--body @@x` now passes `@x`.
- Interactive prompts ask object fields key by key (`db.host`, `db.port`), and ask again after a blank answer to a required field.
- `stdin: { field, trim: true }` trims piped text; number and boolean stdin fields are always trimmed (`echo 21 | my-cli double`), and a lone `-` value reads stdin (`my-cli cat -`).
- `padroneConfirm()` runs without asking when `<PROGRAM>_YES` is set (e.g. `MY_CLI_YES=1`); `env` renames the variable, `env: false` turns it off.
