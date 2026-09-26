---
packages:
  padrone: patch
---

## Fix schema inheritance and invalid env values

- `.arguments((parent) => parent.extend({...}))` now receives the parent command's schema; it used to receive `undefined` and throw. Passing `meta` (e.g. `positional`) alongside it no longer breaks type inference.
- `padroneEnv()` reports a set but invalid variable as a validation error instead of silently ignoring every env value.
