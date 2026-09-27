---
packages:
  padrone: minor
---

## jq interpolation and generators, safer output formats, logger serializers and streams, ora-style progress

- `--jq` supports string interpolation (`"\(.name) (\(.id))"`), formats applied to interpolated values (`@sh "echo \(.name)"`), and the `@sh` and `@base64d` formats.
- `--jq` adds `range`, `limit`, `first(f)`/`last(f)`, `any`/`all` (with a generator and condition too), `values`/`nulls`/`scalars` and the other type selectors, `recurse` and `..`, `paths`, `paths(f)`, `leaf_paths`, `getpath`, `setpath`, `delpaths`, `tostream`, `with_entries`, `error`, `env` and `$ENV`. Evaluation is lazy, so `first(f)` and `limit` stop early.
- Every `--jq`/`--template` run has a step budget, so a runaway expression like `[range(1e9)]` fails fast with an error. Set it with `padroneJson({ jqLimits: { maxSteps, remoteMaxSteps } })`; serve, MCP and `tool()` calls get a lower default budget and an empty `$ENV`.
- A custom `jq` function gets `{ env }` as a third argument.
- `padroneFormat({ sanitize: true })` strips terminal escape sequences and control characters from yaml, csv, tsv and table values; the table primitive takes `sanitize: true` too.
- `padroneFormat({ csvFormulaEscape: true })` prefixes `'` on csv/tsv cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return, leaving numbers alone.
- `padroneLogger({ serializers })` turns fields and child bindings into what's logged by key, before redaction; errors go through `err`.
- `padroneLogger({ destination: [...] })` writes to several destinations, each `{ destination?, level?, format? }` with its own level and format.
- `ctx.context.progress.stopAndPersist({ symbol, text })` stops the indicator and leaves a final line with a custom symbol, and `prefixText`/`suffixText` (in the config or `update()`) add text around the indicator and its final line.
