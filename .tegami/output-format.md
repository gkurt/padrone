---
packages:
  padrone: minor
---

## Output formats and `--json` fields

- New `padroneFormat()` extension: `--output`/`-o <format>` prints results as `text` (default), `json`, `yaml`, `csv`, `tsv` or `table`. `formats`, `default` and `flags` customize it, and `tableFlags: true` adds `--columns a,b`, `--sort [-]column` and `--no-header`. Errors print as JSON under `-o json`.
- `padroneJson({ fields: true })`: `--json=name,url` prints only those fields of the result (or of each item). With `fields: 'required'`, `--json name,url` also works and a bare `--json` fails listing the available fields, like `gh`; `availableFields` declares them up front.
- Table output primitives accept `header: false`.
