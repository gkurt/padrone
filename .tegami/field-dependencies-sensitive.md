---
packages:
  padrone: minor
---

## Dependent and sensitive options

- `requires: ['password']`, `requiredIf: { format: 'file' }` and `requiredUnless: ['user', 'key']` field meta make an option required depending on the others. They work in `.globalArgs()` too, are shown in help, and a missing option covered by `interactive` is prompted.
- `sensitive: true` marks a secret: it's prompted without echo, its default and examples are left out of help, and MCP/serve input schemas mark it `writeOnly`.
- `redactArgs(command, args)` returns args with sensitive values replaced by `'[redacted]'`, for extensions that log them.

## Implied values with interactive prompting

- An option that both implies and conflicts with another (`implies: { color: false }`, `conflicts: 'color'`) no longer fails on its own in commands with interactive prompting.
