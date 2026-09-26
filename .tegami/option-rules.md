---
packages:
  padrone: minor
---

## Counting, conflicting and implied options

- `count: true` on a number option counts repeated flags: `-vvv` → `3`.
- `conflicts: ['table']` rejects options used together, and `implies: { color: false }` sets other options when one is used. Both are shown in help.
- Built-in flag handling (`--version`, `--color`, `--help`, `--config`, `--interactive`, `--timing`, `--no-update-check`) no longer takes over a command's own option of the same name.
