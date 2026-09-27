---
packages:
  padrone: patch
---

## Fourth extension sweep: output

- Tables and key-value output line up with wide characters, emoji and colored cells, and truncate without splitting characters.
- Markdown tables use a valid `---` delimiter row and escape `|` in cells.
- Output primitives print dates as ISO strings and bigints as numbers instead of failing, and render empty data as `[]`/`{}` under JSON output.
- `padroneAutoOutput({ output })` streams generator results item by item instead of printing `{}`, and prints non-object results as text under `tree`.
- `-o yaml` prints string results, such as `--help` and `--version`, as text.
- YAML output quotes strings like `.5` and `...` that would read back as a number or a document end.
- `--jq`: string slices count code points, `ascii_downcase`/`ascii_upcase` only change ASCII letters, and comparisons with several outputs follow jq's order.
- `--color` values are case-insensitive (`--color=NEVER`), and `TERM=dumb` turns colors off unless `FORCE_COLOR` is set.
