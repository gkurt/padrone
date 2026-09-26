---
packages:
  padrone: minor
---

## Help customization

- `.configure({ help: { usage, before, after } })` replaces a command's usage line and adds text before or after its help.
- `.configure({ help: (info, ctx) => ... })` customizes help with a function for a command and its subcommands. It returns modified help info or the final string, and `ctx.render` gives the built-in renderer.
- Rename or remove the help and version flags with `builtins: { help: { flags: ['help', '?'] }, version: { flags: ['version'] } }`.
