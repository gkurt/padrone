---
packages:
  padrone: patch
---

## Fourth extension sweep: help, REPL and completion

- Shell completion keeps offering a variadic option's values after its first one (`--files a.ts <TAB>`).
- `help db <TAB>` completes the subcommands of `db`, not only the first word after `help`.
- Without a subcommand, completion offers the options of a default (`''`) command, which such options run.
- `.scope db migrate` in the REPL scopes into the nested command instead of failing, and `.scope` reports the full path it couldn't use.
- REPL tab completion offers global options and the help flags the program has (`padroneHelp({ flags })`) instead of always `--help`/`-h`, and no longer offers an empty alias.
- Help, generated docs and man pages leave out empty defaults (`[]`, `''`) of positionals too; man pages no longer show a `boolean` placeholder after flags; Markdown command tables keep descriptions with `|` or line breaks in one row.
