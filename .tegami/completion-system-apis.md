---
packages:
  padrone: minor
---

## Completion, wrap, upgrade, update-check and man options

- `.configure({ complete })` completes a command's positionals in one place, like cobra's `ValidArgsFunction`: it gets the word's `position`, `field` and the `positionals` before it. A positional field's own `complete` still wins.
- `complete` callbacks also get the `field`, the `runtime` and the `context`, and may return `{ values, directive }` to set the fallback (`'files'`, `'dirs'`, `'ext:json'`, `'commands'`, `'nofiles'`).
- `padroneCompletion({ mode: 'static' })` or `completion <shell> --static` prints the static script; `descriptions: false` or `--no-descriptions` leaves descriptions out. `--setup` keeps these flags and writes under the runtime's `HOME`. `program.completion(shell, { mode, descriptions })` takes them too.
- `.wrap({ separator: '--' })` puts positionals after `--`, and `flagStyle: 'equals'` passes `--key=value`.
- `padroneUpgrade({ verify })` checks a release before installing it; resolving `false` refuses the upgrade. New `verifySha256(data, expected, fileName?)` checks a download against a digest or a `SHA256SUMS` file in a custom installer.
- `padroneUpdateCheck({ shouldNotify, format })` suppresses or rewords the update notice (`format` also applies to `version --check`).
- `padroneMan({ section, dir })` sets the man section and where `man --setup` installs; `generateDocs` takes `section`. `man --setup` now reads `XDG_DATA_HOME` and `HOME` from the runtime env, and `"` in `.TH` arguments is escaped.
