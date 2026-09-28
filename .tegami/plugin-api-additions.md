---
packages:
  padrone: minor
---

## More plugin and extension safeguards

- `padronePlugins()` ignores manifest entries with option-like specs or control characters in names, refuses `plugins update` for names outside `allow`, re-reads `plugins.json` before writing, and has `onError`.
- `padroneExternalCommands({ allow })` limits which external command names run.
- `version --verbose` is plain for remote callers unless `padroneVersion({ remoteVerbose: true })`.
- Registries are only fetched over HTTPS (or plain HTTP to the local machine).
- The credentials file backend refuses to run without a home directory.
- `open` targets starting with `-` are made relative, and `verifySha256` accepts a bare digest.
- Serve and MCP help no longer list commands that `exclude`, `include`, `expose` or `hidden` withhold.
- jq step limits can't be bypassed with non-finite counts, and object/array operators are counted.
- MCP request ids are scoped to the auth identity when there is no session, and stdio replies with an error when a request fails.
- `stripJsonc` and response files are bounded (no regex backtracking, at most 1000 files per expansion).
- `config set` redacts `sensitive` values, and a new user config file is private (`0600`).
