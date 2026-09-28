---
packages:
  padrone: minor
---

## Plugin and security hardening

- `padroneUpgrade()` runs the installer without a shell on Windows and checks the package name.
- `padroneUpgrade()` has `--rollback`, and `verifySignature()` checks Ed25519 or ECDSA release signatures.
- `padronePlugins()` ignores unsafe `plugins.json` names, writes it privately and atomically, and pins each plugin's version and file hash.
- `padronePlugins()` has `allow`, `apiVersion` (plugins declare `padroneApi`), `override`, `ignoreScripts`, `plugins update`, `plugins info` and `plugins list --json`.
- `padroneConfig({ scripts })` refuses or vets script configs, which run code.
- `padroneExternalCommands({ env })` limits the variables external commands inherit.
- `padroneCredentials` has `list()`, and the file backend handles a `__proto__` service safely.
- `padroneUpdateCheck({ channel })` follows a dist-tag with its own cache.
- Aliases, the update cache and credentials are written atomically.
