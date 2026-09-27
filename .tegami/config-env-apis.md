---
packages:
  padrone: minor
---

## Config, env, response file and alias additions

- A script config can export a function (sync or async) that gets `{ command, env, envName, profile }`; `defineConfig()` from `'padrone'` types it.
- `searchParents: 'project'` stops the parent search at the nearest directory with `.git` or `package.json`, and `stopDir` sets the last directory to search.
- `$production: { ... }` and `$env: { staging: { ... } }` in a config override its values for the active environment (`envName`, `NODE_ENV` by default); `$` keys are never option values.
- `padroneEnv()` splits variables for array options on commas (`APP_TAGS=a,b`; `arraySeparator` changes it, `[...]` reads JSON), and `nestedSeparator` replaces the `__` in nested variable names.
- `.env` files support `${VAR:+alt}`, `${VAR+alt}`, `${VAR:?message}` and `${VAR?message}`; a missing required variable is an error naming the file.
- `padroneResponseFiles({ relativeTo: 'file' })` resolves nested response files beside the file that names them.
- `alias import <file|->` adds aliases from YAML or JSON (`--clobber` overwrites existing ones), `alias export [file]` writes them, and `alias list` now prints YAML that imports back.
