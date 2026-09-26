---
packages:
  padrone: minor
---

## Variadic options

`variadic: true` on an array option takes every following value up to the next option: `--tags a b c`. Positionals after it need `--`, and `--tags=a` still takes a single value.
