---
packages:
  padrone: minor
---

## Lifecycle hooks, command-not-found handling, external commands and runtime plugins

- `.hook('preAction' | 'postAction', handler)` runs code around the action of a command and all its subcommands, with typed args and context.
- New `commandNotFound` event: a handler can run something in place of an unknown command (`event.handle()`) or route another input (`event.reroute()`); otherwise the usual error and suggestions follow.
- New `padroneExternalCommands()` extension: `my-cli foo` runs `my-cli-foo` from `PATH`, with its exit code; external commands show in help and completion.
- New `padronePlugins()` extension: plugins users install at runtime, loaded at startup, with `plugins list|install|uninstall|link`.
- Interceptors can list commands they handle in help and completion with the `extraCommands` meta.
