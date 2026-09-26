---
packages:
  padrone: minor
---

## Add `.globalArgs()`

Define options once for a command and every subcommand below it: `createPadrone('app').globalArgs(z.object({ verbose: z.boolean().optional() }))`. They are accepted before or after the subcommand name, merged into each command's typed `args`, validated separately, and listed under "Global Options" in help and in MCP/serve input schemas. A subcommand overrides a global by defining a field of the same name, or extends the globals for its subtree with `.globalArgs((inherited) => inherited.extend({...}))`.
