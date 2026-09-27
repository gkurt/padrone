---
packages:
  padrone: minor
---

## Completion, REPL, help search and man page improvements

- Shell completion offers short flags (`-v`) when the word is `-` or `-v`, and only the kebab-case name of camelCase options (`--dry-run`, not `--dryRun`), as help shows them.
- Completion hides deprecated commands and options; they still complete when nothing else matches what's typed. Static scripts leave out hidden and deprecated ones.
- The bash scripts no longer glob-expand candidates like `src/*`.
- The PowerShell script works on Windows PowerShell 5.1, which dropped the empty word being completed.
- `completion <shell> --instructions` prints how to install the script, for the named shell or the detected one; the instructions above a detected shell's script are now comments, so evaluating the output only loads the script.
- REPL: `historyFile` keeps history between sessions (`true` stores it in `program.dirs.state`), capped by `historySize` (default 1000). Initial `history` entries now come up in the right order.
- REPL: a mistyped `.scope` gets "Did you mean", and `help <command>` inside a scope shows help for the scope's commands.
- `help --search <term>` (`-s`) lists commands and help topics matching every word of the term.
- Man pages put the date and `<program> <version>` in `.TH` (the date from `generateDocs`'s new `date` option, `SOURCE_DATE_EPOCH`, or today) and link the parent and subcommand pages under SEE ALSO.
