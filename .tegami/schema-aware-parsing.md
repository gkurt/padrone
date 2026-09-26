---
packages:
  padrone: major
---

## Schema-aware CLI parsing

- Boolean flags no longer swallow the next argument: `build --verbose file.txt` keeps `file.txt` positional, and `group --verbose sub` still routes to `sub`. Explicit boolean words (`--verbose false`) still work.
- Short flags accept attached values: `-n5`, `-ofile`, `-vn5`.
- Options that need a value take the next argument even when it starts with `-` (`--pattern -foo`), and report `Option "--name" requires a value` when it's missing.
- A repeated non-array option keeps the last value instead of failing validation.
- `--title=[WIP]` stays a string; the bracket array syntax only applies to array options.
- Nested option values are coerced (`--user.id 7` → `7`).
- A lone `-` and negative numbers are positionals, never command names.
- An argv positional equal to the program name is no longer dropped.
- Fixed prototype pollution through option paths like `--__proto__.x=1`.
- Interceptors can declare the options they read from `rawArgs` via `meta.options`, so the parser knows whether each takes a value.
- `eval()` and `parse()` accept an argv array in their types.
