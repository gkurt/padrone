---
packages:
  padrone: patch
---

## Third extension sweep

MCP, serve and `tool()`:

- MCP rejects malformed messages, batches and unsupported `MCP-Protocol-Version` headers with JSON-RPC errors instead of hanging or answering them; `initialize` accepts `2025-06-18` and `2025-03-26` clients; cancelling a call no longer aborts another client's call with the same id.
- The MCP `help` tool is named `padrone_help` when a command is called `help`, and help for an unknown command is an error.
- Serve returns what a command printed as `output`, documents nested arguments as the dotted query parameters it accepts, allows trailing slashes and `Authorization` in CORS, and works with IPv6 hosts under Node.
- `tool()` reports errors, validation failures and unknown commands in `error`, and its `abortSignal` cancels the command.
- `null` arguments from serve and MCP mean unset; objects written with `runtime.output` come back as JSON; `--repl` is an unknown option for these callers instead of starting a REPL.
- Ink's `remote: 'exit'` stops when the call is aborted and returns render errors as errors.

Prompts, config and env:

- Prompts need a terminal on stdin too: `padroneConfirm()` fails without `--yes` instead of hanging on piped input, and `--no-interactive` makes it fail too.
- Prompt answers for number, array and enum fields are coerced like command-line input instead of re-prompting forever.
- `.env` variables are visible to `ctx.runtime.env()` in the action. Single-quoted `.env` values aren't expanded, chained references expand, and process env wins over `.env` files unless `override`.
- Config files without an extension allow comments and trailing commas; config keys like `toString` are ignored.
- `--jq`/`--template` and `--json=1` print JSON errors after an unknown command; `has`, `tonumber`, `to_entries`, `select` and `length` in `--jq` match jq.

Output and progress:

- `--verbose=false`/`--verbose=0` no longer enable debug logs; `%s` prints objects as JSON; the logger's `prefix` can come from context.
- An action that uses `ctx.context.output` and returns a value prints once; streamed results are closed when printing fails.
- Progress succeeds only once a streamed result is consumed, stops when it's closed early, and `padroneProgress()` uses the context's messages.

Help, completion and aliases:

- `--color` takes a value only with `=` (`--color hello` keeps `hello` as an argument); `--color=off`/`no` disable colors.
- `help <unknown>` suggests similar commands and no longer lists hidden built-ins.
- Dynamic completion works after `--opt=value` in bash, offers no subcommands after `--`, and follows the help flags' names; fish scripts handle backslashes in descriptions; the shell is detected from the runtime's environment.
- `alias set` keeps quoted words together, and `alias set`/`delete` are mutation commands.
- `suggestions: { run: 'prompt' }` only replaces the mistyped command, never an option value spelled the same.

Upgrade and update check:

- `padroneUpgrade()` detects npm installs under Homebrew's Node and pnpm installs run by Bun, refuses `--to`/`--channel` with Homebrew, and validates versions before running the installer.
- The update notice isn't shown right after `upgrade`, and build metadata (`+build`) is ignored when comparing versions.
