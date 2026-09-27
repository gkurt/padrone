---
packages:
  padrone: minor
---

## Prompts in actions, confirm options and credential storage

- Actions get `ctx.prompt` with `text`, `password`, `confirm`, `select`, `multiselect` and `group` (steps see earlier answers); interceptors get the same with `createPrompt(ctx)`.
- Cancelling a prompt (Ctrl+C, Esc) throws a `PromptCancelledError` (exit code 130), distinct from an empty answer; custom runtimes cancel by returning `PROMPT_CANCEL`, and `isPromptCancel()` checks both.
- Without an interactive terminal or for serve, MCP and `tool()` calls, `ctx.prompt` returns the prompt's `default` or throws a `PromptUnavailableError` instead of waiting.
- `testCli().prompt()` answers `ctx.prompt` questions by name (a group step's key by default).
- `padroneConfirm({ nonInteractive: 'yes' | 'no' })` runs or aborts a command that can't ask instead of failing; `.configure({ confirm })` sets a command's question or turns it off; cancelling the question aborts.
- New `padroneCredentials()` extension: `ctx.context.credentials.get/set/delete` store secrets in the macOS keychain or the Linux Secret Service (secrets passed on stdin), falling back to a `0600` file; serve, MCP and `tool()` calls can't read them unless `remote: true`.
- Interactive field prompts for dotted names (`db.host`) and select defaults of number enums work with the Enquirer prompt.
