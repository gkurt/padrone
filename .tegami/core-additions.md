---
packages:
  padrone: minor
---

## JSON values for object options, non-mutating interceptor chaining, same-id interceptors across layers

- Object, record and array-of-object options take JSON on the command line (`--db '{"host":"x"}'`, `--items '[{"name":"a"}]'`, or one `--items '{"name":"a"}'` per item), alongside dotted keys, which merge with it (the later value wins). Invalid JSON is reported as a validation issue. JSON from env variables and `fromFile` files (`--db @db.json`) is parsed too.
- Serve, MCP and `stringify()` pass objects that dotted keys can't express (record keys with dots, arrays inside, empty objects) and arrays of objects as JSON, so they reach the command intact. `stringify()` quotes values with quotes in them.
- `OptionArity` has a new `'json'` value for these options.
- `.on()` and `.requires()` on an interceptor return a new interceptor instead of changing the one they're called on, so a handler added to a shared interceptor no longer leaks into other programs.
- A command-level interceptor with the same `id` as a root one now replaces it in the error and shutdown phases too, instead of both running.
