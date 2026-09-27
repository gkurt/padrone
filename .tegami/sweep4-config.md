---
packages:
  padrone: patch
---

## Fourth extension sweep: config and env

- Serve, MCP and `tool()` calls can no longer pass `--config` / `-c`, which let a request make the program read, or import, any local file. It's now an unknown option for them.
- `config get` and `config unset` take an option's alias or kebab-case name (`dry-run`), like `config set` does.
- `config list` shows the values of `sensitive` options as `[redacted]`.
- `config path` and `config edit` work when `files` has no JSON name, and `config edit` can create a YAML or TOML user config.
- An empty config file, or one with only comments, is an empty config instead of an error.
- Config files saved with a byte order mark are read correctly (YAML and TOML read it as part of the first key).
- `null` in a nested config value unsets that option, as it does at the top level.
- `.env` files: `${VAR:-default}` defaults can contain variables (`${API:-http://${HOST}}`), and multiline values in files with CRLF line endings no longer keep `\r`.
