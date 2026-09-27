---
packages:
  padrone: minor
---

## Config and env additions

- `--config`/`-c` is listed in help.
- `padroneConfig({ sections: true })`: per-command sections (`{ "serve": { "port": 3000 }, "db": { "migrate": { ... } } }`) override top-level values for that command.
- Config files and environment variables no longer fill the options of built-in commands (`help`, `config`, `serve`, …); `builtins: true` on `padroneConfig()`/`padroneEnv()` opts back in, and `.configure({ builtin: true })` marks your own.
- `padroneEnv({ prefix })` reads nested options with a double underscore (`APP_DB__HOST` → `db.host`), and dotted `vars` keys set nested values.
- Empty environment variables (`APP_PORT=`) now count as unset; `padroneEnv({ allowEmpty: true })` keeps them as empty strings.
- Validation errors about values from env or config name their source: `… (from APP_PORT)`, `… (from config.json)`.
- `--profile` is an unknown option for serve, MCP and `tool()` calls unless `profiles: { remote: true }`.
- `config set`/`config unset` change the value in place, keeping comments and formatting in JSON, JSONC and rc files.
- Numbers and booleans given for another scalar type are coerced like CLI input (YAML `name: 123` for a string option gives `"123"`).
- `config get|set|unset|list|path|edit` take `--local` (the project config file) and `--file <path>`.
