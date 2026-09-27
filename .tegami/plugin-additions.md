---
packages:
  padrone: minor
---

## Self-update, aliases, and more prompts

- `padroneUpgrade()` adds an `upgrade` command that installs the latest version with the package manager the program was installed with (npm, bun, pnpm, yarn or Homebrew, detected). `--check` only reports, `--to <version>` installs a given version, `--channel next` follows another dist-tag, and `--dry-run` shows the command. A custom `installer` can perform the upgrade itself.
- `padroneAliases()` expands command aliases before routing. The program can define some (`aliases: { co: 'checkout' }`), and people add their own with `alias set pr "checkout pr/$1"`, `alias list` and `alias delete`, kept in the program's config directory.
- `builtins: { suggestions: { run: 'prompt' } }` asks whether to run the closest command after an unknown one.
- `builtins: { help: { pickSubcommand: true } }` asks which subcommand to run when a group command runs without one.
- `ctx.runtime.editor(text)` opens the user's editor and returns what they saved, `ctx.runtime.open(url)` opens a URL or file with the default app, and `ctx.runtime.page(text)` shows long output through a pager. All three can be replaced in the runtime.
- `program.dirs` gives the program's standard `config`, `cache`, `data`, `state` and `log` directories for each platform (XDG on Linux); `getProgramDirs()` computes them for any name.
- `.arguments(schema, { exactlyOne: ['file', 'url'], atLeastOne: ['email', 'slack'] })` requires exactly one, or at least one, of a group of options (several groups as an array of arrays; also on `.globalArgs()`).
- `.requires<T>('padrone:logger')` (or `requires` in interceptor meta) checks at runtime that the named interceptors are registered, and fails with an error naming a missing one.
- Pre-release versions are ordered correctly (`beta.10` after `beta.2`, `alpha` before `beta`) in update checks.
- Interceptor meta `async` is kept by `defineInterceptor(meta, factory)`, so config and env loading no longer print the "not marked as async" warning.
