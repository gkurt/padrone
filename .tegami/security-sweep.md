---
packages:
  padrone: patch
---

## Plugin and security hardening

- `padroneUpgrade()` runs the installer without a shell on Windows and checks the package name.
- `padronePlugins()` ignores `plugins.json` entries with unsafe names, writes the file privately and atomically, and has an `ignoreScripts` option.
- The file credential backend can't be tricked by a `__proto__` service and cleans up its temp file.
