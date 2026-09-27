---
packages:
  padrone: minor
---

## Config profiles and a `config` command

- `padroneConfig({ profiles: true })`: a config's `profiles.<name>` values override its top-level ones when selected with `--profile <name>`, the `<PROGRAM>_PROFILE` environment variable, or a top-level `profile` key. An unknown profile fails with the available ones. `{ flag, env }` renames the flag and the variable. Help lists `--profile`.
- `padroneConfig({ command: true })` adds `config get|set|unset|list|path|edit` for the user config file, like `git config`. `set` checks the key against the program's options and coerces and validates the value; only JSON files are written. `list` shows where each value comes from, and `edit` saves only a config that still parses.
- Interceptors can list their options in help with `meta.helpOptions`.
