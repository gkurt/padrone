---
packages:
  padrone: patch
---

## `drain()` fixes

- `drain()` is cached: draining a result twice gives the same answer, even for an iterator result with auto-output turned off.
- A plain result returned by a start interceptor now has `drain()`.
- `cli()` sets the exit code for an error that surfaces while draining only once.
