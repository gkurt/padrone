---
packages:
  padrone: patch
---

## Extension fixes, plus env `prefix` and config search options

- `--help` respects `--no-color` and `--json`: the help was rendered before those flags were read. Under `--json` (or `format: 'json'`), help is printed once as a JSON object instead of a JSON-encoded string.
- Help lists options of any Standard Schema that has a JSON Schema, not only Zod schemas.
- Built-in commands (`help`, `repl`, `completion`, `man`, `mcp`, `serve`) list their options in help, and their boolean options no longer take the next word as a value (`completion --setup bash` now sets up bash). The `help` command takes `-d`/`-f` for `--detail`/`--format`.
- `padroneLogger()` and `padroneTiming()` work when applied to a single command: their flags were rejected as unknown options, and timing measured from process start.
- The stdin extension no longer reads the process's stdin for serve, MCP and `tool()` calls (over MCP's stdio transport, that's where requests arrive). Progress indicators are no-ops and timing isn't printed for those calls.
- `--color` takes `always`, `never` and `auto`, which were taken as theme names.
- `padroneConfig()` imports JS/TS config files by file URL, so absolute Windows paths work in Node.
- `PadroneConfigOptions`, `PadroneEnvOptions`, `PadroneAutoOutputOptions` and `PadroneTimingOptions` are exported from `'padrone'`.
- New `padroneEnv({ prefix: 'MY_APP' })` reads every option from `MY_APP_*` variables (`--dry-run` ← `MY_APP_DRY_RUN`), like yargs' `.env()`. The variables are shown in help.
- New `padroneConfig()` options: `searchParents` also searches parent directories, and `packageJson` reads config from a `package.json` key, like cosmiconfig.
