---
packages:
  padrone: minor
---

## Completion descriptions, value hints and value names

- Dynamic completion shows descriptions for subcommands, options, literal union values and `complete` items, which may now be `{ value, description }` (zsh, fish and PowerShell; bash shows values). The scripts call `<program> __complete2`, which prints `value<TAB>description` lines and a directive; `__complete` still prints values only, so regenerate scripts installed from an earlier version to get the new behavior.
- New field meta `hint` (`'file'`, `'dir'`, `{ ext: ['json'] }`, `'command'`, `'url'`, `'none'`) sets what completion offers for a value when no candidate matches, in dynamic and static scripts. Values with enum values or `complete` no longer fall back to file names unless hinted.
- New field meta `valueName` sets the value placeholder in help, docs and man pages: `--out <DIR>`, and `<DIR>` for a positional.
- Static zsh and fish scripts now know which options take a value.
