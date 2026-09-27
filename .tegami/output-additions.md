---
packages:
  padrone: minor
---

## More jq, table and color options

- `--jq` supports `if … then … elif … else … end`, `. as $x | …` variables, arithmetic (`+ - * / %`, with jq's rules for strings, arrays and objects), `min`/`max`/`min_by`/`max_by`/`group_by`/`unique_by`, `split`, `ltrimstr`/`rtrimstr`, `tojson`/`fromjson`, `test`/`sub`/`gsub` with regex flags, and the `@csv`, `@tsv`, `@json`, `@text`, `@html`, `@uri` and `@base64` formats. `join` follows jq for numbers, booleans and nested values.
- `--jq` prints non-string outputs as compact JSON, one per line, when stdout isn't a terminal, and indented on a terminal, like `gh --jq`.
- `padroneFormat({ columns: { id: 'ID', name: 'Name' } })` sets the default columns and their header labels for table, csv and tsv (or a function for per-command columns).
- `padroneFormat({ pipedTable: 'tsv' })` prints `-o table` as tab-separated rows when stdout isn't a terminal. Tables are still printed as tables by default.
- `padroneFormat({ csvLineEnding: 'crlf' })` ends csv lines with `\r\n` (RFC 4180).
- Table cells with newlines span several lines instead of breaking the table.
- `--color=<theme>` with an unknown theme is an error listing the themes.
- `CI=false` and `CI=0` no longer turn colors off. `CLICOLOR=0` turns them off and `CLICOLOR_FORCE=1` forces them on; `NO_COLOR` and `FORCE_COLOR` take precedence.
- Under JSON output, a routing error's `message` no longer repeats the "Did you mean" hint listed in `suggestions`.
