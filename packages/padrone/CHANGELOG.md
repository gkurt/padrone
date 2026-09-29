## padrone@3.0.0

### jq interpolation and generators, safer output formats, logger serializers and streams, ora-style progress

- `--jq` supports string interpolation (`"\(.name) (\(.id))"`), formats applied to interpolated values (`@sh "echo \(.name)"`), and the `@sh` and `@base64d` formats.
- `--jq` adds `range`, `limit`, `first(f)`/`last(f)`, `any`/`all` (with a generator and condition too), `values`/`nulls`/`scalars` and the other type selectors, `recurse` and `..`, `paths`, `paths(f)`, `leaf_paths`, `getpath`, `setpath`, `delpaths`, `tostream`, `with_entries`, `error`, `env` and `$ENV`. Evaluation is lazy, so `first(f)` and `limit` stop early.
- Every `--jq`/`--template` run has a step budget, so a runaway expression like `[range(1e9)]` fails fast with an error. Set it with `padroneJson({ jqLimits: { maxSteps, remoteMaxSteps } })`; serve, MCP and `tool()` calls get a lower default budget and an empty `$ENV`.
- A custom `jq` function gets `{ env }` as a third argument.
- `padroneFormat({ sanitize: true })` strips terminal escape sequences and control characters from yaml, csv, tsv and table values; the table primitive takes `sanitize: true` too.
- `padroneFormat({ csvFormulaEscape: true })` prefixes `'` on csv/tsv cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return, leaving numbers alone.
- `padroneLogger({ serializers })` turns fields and child bindings into what's logged by key, before redaction; errors go through `err`.
- `padroneLogger({ destination: [...] })` writes to several destinations, each `{ destination?, level?, format? }` with its own level and format.
- `ctx.context.progress.stopAndPersist({ symbol, text })` stops the indicator and leaves a final line with a custom symbol, and `prefixText`/`suffixText` (in the config or `update()`) add text around the indicator and its final line.

### Schema-aware CLI parsing

- Boolean flags no longer swallow the next argument: `build --verbose file.txt` keeps `file.txt` positional, and `group --verbose sub` still routes to `sub`. Explicit boolean words (`--verbose false`) still work.
- Short flags accept attached values: `-n5`, `-ofile`, `-vn5`.
- Options that need a value take the next argument even when it starts with `-` (`--pattern -foo`), and report `Option "--name" requires a value` when it's missing.
- A repeated non-array option keeps the last value instead of failing validation.
- `--title=[WIP]` stays a string; the bracket array syntax only applies to array options.
- Nested option values are coerced (`--user.id 7` → `7`).
- A lone `-` and negative numbers are positionals, never command names.
- An argv positional equal to the program name is no longer dropped.
- Fixed prototype pollution through option paths like `--__proto__.x=1`.
- Interceptors can declare the options they read from `rawArgs` via `meta.options`, so the parser knows whether each takes a value.
- `eval()` and `parse()` accept an argv array in their types.

### Logs on stderr, `--jq`/`--template`, layered config, task lists, a help pager, dry runs and `version --verbose`

- `padroneLogger()` writes every level to stderr by default, so logs never mix with command output; `stdout: true` sends `trace`, `debug` and `info` to stdout as before. Level labels are colored on color terminals, and `format: 'json'` writes JSON lines (`logger.info({ userId }, 'signed in')` adds fields, errors are written as `err`).
- `padroneJson()` adds `--jq <expression>` (a built-in jq subset, or plug in a full implementation with `jq`) and `--template '{{.name}}'` to filter and format the result.
- Errors print as JSON whenever output is JSON (`--json` or `format: 'json'`), including errors an error interceptor replaced.
- `padroneConfig()` adds `merge: true` to layer every config found (user config directory, then parent directories, then cwd), and follows `extends` keys in config files (disable with `extends: false`).
- `ctx.context.progress.tasks([...])` runs a list of tasks drawn live, like listr2, with subtasks, skips, concurrency and `exitOnError`. `taskRenderer` replaces the drawing.
- `--version` works on subcommands (single-character flags stay root-only), and `version --verbose` shows the runtime, platform, architecture and shell. `padroneVersion({ info })` adds fields.
- `builtins: { help: { pager: true } }` shows help taller than the terminal through a pager, like git: `$PAGER`, or `less -FRX`. Only in `cli()` on a terminal; `--no-pager` prints the help directly and `--pager` pages it even when it fits. The runtime's `terminal` gains `rows`.
- New `.dryRun(handler)` builder method: the command accepts `--dry-run` / `-n`, and under that flag the handler runs instead of the action (after validation) and its return value is printed. Only commands with a dry-run handler accept the flag or show it in help, so it's never silently ignored. Returning the action's type keeps the result type; a different type extends it to a union. Interceptors see `ctx.dryRun`, `padroneConfirm()` skips its prompt, `tool()` needs no approval, and MCP/serve take a `dryRun` argument.
- `--no-color` and `--color=…` apply to errors from failed parsing too.
- `padroneTracing()` records errors thrown while parsing in a root span.
- `padroneInk()` returns the first frame as text for serve, MCP and `tool()` calls instead of mounting the app.

### Fourth extension sweep: input and prompts

- `suggestions: { run: 'prompt' }` and help's `pickSubcommand` no longer ask with `--no-interactive`.
- "Did you mean" hints no longer suggest hidden options.
- An alias run with fewer words than its `$N` placeholders take fails (`Alias "pr" needs 1 argument`) instead of passing `$1` on literally.
- Interactive prompting skips object fields (and arrays of objects), which a text answer can't fill, instead of re-prompting forever.
- An empty answer to an optional field's prompt leaves it unset, so its default applies, instead of failing validation (e.g. for numbers) and re-prompting.

### Logger, task list, signal and timing additions

- `padroneLogger({ redact })` censors paths in logged objects, pino-style (`['user.password', '*.token']`, or `{ paths, censor }`).
- `padroneLogger({ destination })` writes log lines to a file path, a function or a `{ write }` stream instead of stderr.
- `logger.child({ requestId })` adds bindings to every line it writes, in text (`requestId=…`) and JSON formats.
- Log colors follow whether stderr is a terminal (the new `runtime.terminal.stderrIsTTY`), not stdout; with `stdout: true`, lines sent to stdout follow stdout.
- Tasks take `retry: n` (or `{ tries, delay }`) and a `rollback` handler run once a task has failed for good; `t.retry` tells which attempt is running.
- `tasks(list, { rendererOptions: { collapseSubtasks: true } })` hides the subtasks of finished tasks. Without a TTY or in CI, task lists now print start and finish lines (`createSimpleTaskList`, also usable as `taskRenderer`).
- `ctx.context.progress.isActive` and `isPaused` report the indicator's state.
- `padroneSignalHandling({ forceExitMs, onForceExit })` (or `builtins: { signal: { … } }`) sets the double Ctrl+C window and runs a cleanup hook before a force exit.
- `padroneTiming({ format })` customizes the timing line, which now reads `Failed after …` when the command fails.
- `padroneTiming()` registered on a command prints after the error message, like on the root: a failed command's shutdown handlers now run after the root error handlers.
- `runtime.open()` on Windows quotes targets with spaces and escapes cmd metacharacters.
- Interactive prompts are no longer disabled when `CI=false` or `CI=0`.

### Fourth extension sweep: logging, progress and lifecycle

- `upgrade --check` no longer asks for confirmation under `padroneConfirm()`, and `upgrade --check --dry-run` reports the check.
- `padroneUpgrade()` detects yarn global installs on Windows.
- JSON log lines keep their own `time` and `level`, and a message argument wins over a `msg` field.
- Shutdown interceptors (signal cleanup, timing, progress) still run when an error interceptor throws; the thrown error becomes the result's error.
- `padroneTiming()` rounds before choosing the unit, so it no longer prints `1000ms` or `60.00s`.
- `padroneUpdateCheck()` treats `CI=false` and `CI=0` as not CI, and only checks when the program has a `version`, instead of comparing against the working directory's `package.json` or `npm_package_version`.
- Progress spinners, bars and task lists don't animate in CI or with `TERM=dumb`; they print final lines only.
- Output written while `progress.pause()` is in effect no longer redraws the indicator before `resume()`.

### Config, env, response file and alias additions

- A script config can export a function (sync or async) that gets `{ command, env, envName, profile }`; `defineConfig()` from `'padrone'` types it.
- `searchParents: 'project'` stops the parent search at the nearest directory with `.git` or `package.json`, and `stopDir` sets the last directory to search.
- `$production: { ... }` and `$env: { staging: { ... } }` in a config override its values for the active environment (`envName`, `NODE_ENV` by default); `$` keys are never option values.
- `padroneEnv()` splits variables for array options on commas (`APP_TAGS=a,b`; `arraySeparator` changes it, `[...]` reads JSON), and `nestedSeparator` replaces the `__` in nested variable names.
- `.env` files support `${VAR:+alt}`, `${VAR+alt}`, `${VAR:?message}` and `${VAR?message}`; a missing required variable is an error naming the file.
- `padroneResponseFiles({ relativeTo: 'file' })` resolves nested response files beside the file that names them.
- `alias import <file|->` adds aliases from YAML or JSON (`--clobber` overwrites existing ones), `alias export [file]` writes them, and `alias list` now prints YAML that imports back.

### Variadic options

`variadic: true` on an array option takes every following value up to the next option: `--tags a b c`. Positionals after it need `--`, and `--tags=a` still takes a single value.

### Plugin and security hardening

- `padroneUpgrade()` runs the installer without a shell on Windows and checks the package name.
- `padroneUpgrade()` has `--rollback`, and `verifySignature()` checks Ed25519 or ECDSA release signatures.
- `padronePlugins()` ignores unsafe `plugins.json` names, writes it privately and atomically, and pins each plugin's version and file hash.
- `padronePlugins()` has `allow`, `apiVersion` (plugins declare `padroneApi`), `override`, `ignoreScripts`, `plugins update`, `plugins info` and `plugins list --json`.
- `padroneConfig({ scripts })` refuses or vets script configs, which run code.
- `padroneExternalCommands({ env })` limits the variables external commands inherit.
- `padroneCredentials` has `list()`, and the file backend handles a `__proto__` service safely.
- `padroneUpdateCheck({ channel })` follows a dist-tag with its own cache.
- Aliases, the update cache and credentials are written atomically.

### Remote caller improvements

- `.configure({ needsApproval })` is typed: a boolean, or a function of the command's validated args.
- New `.configure({ outputSchema })`: advertised as the MCP tool's `outputSchema` and documented as the OpenAPI `result`.
- MCP returns object results as `structuredContent` as well as text.
- The MCP HTTP server rejects requests from origins other than loopback ones or the `cors` origin (403), guarding against DNS rebinding.
- Ending an MCP session with `DELETE` aborts its tool calls in flight.
- Serve responses include what the command wrote to stderr, as `stderr`.
- Serve rejects `sensitive` fields in GET query strings and leaves them out of the OpenAPI GET parameters.
- Tracing names spans `<caller> <command>` (such as `serve deploy`), uses a server span kind for serve and MCP, and sets the span status message from the error.

### Fifth sweep: security hardening and plugin fixes

- Serve and MCP no longer expose built-in commands (`config`, `alias`, `upgrade`, …), and `config`, `alias`, `completion`, `man`, `serve`, `mcp` and `upgrade` refuse serve, MCP and `tool()` calls.
- Serve rejects requests from other websites like MCP does: an `Origin` that isn't loopback, the server's own host or the `cors` origin gets 403.
- Serve and MCP bound to a loopback host reject a non-loopback `Host` header (DNS rebinding).
- New `maxBodySize` option for serve and MCP over HTTP (default 4 MiB); larger request bodies get 413.
- Serve rejects GET query values for whole objects or arrays that hold a `sensitive` field, and leaves them out of the OpenAPI GET parameters.
- A JSON, YAML or TOML config (or a `package.json` key) can no longer `extends` a script config.
- The REPL history file is created readable only by the user, and `historySize: 0` keeps no history.
- `runtime.editor()` and `padrone link` shims quote file paths for the shell; static completion scripts quote enum values.
- `padrone init` writes names and descriptions with quotes as valid JSON and TypeScript.
- Update checks ignore registry and cached values that aren't versions, and check again when the last check is in the future.
- Inside the REPL (`--repl` or the `repl` command), Ctrl+C interrupts the running command instead of the session; a Ctrl+C after a caller's `signal` aborted the run stops it instead of force-exiting.
- A throwing command-level shutdown handler no longer skips the root's shutdown handlers.
- Events and `getRootCommand()` work from the subcommands of mounted programs.
- Nested sensitive keys (`db.password`) get masked prompts, and under `-i` a blank answer to a masked prompt keeps the given value.
- Validation errors about nested config and env values name the right source.
- `.env` files: an unclosed quote is read as an unquoted value, a tab before `#` starts a comment, `$toString`-style names don't expand, and trailing whitespace on a multiline value's first line is kept.
- A runtime `stdin` with `isTTY: true` isn't read for `stdin` fields, and a `fromFile` `-` no longer conflicts with a `stdin` field that wouldn't read.
- `--jq`: `from_entries` follows jq 1.7.1, fractional slice bounds round like jq, strings sort by code point, and `__proto__` keys are kept in constructed objects.
- Logger `redact` also censors class instances.
- Progress spinners, bars and task lists redraw multi-line and wide-character text correctly.
- Man pages escape lines that would start with `.`.

### Extension fixes, plus env `prefix` and config search options

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

### Help topics, interceptor callers and custom events

- `builtins: { help: { topics: { environment: { title, description, content } } } }` (or `padroneHelp({ topics })`) adds help topics: `app help environment` prints the topic (through the pager when it's on; `{ topic, title, content }` under JSON output). The program's help lists them under "Additional help topics", `help <typo>` suggests them, completion offers them after `help`, and Markdown docs get a page per topic. A command of the same name wins.
- Interceptor meta `callers` runs an interceptor only for the listed callers (`LOCAL_CALLERS` and `REMOTE_CALLERS` are exported).
- Custom events between extensions: `defineEvent<T>(id)`, handled with `interceptor.on(event, handler)` and emitted with `ctx.emit(event, payload)` from actions and interceptors (or `program.emit()` outside an execution). Handlers run in interceptor order, and `emit()` resolves once they have.
- Function options in `createPadrone(name, { builtins })` are now contextually typed.

### Fix typing and context gaps found writing a third sample program

- Aliased subcommands inside a `defineCommand()` group keep their names, so `eval()`, `parse()` and `testCli()` still infer the command instead of `never`
- `run()` rejects a command name it doesn't know (`run('lsit', {})`); a `string` variable is still accepted
- `tool()`, `serve()` and `mcp()` take a `context`, required when the program declares one; the `serve` and `mcp` commands pass on the context given to `cli()`
- `defineInterceptor({ name }).on(event, handler)` defines an interceptor that only handles an event
- `Option "-l" requires a value` is no longer prefixed with the option's name
- A program's `.context(transform)` no longer changes the context callers pass: after `.context<{ url: string }>().context((ctx) => ({ db: connect(ctx.url) }))`, `cli()`/`eval()`/`run()` take `{ url }` and commands get `{ db }`; later transforms get the previous one's output
- Commands that require no args take none, `undefined` or `{}` in `run()` and `api()` (`program.run('status')`, `api.status()`), and serve accepts a `null` body for them
- Commands without arguments type their `args` (in actions, hooks and `result.args`) as `{}`, matching what they receive, instead of `void`

### Remote access controls for serve, MCP and tool()

- `.configure({ expose })` says which callers may run a command and its subcommands: `false` for local callers only, or a list such as `['cli', 'mcp']`. Servers don't list a command they can't run, and running it from another caller fails. Built-in commands (`config`, `alias`, `plugins`, `upgrade`, …) are local only; `help` and `version` stay available.
- `serve()` and `mcp()` take `include` / `exclude` (command paths, globs like `'db.**'`, or a predicate) to offer only some commands.
- `auth` (a function of the `Request`) and `bearer` (tokens) authenticate requests to `serve()` and MCP over HTTP; refused ones get 401. Actions, hooks and interceptors read the identity as `ctx.auth`, which `eval()` and `cli()` also take as `auth`.
- `allowedHosts` lists the `Host` names a server answers, protecting non-loopback bindings from DNS rebinding too; `true` turns the check off.
- `timeout` aborts a command that runs too long (serve: 504; MCP: a JSON-RPC error), and `maxConcurrent` refuses requests over a limit (serve: 503). `tool({ timeout })` works the same way.
- MCP HTTP sessions can expire after `sessionTtl` ms without requests, and `maxSessions` (1000 by default) drops the least recently used one.
- `serve()` and `mcp()` log the port they actually listen on, so `port: 0` works.
- With `auth` or `bearer`, an MCP session only answers the identity that created it.

### Option values from files, and response files

- `fromFile: true` field meta: a command-line value `@path` reads the file, `-` reads stdin, and `@@text` passes `@text`. Values from env, config files and serve/MCP/`tool()` calls are taken as given. Help marks such options `(@file or - for stdin)`.
- `padroneResponseFiles()` expands `@file` arguments into the arguments listed in the file (one or more per line, `#` comments, nested files), in `cli()`, `eval()` and the REPL. A missing file is an error; `@@` escapes a leading `@`.

### Global args for commands in their own files

- Commands added with `defineCommand()` and mounted programs take the program's global args in `run()`, `api()` and `InferArgsOutput`, as inline commands already did.
- `defineCommand<Context, typeof globals>()` types the global args inside the command. Its result can be reused for every command.

### Help and suggestions

- `--help` lists the options of `padroneFormat()` (`-o`), `padroneJson()` (`--json`, `--jq`, `--template`), `padroneLogger()` and `padroneTiming()`, leaving out short flags a command's own options use.
- A command group's help ends with the `Run "... --help"` hint instead of showing it before the options.
- Options and positionals without a description leave no trailing spaces in help.
- A mistyped command suggests each command once: `Did you mean "list"?`, not `"list" or "ls"`.

### Clearer help and errors

- Help shows `<value>` for options that take a value and `[value]` only where it can be left out (`--json [fields]`), marks required options `(required)`, and shows `boolean | string` options as `[string]`.
- Unknown options read `Unknown option "--limt". Did you mean "--limit"?`, without the `limt:` in front.
- Text tables no longer end lines in blanks.

### Config and env

- Config files apply per-command sections by default (`sections: 'auto'`): `{ "list": { "limit": 1 } }` sets `--limit` for `list`, unless the running command has an option named `list`. `sections: false` restores the old behavior.
- `padroneEnv({ prefix: 'APP', scope: 'command' })` reads a subcommand's own options from `APP_<COMMAND>_<OPTION>` (`APP_LIST_LIMIT`), so commands don't share variables. Global options keep `APP_<OPTION>`.

### Typing

- `conflicts`, `implies`, `requires`, `requiredIf` and `requiredUnless` in `.arguments()` fields only accept the command's options and global options.
- `testCli(program).run(input)` types `result`, `args` and `command` by the command the input names, and `.context()` by the program's context.

### Fourth extension sweep: help, REPL and completion

- Shell completion keeps offering a variadic option's values after its first one (`--files a.ts <TAB>`).
- `help db <TAB>` completes the subcommands of `db`, not only the first word after `help`.
- Without a subcommand, completion offers the options of a default (`''`) command, which such options run.
- `.scope db migrate` in the REPL scopes into the nested command instead of failing, and `.scope` reports the full path it couldn't use.
- REPL tab completion offers global options and the help flags the program has (`padroneHelp({ flags })`) instead of always `--help`/`-h`, and no longer offers an empty alias.
- Help, generated docs and man pages leave out empty defaults (`[]`, `''`) of positionals too; man pages no longer show a `boolean` placeholder after flags; Markdown command tables keep descriptions with `|` or line breaks in one row.

### Completion descriptions, value hints and value names

- Dynamic completion shows descriptions for subcommands, options, literal union values and `complete` items, which may now be `{ value, description }` (zsh, fish and PowerShell; bash shows values). The scripts call `<program> __complete2`, which prints `value<TAB>description` lines and a directive; `__complete` still prints values only, so regenerate scripts installed from an earlier version to get the new behavior.
- New field meta `hint` (`'file'`, `'dir'`, `{ ext: ['json'] }`, `'command'`, `'url'`, `'none'`) sets what completion offers for a value when no candidate matches, in dynamic and static scripts. Values with enum values or `complete` no longer fall back to file names unless hinted.
- New field meta `valueName` sets the value placeholder in help, docs and man pages: `--out <DIR>`, and `<DIR>` for a positional.
- Static zsh and fish scripts now know which options take a value.

### Config and env additions

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

### Global args in prompts, completions and docs

- A command with `interactive: true` also prompts for missing required global args, and `.globalArgs(schema, { interactive })` prompts for them in every command of the subtree.
- Shell completions include global options; man pages and generated docs list them under "Global Options".
- Commands under async global args are typed as async.

### Extension fixes and additions

- `cli()` prints errors from every phase: errors thrown in a `route` interceptor, by a config file or by a validate interceptor were silent. An error is printed once even when auto-output is applied to the command too.
- `padroneUpdateCheck()` shows its notice (it never did), including after sync commands. The check only runs in `cli()`, is skipped with `--no-update-check` or `NO_UPDATE_NOTIFIER`, and times out after 3 seconds. A release now counts as newer than its own pre-releases. New `updateCommand` option customizes the suggested command.
- `padroneConfig()`: a missing `--config` file or an unparsable config file is a `ConfigError` instead of being ignored. JSON config files load outside Bun, with comments and trailing commas allowed.
- `--no-color` and `--color=false` disable colors, and `--color` forces them; they only changed the theme before. `FORCE_COLOR` is honored.
- `padroneLogger()` prints errors with their stack instead of `{}`, and no longer throws on bigints or circular objects. New `env` option reads the level from an environment variable.
- `padroneTracing()` works with `run()`, names spans by the full command path, and adds `padrone.command` and `padrone.caller` attributes.
- A command's own `--repl` option is no longer taken over by the REPL flag, and `--repl` after positional values scopes to the command.
- A stdin field given as a positional argument is no longer reported as ambiguous when stdin is piped.
- `<cmd> help` shows the command's help for commands without positionals, and no longer swallows a `help` value of a positional argument.
- `padroneEnv()` loads `.env` files when any file option (`dir`, `local`, `base`, `override`) is set, not only `modes`.
- `cli({ runtime: { argv } })` reads `argv` from the given runtime.
- New `signal` preference for `eval()`, `cli()` and `run()` cancels a run through `ctx.signal`.
- `markErrorReported()` is exported for extensions that print errors themselves.

### Stricter CLI defaults

- Extra positional arguments are an error (`Too many arguments`) instead of being joined into the last positional with spaces. Positionals passed to a command that declares none are reported instead of silently dropped. Use a variadic (`...rest`) to accept any number.
- Numbers are only coerced from decimal notation; `0x10`, `Infinity` and whitespace-padded values are rejected.
- Routing and validation errors print to stderr followed by `Run "app build --help" for usage.` instead of the full help. Opt back in with `createPadrone(name, { builtins: { help: { showHelpOnError: true } } })` or `padroneHelp({ showHelpOnError: true })`.
- "Available commands" after an unknown command now goes to stderr.
- Using a deprecated option or command from `cli()` or the REPL prints a warning to stderr.
- `padroneLogger()` no longer consumes `--verbose`, `--quiet` and the other level flags when the command defines an option with that name.
- Validation issues without a path no longer print a `root:` prefix.

### Lifecycle hooks, command-not-found handling, external commands and runtime plugins

- `.hook('preAction' | 'postAction', handler)` runs code around the action of a command and all its subcommands, with typed args and context.
- New `commandNotFound` event: a handler can run something in place of an unknown command (`event.handle()`) or route another input (`event.reroute()`); otherwise the usual error and suggestions follow.
- New `padroneExternalCommands()` extension: `my-cli foo` runs `my-cli-foo` from `PATH`, with its exit code; external commands show in help and completion.
- New `padronePlugins()` extension: plugins users install at runtime, loaded at startup, with `plugins list|install|uninstall|link`.
- Interceptors can list commands they handle in help and completion with the `extraCommands` meta.

### Progress indicator fixes

- `padroneProgress()` no longer crashes with `run()`; the indicator starts right before the action.
- A final message is printed once: calling `succeed()`, `fail()` or `stop()` yourself is no longer followed by a second auto-managed message.
- When stderr is not a TTY, the final message uses the latest `update()` message instead of the initial one.
- Elapsed time and ETA keep counting when the spinner and bar are disabled.
- A spinner keeps its configured speed when shown next to a bar.
- Very narrow bars (`width` under 3) no longer throw.
- `pause()` no longer writes escape codes to stdout, which corrupted piped output.
- ETA estimation restarts when progress moves backwards.
- An indicator is stopped when a `success`/`error` message callback throws.

### Output formats and `--json` fields

- New `padroneFormat()` extension: `--output`/`-o <format>` prints results as `text` (default), `json`, `yaml`, `csv`, `tsv` or `table`. `formats`, `default` and `flags` customize it, and `tableFlags: true` adds `--columns a,b`, `--sort [-]column` and `--no-header`. Errors print as JSON under `-o json`.
- `padroneJson({ fields: true })`: `--json=name,url` prints only those fields of the result (or of each item). With `fields: 'required'`, `--json name,url` also works and a bare `--json` fails listing the available fields, like `gh`; `availableFields` declares them up front.
- Table output primitives accept `header: false`.

### Completion, wrap, upgrade, update-check and man options

- `.configure({ complete })` completes a command's positionals in one place, like cobra's `ValidArgsFunction`: it gets the word's `position`, `field` and the `positionals` before it. A positional field's own `complete` still wins.
- `complete` callbacks also get the `field`, the `runtime` and the `context`, and may return `{ values, directive }` to set the fallback (`'files'`, `'dirs'`, `'ext:json'`, `'commands'`, `'nofiles'`).
- `padroneCompletion({ mode: 'static' })` or `completion <shell> --static` prints the static script; `descriptions: false` or `--no-descriptions` leaves descriptions out. `--setup` keeps these flags and writes under the runtime's `HOME`. `program.completion(shell, { mode, descriptions })` takes them too.
- `.wrap({ separator: '--' })` puts positionals after `--`, and `flagStyle: 'equals'` passes `--key=value`.
- `padroneUpgrade({ verify })` checks a release before installing it; resolving `false` refuses the upgrade. New `verifySha256(data, expected, fileName?)` checks a download against a digest or a `SHA256SUMS` file in a custom installer.
- `padroneUpdateCheck({ shouldNotify, format })` suppresses or rewords the update notice (`format` also applies to `version --check`).
- `padroneMan({ section, dir })` sets the man section and where `man --setup` installs; `generateDocs` takes `section`. `man --setup` now reads `XDG_DATA_HOME` and `HOME` from the runtime env, and `"` in `.TH` arguments is escaped.

### Fix schema inheritance and invalid env values

- `.arguments((parent) => parent.extend({...}))` now receives the parent command's schema; it used to receive `undefined` and throw. Passing `meta` (e.g. `positional`) alongside it no longer breaks type inference.
- `padroneEnv()` reports a set but invalid variable as a validation error instead of silently ignoring every env value.

### Prompts in actions, confirm options and credential storage

- Actions get `ctx.prompt` with `text`, `password`, `confirm`, `select`, `multiselect` and `group` (steps see earlier answers); interceptors get the same with `createPrompt(ctx)`.
- Cancelling a prompt (Ctrl+C, Esc) throws a `PromptCancelledError` (exit code 130), distinct from an empty answer; custom runtimes cancel by returning `PROMPT_CANCEL`, and `isPromptCancel()` checks both.
- Without an interactive terminal or for serve, MCP and `tool()` calls, `ctx.prompt` returns the prompt's `default` or throws a `PromptUnavailableError` instead of waiting.
- `testCli().prompt()` answers `ctx.prompt` questions by name (a group step's key by default).
- `padroneConfirm({ nonInteractive: 'yes' | 'no' })` runs or aborts a command that can't ask instead of failing; `.configure({ confirm })` sets a command's question or turns it off; cancelling the question aborts.
- New `padroneCredentials()` extension: `ctx.context.credentials.get/set/delete` store secrets in the macOS keychain or the Linux Secret Service (secrets passed on stdin), falling back to a `0600` file; serve, MCP and `tool()` calls can't read them unless `remote: true`.
- Interactive field prompts for dotted names (`db.host`) and select defaults of number enums work with the Enquirer prompt.

### REPL: `exit` and `quit`, and tab completion like shell completion

- Plain `exit` and `quit` leave the REPL, like `.exit`, unless the program or current scope has a command with that name.
- REPL tab completion offers options as help shows them (`--dry-run`, not `--dryRun`), never hidden ones, and deprecated commands and options only when nothing else matches what's typed.

### JSON values for object options, non-mutating interceptor chaining, same-id interceptors across layers

- Object, record and array-of-object options take JSON on the command line (`--db '{"host":"x"}'`, `--items '[{"name":"a"}]'`, or one `--items '{"name":"a"}'` per item), alongside dotted keys, which merge with it (the later value wins). Invalid JSON is reported as a validation issue. JSON from env variables and `fromFile` files (`--db @db.json`) is parsed too.
- Serve, MCP and `stringify()` pass objects that dotted keys can't express (record keys with dots, arrays inside, empty objects) and arrays of objects as JSON, so they reach the command intact. `stringify()` quotes values with quotes in them.
- `OptionArity` has a new `'json'` value for these options.
- `.on()` and `.requires()` on an interceptor return a new interceptor instead of changing the one they're called on, so a handler added to a shared interceptor no longer leaks into other programs.
- A command-level interceptor with the same `id` as a root one now replaces it in the error and shutdown phases too, instead of both running.

### Completion, REPL, help search and man page improvements

- Shell completion offers short flags (`-v`) when the word is `-` or `-v`, and only the kebab-case name of camelCase options (`--dry-run`, not `--dryRun`), as help shows them.
- Completion hides deprecated commands and options; they still complete when nothing else matches what's typed. Static scripts leave out hidden and deprecated ones.
- The bash scripts no longer glob-expand candidates like `src/*`.
- The PowerShell script works on Windows PowerShell 5.1, which dropped the empty word being completed.
- `completion <shell> --instructions` prints how to install the script, for the named shell or the detected one; the instructions above a detected shell's script are now comments, so evaluating the output only loads the script.
- REPL: `historyFile` keeps history between sessions (`true` stores it in `program.dirs.state`), capped by `historySize` (default 1000). Initial `history` entries now come up in the right order.
- REPL: a mistyped `.scope` gets "Did you mean", and `help <command>` inside a scope shows help for the scope's commands.
- `help --search <term>` (`-s`) lists commands and help topics matching every word of the term.
- Man pages put the date and `<program> <version>` in `.TH` (the date from `generateDocs`'s new `date` option, `SOURCE_DATE_EPOCH`, or today) and link the parent and subcommand pages under SEE ALSO.

### Self-update, aliases, and more prompts

- `padroneUpgrade()` adds an `upgrade` command that installs the latest version with the package manager the program was installed with (npm, bun, pnpm, yarn or Homebrew, detected). `--check` only reports, `--to <version>` installs a given version, `--channel next` follows another dist-tag, and `--dry-run` shows the command. A custom `installer` can perform the upgrade itself.
- `padroneAliases()` expands command aliases before routing. The program can define some (`aliases: { co: 'checkout' }`), and people add their own with `alias set pr "checkout pr/$1"`, `alias list` and `alias delete`, kept in the program's config directory.
- `builtins: { suggestions: { run: 'prompt' } }` asks whether to run the closest command after an unknown one.
- `builtins: { help: { pickSubcommand: true } }` asks which subcommand to run when a group command runs without one.
- `ctx.runtime.editor(text)` opens the user's editor and returns what they saved, `ctx.runtime.open(url)` opens a URL or file with the default app, and `ctx.runtime.page(text)` shows long output through a pager. All three can be replaced in the runtime.
- `program.dirs` gives the program's standard `config`, `cache`, `data`, `state` and `log` directories for each platform (XDG on Linux); `getProgramDirs()` computes them for any name.
- `.arguments(schema, { exactlyOne: ['file', 'url'], atLeastOne: ['email', 'slack'] })` requires exactly one, or at least one, of a group of options (several groups as an array of arrays; also on `.globalArgs()`).
- `.requires<T>('padrone:logger')` (or `requires` in interceptor meta) checks at runtime that the named interceptors are registered, and fails with an error naming a missing one.
- Pre-release versions are ordered correctly (`beta.10` after `beta.2`, `alpha` before `beta`) in update checks.
- Interceptor meta `async` is kept by `defineInterceptor(meta, factory)`, so config and env loading no longer print the "not marked as async" warning.

### More plugin and extension safeguards

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

### Config profiles and a `config` command

- `padroneConfig({ profiles: true })`: a config's `profiles.<name>` values override its top-level ones when selected with `--profile <name>`, the `<PROGRAM>_PROFILE` environment variable, or a top-level `profile` key. An unknown profile fails with the available ones. `{ flag, env }` renames the flag and the variable. Help lists `--profile`.
- `padroneConfig({ command: true })` adds `config get|set|unset|list|path|edit` for the user config file, like `git config`. `set` checks the key against the program's options and coerces and validates the value; only JSON files are written. `list` shows where each value comes from, and `edit` saves only a config that still parses.
- Interceptors can list their options in help with `meta.helpOptions`.

### Input improvements: aliases, response files, prompts, stdin and confirm

- "Did you mean" for an unknown command also suggests `padroneAliases()` names, and unknown options are matched against options extensions declare (`--json`, `--yes`, `--interactive`, …), leaving out help's own options. A default command's empty name is never suggested.
- Aliases take a `$@` placeholder for the words no `$N` takes (without `$@` they're still appended), and `@file` words in an alias expand as response files.
- `alias set co checkout --force` works without quotes: every word after the name is the expansion.
- With `padroneResponseFiles()`, the value of a `fromFile` option (`--body @notes.md`) is read by `fromFile` instead of expanded as a response file, so `--body @@x` now passes `@x`.
- Interactive prompts ask object fields key by key (`db.host`, `db.port`), and ask again after a blank answer to a required field.
- `stdin: { field, trim: true }` trims piped text; number and boolean stdin fields are always trimmed (`echo 21 | my-cli double`), and a lone `-` value reads stdin (`my-cli cat -`).
- `padroneConfirm()` runs without asking when `<PROGRAM>_YES` is set (e.g. `MY_CLI_YES=1`); `env` renames the variable, `env: false` turns it off.

### More jq, table and color options

- `--jq` supports `if … then … elif … else … end`, `. as $x | …` variables, arithmetic (`+ - * / %`, with jq's rules for strings, arrays and objects), `min`/`max`/`min_by`/`max_by`/`group_by`/`unique_by`, `split`, `ltrimstr`/`rtrimstr`, `tojson`/`fromjson`, `test`/`sub`/`gsub` with regex flags, and the `@csv`, `@tsv`, `@json`, `@text`, `@html`, `@uri` and `@base64` formats. `join` follows jq for numbers, booleans and nested values.
- `--jq` prints non-string outputs as compact JSON, one per line, when stdout isn't a terminal, and indented on a terminal, like `gh --jq`.
- `padroneFormat({ columns: { id: 'ID', name: 'Name' } })` sets the default columns and their header labels for table, csv and tsv (or a function for per-command columns).
- `padroneFormat({ pipedTable: 'tsv' })` prints `-o table` as tab-separated rows when stdout isn't a terminal. Tables are still printed as tables by default.
- `padroneFormat({ csvLineEnding: 'crlf' })` ends csv lines with `\r\n` (RFC 4180).
- Table cells with newlines span several lines instead of breaking the table.
- `--color=<theme>` with an unknown theme is an error listing the themes.
- `CI=false` and `CI=0` no longer turn colors off. `CLICOLOR=0` turns them off and `CLICOLOR_FORCE=1` forces them on; `NO_COLOR` and `FORCE_COLOR` take precedence.
- Under JSON output, a routing error's `message` no longer repeats the "Did you mean" hint listed in `suggestions`.

### Third extension sweep

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

### Env variables in help

`padroneEnv({ vars: { port: 'APP_PORT' } })` maps args to environment variables without a schema. Values are coerced by the command's schema, and each option's variables are shown in help as `Env: APP_PORT`. Interceptors can declare the variables they read via `meta.env`.

### `drain()` fixes

- `drain()` is cached: draining a result twice gives the same answer, even for an iterator result with auto-output turned off.
- A plain result returned by a start interceptor now has `drain()`.
- `cli()` sets the exit code for an error that surfaces while draining only once.

### REPL context, prompt, test context and table fixes

- The `repl` command and `--repl` now pass the context given to `cli()` to every command in the session. `repl()` takes a `context` option.
- `testCli(program).context(value)` sets the context for `.run()` and `.repl()`, so programs that declare one can be tested.
- Bordered tables (`output: 'table'`, `ctx.context.output.table()`) line up in color terminals, and the divider is as wide as the rows.
- Interactive prompts coerce typed answers like CLI input, so number fields (`z.number()`) accept `42` instead of re-prompting forever.

### Dependent and sensitive options

- `requires: ['password']`, `requiredIf: { format: 'file' }` and `requiredUnless: ['user', 'key']` field meta make an option required depending on the others. They work in `.globalArgs()` too, are shown in help, and a missing option covered by `interactive` is prompted.
- `sensitive: true` marks a secret: it's prompted without echo, its default and examples are left out of help, and MCP/serve input schemas mark it `writeOnly`.
- `redactArgs(command, args)` returns args with sensitive values replaced by `'[redacted]'`, for extensions that log them.

### Implied values with interactive prompting

- An option that both implies and conflicts with another (`implies: { color: false }`, `conflicts: 'color'`) no longer fails on its own in commands with interactive prompting.

### Fourth extension sweep: output

- Tables and key-value output line up with wide characters, emoji and colored cells, and truncate without splitting characters.
- Markdown tables use a valid `---` delimiter row and escape `|` in cells.
- Output primitives print dates as ISO strings and bigints as numbers instead of failing, and render empty data as `[]`/`{}` under JSON output.
- `padroneAutoOutput({ output })` streams generator results item by item instead of printing `{}`, and prints non-object results as text under `tree`.
- `-o yaml` prints string results, such as `--help` and `--version`, as text.
- YAML output quotes strings like `.5` and `...` that would read back as a number or a document end.
- `--jq`: string slices count code points, `ascii_downcase`/`ascii_upcase` only change ASCII letters, and comparisons with several outputs follow jq's order.
- `--color` values are case-insensitive (`--color=NEVER`), and `TERM=dumb` turns colors off unless `FORCE_COLOR` is set.

### Extension fixes

- MCP and serve pass arguments intact: values with spaces or quotes, arrays, nested objects and booleans with a custom `negative` keyword. MCP no longer returns a command's output twice, and `tool()` no longer repeats the result in `logs`.
- MCP: the root command's tool is named after the program instead of `""`, each HTTP client gets its own session, `/mcp?x=1` matches the endpoint, and notifications get no response.
- Serve: `basePath` works without a trailing slash, and paths outside it are 404s. Bad input (e.g. an extra positional) is a 400 `bad_request` instead of a 404, validation errors go through `onError` with a `message`, an empty POST body means no arguments, and a throwing `onRequest` or `onError` gives a 500 instead of a hung request.
- `--yes=false`, `--json=false`, `--help=false`, `--no-repl` and similar are off, not on.
- A config file only fills options the command has (by name, alias or kebab-case key), so a program-wide config no longer breaks other commands. `null` means unset, nested objects merge under CLI values, and a positional typed on the command line wins over config and env. Config values are applied before interactive prompts. `.env` variables that aren't options are no longer rejected as unknown, and are visible to `runtime.env()`.
- Config and env loading no longer print a "not marked as async" warning.
- Auto-output prints a returned `Set`, `Map` or `Uint8Array` as one value instead of item by item, and `--jq` applies to commands with a declarative `output` format.
- Signals: the abort `reason` is a `SignalError`, so `ctx.signal.throwIfAborted()` exits 130/143. A repeated SIGTERM or SIGHUP force-exits.
- Progress: shutdown interceptors registered after it run again, the spinner hides during `padroneConfirm` prompts, a streamed result succeeds or fails when it's consumed, `--dry-run` shows no success message, and a task whose `skip()` throws is marked failed.
- `--log-level` accepts any case and rejects unknown levels.
- Empty piped stdin leaves an array field to its default.
- `padroneUpdateCheck()` works on a command, and a failed check is cached so offline machines don't wait every run.
- `padroneTracing()` marks validation failures on the span and records the failing phase.
- `padroneInk()` keeps sync commands sync. New `remote: 'exit'` option mounts the app headlessly for serve, MCP and `tool()` calls and returns its last frame.
- Help: `--help` no longer reads piped stdin first; `help <unknown>` is an unknown-command error; `--all` lists only registered built-ins; the subcommand hint includes the program name; option suggestions use kebab-case names and catch case-only typos.
- `--version` keeps flags like `--json`.
- REPL: the `repl` command no longer prints the session's results when it ends, uses the runtime passed to `cli()` (new `runtime` REPL option), honors `FORCE_COLOR`, and doesn't crash when started inside a REPL.
- Man pages for subcommands are named `<program>-<command>.1` so they can't shadow system pages, and lines starting with `.` are escaped.
- Completion: dynamic completion skips the value of extension options (`-c file`); the bash script handles `:` in words and quotes candidates with spaces; static scripts fix fish long aliases, bash spacing and PowerShell enum values.
- New interceptor meta `async: true` marks interceptors that may make validation async.

### Help customization

- `.configure({ help: { usage, before, after } })` replaces a command's usage line and adds text before or after its help.
- `.configure({ help: (info, ctx) => ... })` customizes help with a function for a command and its subcommands. It returns modified help info or the final string, and `ctx.render` gives the built-in renderer.
- Rename or remove the help and version flags with `builtins: { help: { flags: ['help', '?'] }, version: { flags: ['version'] } }`.

### Version, update check and upgrade improvements

- Without `.configure({ version })`, `--version`, `upgrade` and the update check read the version from the `package.json` of the package the program's script belongs to, instead of the working directory's project or `npm_package_version`.
- `upgrade --check --exit-code` exits with 1 when a newer version exists, like `npm outdated`.
- `upgrade` asks the registry first: when already up to date it says so without a `padroneConfirm()` prompt, and asks only when there is something to install.
- `padroneUpdateCheck()` never delays the exit: the notice comes from the version cached by an earlier run, and a stale cache is refreshed in a detached background process.
- The update check cache moved to `update-check.json` in `program.dirs.cache`; the old `~/.config/<name>-update-check.json` is moved there.
- The update notice suggests `<program> upgrade` when `padroneUpgrade()` is registered, and uses its package name and registry.
- `version --check` (also `--version --check`) asks the registry and adds an "Update available" notice, like `gh version`; under JSON output it returns `{ name, version, latest, updateAvailable }`. Remote callers get the version without a check.

### Fourth extension sweep: MCP, serve, tracing and Ink

- Serve and MCP arguments round-trip better: `false` reaches booleans whose `--no-` prefix is disabled, empty arrays stay empty instead of taking the default, and array items like `[x]` aren't split as list syntax. `stringify()` follows.
- Serve GET: a param without a value (`?name=`) is an empty string instead of taking the next param as its value; for a boolean (`?verbose`) it still turns it on.
- MCP `tools/call` with `arguments` that aren't an object is an invalid-params error.
- `tool()`: what a successful command writes to stderr (warnings, logs) is in `logs`, not `error`.

### New extensions and extension options

- `padroneJson()` adds a `--json` flag: the result is printed as JSON (iterator items one per line), and in `cli()` errors are printed as `{ "error": { ... } }` on stdout, with validation issues. With `format: 'json'`, auto-output prints values as JSON in `cli()`, `eval()` and the REPL.
- `padroneConfirm()` asks before running `mutation: true` commands in `cli()` and the REPL. `--yes`/`-y` skips the question; without a terminal the command fails unless `--yes` is given.
- Dynamic shell completion: with `padroneCompletion()`, the generated scripts ask the program (`<program> __complete ...`) and complete per command — its subcommands, options and inherited global options, enum values, and values from a field's new `complete` callback.
- `padroneLogger()`: `--verbose` can be repeated (twice is `trace`), and `shortFlags: true` adds `-v`, `-vv` and `-q`. Interceptors can declare `count` options.
- `padroneTracing()`: pass `api: { context, trace }` from `@opentelemetry/api` so `tracing.span()` children and instrumented libraries are parented to the command's span.
- Stack traces: set `DEBUG=1` or `builtins: { autoOutput: { errorStack: true } }` to print an error's stack and `cause` chain in `cli()`.
- `serve()` aborts a command's `ctx.signal` when the client disconnects, and MCP aborts a tool call on `notifications/cancelled` or disconnect. The MCP stdio transport handles messages concurrently.
- `-i`/`--interactive` is accepted, and ignored, on commands without interactive fields instead of failing as an unknown option.
- A `stdin` field makes the command async, so reading piped input no longer warns about a missing `.async()`.
- On commands with interactive fields, options declared by extensions (e.g. `--yes`) are no longer rejected as unknown before prompting.

### Typing fixes and shorthands

- Commands from `defineCommand()` take the name they're registered under, so `run()`, `api()` and `find()` resolve them, and they no longer break the typing of other commands.
- `defineCommand<Context>()((c) => ...)` types a command with the program's context. `defineCommand<Context>(fn)` is now a type error: it lost the command's type.
- A program's `.context<T>()` must be passed to `cli()`, `eval()`, `run()`, `repl()` and `api()`. A `.context(() => ...)` transform on the program creates the context, so callers pass none.
- `InferCommand` works for programs with a context.
- `defineInterceptor(meta).provides<T>().factory(fn)` type-checks the `context` handlers pass to `next()`.
- `MaybePromiseCommandResult`, `PadroneAPI`, `MaybePromise` and `Thenable` are exported, so results can be exported from `declaration` builds.
- `stringify()` args can leave out fields that have defaults.
- `.extend()` takes several extensions: `.extend(padroneJson(), padroneFormat())`.
- `.describe(text)` sets a command's description.

### `run()` and `api()`

- `run()` checks args against the schema and applies its defaults. Invalid args return in `argsResult.issues`.
- `run()` and `api()` no longer print results.
- `api()` takes `{ context, signal }`. Its functions throw on invalid args or a failing action instead of returning `undefined`.

### Command-line output

- Error `suggestions` are printed after the message.
- Validation errors say `Missing required argument`/`Missing required option` and `Expected number, got "abc"`.
- Unknown options read `Unknown option: "x". Did you mean "--y"?`.
- Help lists `--yes` on commands `padroneConfirm()` may ask for, puts global options after the command's own, shows env variables inline as `(env: APP_PORT)`, and shows variadic positionals as `<files...>`.
- Table, csv and tsv cells show lists of plain values as `a, b`.
- Objects and arrays print as JSON when stdout isn't a terminal.

### Fourth extension sweep: config and env

- Serve, MCP and `tool()` calls can no longer pass `--config` / `-c`, which let a request make the program read, or import, any local file. It's now an unknown option for them.
- `config get` and `config unset` take an option's alias or kebab-case name (`dry-run`), like `config set` does.
- `config list` shows the values of `sensitive` options as `[redacted]`.
- `config path` and `config edit` work when `files` has no JSON name, and `config edit` can create a YAML or TOML user config.
- An empty config file, or one with only comments, is an empty config instead of an error.
- Config files saved with a byte order mark are read correctly (YAML and TOML read it as part of the first key).
- `null` in a nested config value unsets that option, as it does at the top level.
- `.env` files: `${VAR:-default}` defaults can contain variables (`${API:-http://${HOST}}`), and multiline values in files with CRLF line endings no longer keep `\r`.

### Add `.globalArgs()`

Define options once for a command and every subcommand below it: `createPadrone('app').globalArgs(z.object({ verbose: z.boolean().optional() }))`. They are accepted before or after the subcommand name, merged into each command's typed `args`, validated separately, and listed under "Global Options" in help and in MCP/serve input schemas. A subcommand overrides a global by defining a field of the same name, or extends the globals for its subtree with `.globalArgs((inherited) => inherited.extend({...}))`.

### Counting, conflicting and implied options

- `count: true` on a number option counts repeated flags: `-vvv` → `3`.
- `conflicts: ['table']` rejects options used together, and `implies: { color: false }` sets other options when one is used. Both are shown in help.
- Built-in flag handling (`--version`, `--color`, `--help`, `--config`, `--interactive`, `--timing`, `--no-update-check`) no longer takes over a command's own option of the same name.

### Results and running other commands

- `run()` awaits an async action's result, like `eval()`: `(await program.run('sync')).result` is the resolved value, and a rejected action is reported in `error`. Results are typed as the awaited value, and the call as a promise when the action is async.
- Actions and hooks get `ctx.run(name, args)`, which runs another command with this run's context and signal and resolves to its result.
- `ctx.program.run()` accepts args again (it rejected every args object).

### Typing

- A `defineCommand().requires<T>()` command is a type error at `.command()` when nothing provides `T`.
- Event handlers' `ctx.context` is typed by the interceptor's `.requires<T>()`.
- `defineArgsMeta(schema, meta)` types an arguments meta kept apart from `.arguments()` / `.globalArgs()`, with no `as const`.
- `.configure()` callbacks used before `.arguments()` now get an error that says to call `.configure()` after `.arguments()`.

### Parsing

- An optional positional before a required one (`[method] <url>`) only takes a value when the required one still gets one: `http https://x` sets `url`.
- Object and record options take `key=value`: `-q page=2 -q sort=asc`.
- Reading stdin again in the same process (a second `eval()`) gives nothing instead of failing with `Premature close`.

### Help and errors

- Object defaults show as JSON (`{"max":5}`) instead of `[object Object]`; empty objects are left out.
- Options that extensions add to every command (`--json`, `-o`, `--config`, …) are listed under Global Options, after the program's global args.
- An option read from stdin says so once, in its notes.
- An invalid list item reads `Invalid value "nocolon" for "--header": …` instead of `header.0: …`.
- Object options show `<key=value>` in help.

### Testing

- `testCli(program).cli(input)` runs a command as `cli()` does: confirmations, printed errors and deprecation warnings.
- Test results have `exitCode`.

## padrone@2.1.0

### `cli()` keeps argv tokens whole and exits non-zero on errors

- Each `process.argv` entry is now exactly one token, so shell quoting is kept: `app g "Dancing Script" -c "Hello World"` no longer splits the values apart. Quotes, backslashes, `=` and non-ASCII text inside a value come through as typed, and an explicit empty entry (`-c ""`) is the value `""` instead of `true`. `eval()` and the REPL still tokenize their string input, and a quoted `""` there is now `""` too.
- A `cli()` run that ends with an error (routing, validation, or a thrown action) now sets the process exit code to the error's `exitCode`, or `1` (130 after SIGINT). It uses `process.exitCode`, not `process.exit()`, so output still flushes. Successful runs, `--help` and `--version` exit `0`.
- New `runtime.setExitCode(code)` to capture or ignore that exit code in custom runtimes.
- Interceptor `ctx.input` is now `string | string[] | undefined` (the `PadroneInput` type): `cli()` passes the argv array.

### Fix build failure when generating type declarations for the `padrone/zod` entry

The `padrone/zod` entry used a named re-export which tripped a `rolldown-plugin-dts` chunk-merge bug during the multi-entry build, breaking `npm publish`. Switched to a wildcard re-export so declaration generation succeeds.

## padrone@2.0.0

### Externalize optional integrations to dedicated subpath entry points

Optional integrations are now exported from dedicated subpath entry points so bundlers that don't tree-shake re-exports keep their dependencies out of the main bundle. Update imports as follows:

- `padroneInk`, `isReactElement`, `InkOptions` → `'padrone/ink'`
- `padroneMcp`, `WithMcp`, `PadroneMcpPreferences` → `'padrone/mcp'`
- `padroneServe`, `WithServe` → `'padrone/serve'`
- `padroneTracing`, `WithTracing`, `PadroneTracer`, `PadroneTracingConfig`, `OtelSpan`, `OtelTracer`, `OtelTracerProvider` → `'padrone/tracing'`
- `padroneCompletion`, `WithCompletion` → `'padrone/completion'`
- `padroneMan`, `WithMan` → `'padrone/man'`

# padrone

## 1.9.0

### Minor Changes

- [`8114f98`](https://github.com/KurtGokhan/padrone/commit/8114f98ce3ae46cb6cdfa152d39e78e35d6ebe7d) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-coerce CLI string values for union types (e.g. `z.union([z.boolean(), z.string()])`) — `--flag true` now correctly passes boolean `true` instead of the string `"true"`

## 1.8.2

### Patch Changes

- [`42b87eb`](https://github.com/KurtGokhan/padrone/commit/42b87eb008a1265bdc353a86d470debcfe42afb8) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-output extension now automatically prints errors hapened in execution phase. Interceptor context now has a `phase` field to understand in which phase an error happened during error/shutdown phases.

## 1.8.1

### Patch Changes

- [`e7c180c`](https://github.com/KurtGokhan/padrone/commit/e7c180c949709240838a7c95c4e74cd90d657352) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `route` phase to interceptors which will run when a command is routed to. This means it will run between parse and execute

- [`9d91f3f`](https://github.com/KurtGokhan/padrone/commit/9d91f3fee7bb07b501d61bbe202892be88fe7792) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - shutdown/error in interceptors can now run for command level interceptors

- [`e4ae6f5`](https://github.com/KurtGokhan/padrone/commit/e4ae6f58efb7e54452bf116e90f3ba9a24a3d7fb) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - fix progress not getting destroyed after an error

## 1.8.0

### Minor Changes

- [`7b58742`](https://github.com/KurtGokhan/padrone/commit/7b5874220f829fbbbc770a850093ce45430a8094) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `negative` meta option for boolean arguments. Custom keyword(s) set the option to `false` and disable the default `--no-` prefix. Supports string, array, and empty values to only disable the prefix.

- [`07b49ae`](https://github.com/KurtGokhan/padrone/commit/07b49aec2bdef4192c514b2ef3dc1a6ef65efce7) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `DefineCommandContext` interface and `defineCommand().requires()` for typed interceptor context in modular commands. Commands defined with `defineCommand()` now have optional `logger`, `tracing`, and `progress` context by default. Use `defineCommand().requires<T>().define(fn)` for additional context requirements with compile-time validation at `.command()` registration.

- [`e8bc2df`](https://github.com/KurtGokhan/padrone/commit/e8bc2dfd6f74f828f5cafb7dc2c0835974e24fc4) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Mark `padroneEnv` and `padroneConfig` as async at the type level. Extensions now return `WithAsync<T>` so `eval()` and `cli()` correctly return `Promise` when used.

- [`46cf13f`](https://github.com/KurtGokhan/padrone/commit/46cf13f96d2f376eb7ab7c6557c9ef45085535e5) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-merge interceptor context in `next()`. Passing `next({ context: { user } })` now shallow-merges into existing context instead of replacing it. Default `TContext` changed from `unknown` to `object` so `ctx.context` is spreadable without type assertions.

### Patch Changes

- [`735ffb4`](https://github.com/KurtGokhan/padrone/commit/735ffb4a7d165c35feb050c4d6c6a5e136f1b173) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Detect ambiguous positional arguments provided both positionally and as named options. For example, `cmd val --pos1=val` with `positional: ['pos1', 'pos2']` now reports a validation error instead of silently overwriting.

## 1.7.1

### Patch Changes

- [`e15d537`](https://github.com/KurtGokhan/padrone/commit/e15d537bf492eaac80ec9f26ff01cfc398e4fd3b) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Fix `DefineCommand` with default context being incompatible with parent programs that have a specific context type.

## 1.7.0

### Minor Changes

- [`3eecb40`](https://github.com/KurtGokhan/padrone/commit/3eecb40ad4f678bf745b70fb1f791ceff4dfb541) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add format-aware output primitives (table, tree, list, key-value) to auto-output. Actions can use `ctx.context.output.table()`, `.tree()`, `.list()`, `.kv()` for styled output that adapts to the runtime format (ANSI, text, JSON, markdown, HTML). Declarative formatting via `padroneAutoOutput({ output: 'table' })` per-command. Extract shared Styler/Layout infrastructure from help formatter into reusable `styling.ts` module.

- [`0a27a69`](https://github.com/KurtGokhan/padrone/commit/0a27a6960622be5f053a9a49731de8d6adf65646) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add printf-style format specifiers (`%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O`, `%%`) to the logger extension, following WHATWG Console Standard conventions.

## 1.6.0

### Minor Changes

- [`75066f9`](https://github.com/KurtGokhan/padrone/commit/75066f9e12c33a1f64c502e248fce4d4e455d0da) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve "Did you mean?" suggestions for typos in commands and options. Return multiple matches (up to 3), add prefix/substring matching for inputs longer than 3 characters, and include `--` prefix in option suggestions. Suggestions are now included in soft-mode validation errors too.

- [`93ab85c`](https://github.com/KurtGokhan/padrone/commit/93ab85c88441e9062b2402f7d97f3d337293f2e7) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add typed context support. Define context with `.context<T>()` or `.context(transform)`, provide it via `cli()`, `eval()`, `run()`, and access it in action handlers as `ctx.context` and in all plugin phase contexts. Subcommands inherit context from parents. `.mount()` accepts an optional `{ context }` transform. New `InferContext` type helper.

- [`3b7fed0`](https://github.com/KurtGokhan/padrone/commit/3b7fed06d15cc2acad04df7d919ce0f6c9b66207) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add typed context injection for interceptors. Interceptors can declare provided context via `.provides<T>()` and required context via `.requires<T>()` on `defineInterceptor()`. Action handlers see the full merged context type. `.intercept()` rejects interceptors whose required context is not satisfied at compile time.

- [`067b9f7`](https://github.com/KurtGokhan/padrone/commit/067b9f7d695a838f0c39204c563029f8a2527675) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add extension system with `.extend()` for build-time composition. Rename plugins to interceptors (`.use()` → `.intercept()`, `PadronePlugin` → `PadroneInterceptor`). Move built-in commands to composable extensions. Default builtins (help, version, repl, color, config, interactive) are applied automatically via `createPadrone()`. Advanced features (completion, man, mcp, serve, update-check) are opt-in extensions. Individual builtins can be disabled via `createPadrone('name', { builtins: { help: false } })`.

- [`4e7f88b`](https://github.com/KurtGokhan/padrone/commit/4e7f88bdc68b7c97f36e3546142b6ebf5f87f76e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Respect terminal width in help output. Default and choices metadata now appear inline with descriptions when space allows, and long descriptions wrap aligned to the description column.

- [`aa0b568`](https://github.com/KurtGokhan/padrone/commit/aa0b568f35c2fcb97a78abf077561a914606de6f) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add support for Ink apps. The `ink` interceptor renders an Ink app as part of a command's execution, and waits for it to unmount before proceeding.

- [`91fd814`](https://github.com/KurtGokhan/padrone/commit/91fd8146c0fff0eb8c4e5f46191d1a6bf8203ecf) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `padroneLogger()` and `padroneTiming()` extensions for structured logging and command execution timing.

- [`99c8cfa`](https://github.com/KurtGokhan/padrone/commit/99c8cfa298194d9632b9c784858c1695e7782acf) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `program.info` for read-only access to program metadata (name, version, description, commands, etc.). Add XDG config directory support via `xdg` option on `padroneConfig()`.

- [`88c45af`](https://github.com/KurtGokhan/padrone/commit/88c45afeef123d4a3e5d5e4d359e080ddf60a154) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add elapsed time (`time: true`) and ETA (`eta: true`) to progress indicators. ETA is calculated from numeric progress updates and counts down between updates. Move progress messages into a `message` field (string or `{ validation, progress, success, error }` object) with runtime-level defaults via context.

- [`8691694`](https://github.com/KurtGokhan/padrone/commit/86916947b189109e6647684d30dc06992a3909b5) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve runtime agnosticism. Add `terminal` and `exit` fields to `PadroneRuntime`. Replace `Buffer` usage with `Uint8Array`/`TextEncoder`. Route scattered `process.*` reads through runtime abstraction. Replace all `require()` calls with dynamic `import()`. Use `runtime.onSignal` in serve/MCP instead of direct `process.on`.

- [`4343f78`](https://github.com/KurtGokhan/padrone/commit/4343f7857b6685c8e1774b4d933846cd786fe828) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add signal handling support for graceful shutdown. Actions and plugins receive an `AbortSignal` via `ctx.signal` that aborts on SIGINT/SIGTERM/SIGHUP. Command results include `signal` and `exitCode` fields when interrupted. Double Ctrl+C within 2 seconds force-quits. Export new `SignalError` class and `PadroneSignal` type.

- [`7464026`](https://github.com/KurtGokhan/padrone/commit/746402615e11262a0ff7257f41a4840c3a54143e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Reject unknown options for commands without `.arguments()`. Previously, commands without a schema accepted all options silently. Now they infer an empty object and error on unknown options.

- [`be62401`](https://github.com/KurtGokhan/padrone/commit/be624016ee6e4852ab043b15b4d525431319a168) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add experimental `padroneTracing()` extension for OpenTelemetry tracing. Logger automatically bridges log calls to span events when tracing is active.

### Patch Changes

- [`dbac7ec`](https://github.com/KurtGokhan/padrone/commit/dbac7ec56a9f0c320550eef2f6b188a3741d1d4e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `runtime` to interceptor contexts. Interceptors can now access and override the runtime via `ctx.runtime` instead of calling `getCommandRuntime()`. Support `next()` overrides for passing modified context to downstream interceptors.

- [`0dfae77`](https://github.com/KurtGokhan/padrone/commit/0dfae774d264d4cab092b90bb779dd3da46abaef) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Collect repeated non-array options into an array for the validator. Enables schemas like `z.union([z.string(), z.array(z.string())])` to receive all values when an option is passed multiple times.

## 1.5.0

### Minor Changes

- [`ef5e829`](https://github.com/KurtGokhan/padrone/commit/ef5e82931c06bbce70b6cdf3e34c179a48d04c66) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `asyncStream` for streaming stdin as `AsyncIterable`. New `padrone/zod` entrypoint exports `zodAsyncStream` and `jsonCodec` for typed streams with per-item validation. Extract shared `JSON_SCHEMA_OPTS` constant across all `jsonSchema.input()` calls.

- [`bbb05d9`](https://github.com/KurtGokhan/padrone/commit/bbb05d9dcf4b360d7f5ae85bdd4fa6e45b68b64d) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `examples` configuration to options and commands for command-line usage examples.

- [`7ff2738`](https://github.com/KurtGokhan/padrone/commit/7ff2738c146c419f4f03315ec8182af5be31d1b0) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Collapse global commands in help output to a single summary line by default. Add `--all` flag to show full global commands section. Bare `--detail` flag now defaults to `full`. Rename "Built-in" section to "Global".

- [`369ebba`](https://github.com/KurtGokhan/padrone/commit/369ebbab4dc14c1d8acfd2af01a9322f5d964e23) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `group` configuration to options and commands for organized help output.

  Options can be grouped via `fields: { myField: { group: 'Group Name' } }` in argument metadata. Commands can be grouped via `configure({ group: 'Group Name' })`. Grouped items are rendered under labeled `${group}:` sections in help output, while ungrouped items remain under the default `Options:` / `Commands:` headers.

- [`3d7b282`](https://github.com/KurtGokhan/padrone/commit/3d7b28202890925e05357c9796218349b4a8410e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add per-field validation during interactive prompts.

  When a user provides an invalid value for an interactive field, the prompt now immediately validates it against the schema and re-prompts with a warning message instead of deferring all errors until after all prompts complete. This applies to both required and optional interactive fields.

- [`1843f1f`](https://github.com/KurtGokhan/padrone/commit/1843f1f3a00714d11570c245361ab73c4049aa91) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Lazily initialize commands defined with callbacks. Builder functions passed to `.command()` are now deferred until the command is routed to, avoiding upfront construction of unused commands. Features that need the full command tree (help, MCP, serve, docs, completion, REPL) resolve all commands eagerly. Added `getCommand()` and `isPadroneProgram()` helpers to replace direct `commandSymbol` usage.

- [`45ba002`](https://github.com/KurtGokhan/padrone/commit/45ba002db474e34808b64b15ebce59b289f9115b) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add built-in Model Context Protocol (MCP) server. Expose CLI commands as AI tools via `mcp` command or `.mcp()` method. Supports Streamable HTTP and stdio transports per the 2025-11-25 MCP spec.

- [`ab53491`](https://github.com/KurtGokhan/padrone/commit/ab534915e3bcb5cd1c3f563f4fde740d1b91fa50) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - **BREAKING:** `eval()`, `cli()`, and `run()` no longer throw errors. Instead, they return a discriminated union with an `error` field:

  - Success: `{ command, args, argsResult, result, drain() }`
  - Error: `{ error, command?, args?, argsResult?, drain() }`

  Added `drain()` method to all command results. It flattens the result into a single `Promise<{ value } | { error }>` that never throws — resolving Promises, collecting iterables into arrays, and catching errors:

  ```ts
  const { value, error } = await program.cli().drain();
  ```

  New exported types: `PadroneDrainResult<T>`, `Drained<T>`.

- [`dffc5cd`](https://github.com/KurtGokhan/padrone/commit/dffc5cd36250f94cc82edae850aa34ae9916d43a) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add progress indicator system for commands with auto-managed spinners and manual control.

  **Auto-managed progress** via `.progress()` builder method:

  - `true` or `string` for simple messages, or a full config object with per-state messages
  - Starts before validation, auto-succeeds/fails after execution
  - Validation-phase message transitions to execution-phase message
  - `spinner` option: preset name (`dots`, `line`, `arc`, `bounce`), custom `{ frames, interval }`, or `false` to disable animation
  - `success`/`error` fields accept static strings, `null` to suppress, callbacks `(result) => string | null`, or `{ message, indicator }` objects for per-call icon customization

  **Manual progress** via `ctx.progress` in action handlers:

  - Works even without `.progress()` config — lazily creates a real indicator on first use
  - Auto-stopped when execution finishes (no leaked spinners)
  - No-op when the runtime has no progress factory

  **Built-in terminal spinner** (`createTerminalSpinner`):

  - ANSI-based spinner with pause/resume for clean output interleaving
  - Customizable success/error indicator icons via `PadroneProgressOptions`
  - Empty string indicators hide the icon prefix entirely
  - Graceful fallback in non-TTY/CI environments

  **New types**: `PadroneProgress`, `PadroneProgressConfig`, `PadroneProgressMessage`, `PadroneProgressOptions`, `PadroneSpinnerConfig`, `PadroneSpinnerPreset`

- [`6851b48`](https://github.com/KurtGokhan/padrone/commit/6851b4878ab0fc8d48f40e93c2f8924236a40165) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add REST server (`program.serve()`) and `mutation` command config.

  - New `serve()` program method: exposes commands as HTTP endpoints with automatic OpenAPI docs (Scalar).
  - New `serve` built-in CLI command: `myapp serve --port 3000`.
  - Built-in endpoints: `/_health`, `/_help`, `/_schema`, `/_docs` (Scalar), `/_openapi`.
  - New `mutation` option in `.configure()`: mutation commands are POST-only in serve, set `destructiveHint` in MCP, and default `needsApproval` to true in `tool()`.
  - MCP: rename `endpoint` to `basePath` for consistency with serve.
  - Shared utilities extracted from MCP (`collectEndpoints`, `buildInputSchema`, `serializeArgsToFlags`).

### Patch Changes

- [`7e8f14d`](https://github.com/KurtGokhan/padrone/commit/7e8f14ddb628620f94a7c9f2e88f9417577f2b04) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Expand boolean auto-coercion to accept `yes`/`no`/`on`/`off` (case-insensitive).

- [`a1c7072`](https://github.com/KurtGokhan/padrone/commit/a1c70724829f8cd4fb1632098f352498c87cbf2e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve help output formatting: options now display flags first, then names, type, and description in aligned columns. Metadata (deprecated, default, choices, examples, env, config) is shown on separate indented lines.

- [`befc82e`](https://github.com/KurtGokhan/padrone/commit/befc82e39b4a1663c3ace74305dd48f9aded1a09) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `.catch()` and `.finally()` methods to thenable sync results from `eval()`, `parse()`, and `cli()`

- [`81f3bbc`](https://github.com/KurtGokhan/padrone/commit/81f3bbce54940953ff32d76c620eabd6cec7322f) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Use `node:child_process` in wrap handler instead of `Bun.spawn` for Node.js compatibility.

## 1.4.0

### Minor Changes

- 365ad1f: Fix positional arguments and make results always thenable

  - Show choices and default values in help output for positional arguments
  - Fix type detection for optional array enum positionals (`z.array(z.enum([...])).optional()`)
  - Coerce single values to arrays when schema expects an array type
  - Make `cli()`, `eval()`, and `parse()` results always thenable (supports `.then()` and `await`)

### Patch Changes

- 79f51ae: Fix false async warning when action is async but validation is sync

## 1.3.0

### Minor Changes

- 6f6bfe5: Auto-generate kebab-case aliases for camelCase option names

  Options like `dryRun` automatically accept `--dry-run` on the CLI. This is enabled by default and can be disabled per-command with `autoAlias: false`. Auto-aliases are shown as the primary name in help text when available.

  ```ts
  // --dry-run automatically resolves to dryRun
  .arguments(z.object({ dryRun: z.boolean() }))

  // Disable auto-aliases
  .arguments(z.object({ dryRun: z.boolean() }), { autoAlias: false })
  ```

- 07cbf35: Split option `alias` into `flags` (single-char, stackable) and `alias` (multi-char long names)

  **Breaking:** `PadroneFieldMeta.alias` for single-character shortcuts is now `flags`.

  - `flags`: single-char short flags used with single dash (`-v`, `-o file`). Stackable: `-abc` = `-a -b -c`.
  - `alias`: multi-char alternative long names used with double dash (`--dry-run` for `--dryRun`).

  ### Migration

  ```diff
  - { fields: { verbose: { alias: 'v' } } }
  + { fields: { verbose: { flags: 'v' } } }
  ```

  ```diff
  - z.string().meta({ alias: ['v'] })
  + z.string().meta({ flags: ['v'] })
  ```

  Multi-char aliases remain as `alias`:

  ```ts
  {
    fields: {
      dryRun: {
        alias: "dry-run";
      }
    }
  }
  ```

- 186c2be: Improve help output formatting

  - Use bracket convention for option types: `<type>` for required, `[type]` for optional, nothing for booleans
  - Show kebab-case alias as primary name when available (e.g. `--dry-run` instead of `--dryRun`)
  - Move choices and default values after the description
  - Show array item types (e.g. `[string[]]` instead of `[array] (repeatable)`)
  - Hide empty default values (empty strings and arrays)
  - Cap description alignment at 32 characters
  - Show `(stdin)` marker on arguments that accept stdin input
  - Show `--no-` negation hint only when relevant (boolean options defaulting to true)
  - Remove `[no-]` prefix from individual boolean options

## 1.2.0

### Minor Changes

- 66336e5: auto-output is now enabled by default: command return values are automatically written to output in eval, cli, and repl modes. The runtime `output` function now accepts `unknown` values instead of only strings, letting runtimes handle formatting natively. Use `autoOutput: false` in preferences or `configure({ autoOutput: false })` on individual commands to opt out.
- 02a171c: Add runtime adapter for I/O abstraction, enabling CLI framework usage outside of terminals (web UIs, chat interfaces, testing). New `.runtime()` builder method configures output, error, argv, env, format, config file loading, and file discovery. All fields are optional with Node.js/Bun defaults. Successive `.runtime()` calls merge with previous configuration.
- 93155ef: Add `padrone/codegen` entry point with a generic code generation toolkit including CodeBuilder (fluent TypeScript source builder), template engine, schemaToCode (Standard Schema to Zod source), FileEmitter (multi-file output), built-in generators (command files, command trees, barrel files), and parsers (help text, fish completions, zsh completions, multi-source merge). Also add `padrone init` CLI command that scaffolds a new Padrone project using the codegen utilities, and reorganize CLI files into `src/cli/` subfolder.
- 68508a7: Add command override/extension support. Re-registering a command with the same name now merges instead of duplicating: configuration is shallow-merged, the previous handler is passed as a `base` parameter to `.action()`, arguments can be overridden, and subcommands are recursively merged by name. Aliases are preserved from the original when the override doesn't specify new ones. All fully strongly typed.

  Also fixes: REPL `.` command now works at any scope (including root) to execute the current command, `.help` always shows `.` and `.scope` entries, `cli()` and `repl()` return types now include all possible command results, and nested commands with default `''` subcommands route correctly.

- 7e83ebb: Improve command routing, help display, and `--` separator support.
- 583394b: Add `padrone/completion` subpath export and `padrone completions` CLI command. Shell completion generation is now lazy-loaded via dynamic import, and `setupCompletions()` writes eval snippets to shell config files with idempotent marker-based replacement. User programs get `--setup` on the built-in `completion` command (e.g. `myapp completion bash --setup`). The `.completion()` method is now async.
- 457f1f7: Add `padrone/docs` entry point with a `generateDocs()` utility that walks the command tree and generates structured documentation in four formats: markdown (with index page, frontmatter support for VitePress/Starlight), HTML (semantic with CSS classes), man pages (groff-formatted), and JSON. Each page includes command name, description, usage syntax, options with types/defaults/choices/aliases/env vars/config keys/examples, positional arguments, and subcommands table. Also add `padrone docs` CLI command that imports a Padrone program from any entry file and generates documentation to an output directory.
- 038d0aa: Add `padrone doctor <entry>` CLI command that lints and validates a Padrone program definition. Catches duplicate aliases, shadowed option/command names (help, version), commands without actions, schemas without descriptions, conflicting positional configs, and unused plugins.
- 262e2e6: Add `eval()` method and separate from `cli()`. `program.eval(input)` parses, validates, and executes a command string with soft error handling (returns result with issues instead of throwing). `program.cli()` is now exclusively the process entry point that reads from `process.argv` and throws on validation errors. The REPL and AI SDK tool integration now use `eval()` internally.
- fb86d5b: Add fuzzy matching for "Did you mean?" suggestions on unknown commands and options.
- 020cc21: Add interactive field prompting. Commands can now declare `interactive` and `optionalInteractive` in the arguments meta to prompt users for missing field values during `cli()`. Interactive prompts are auto-detected from the schema (boolean → confirm, enum → select, array enum → multiselect). The runtime controls whether interactivity is enabled via `runtime({ interactive: true })`, with a built-in Enquirer-powered terminal prompt as the default. Custom prompt implementations can be provided for non-terminal runtimes.
- cba6615: Add lifecycle hooks to the plugin system: `start`, `error`, and `shutdown` phases. `start` wraps the entire pipeline (before parse), `error` handles pipeline failures with the ability to suppress or transform errors, and `shutdown` always runs after completion for cleanup. All three use the same onion/middleware pattern as existing phases. Available in `eval()` and `cli()` only. Sync preservation is maintained.
- 727c6af: Add `padrone link` and `padrone unlink` CLI commands for linking programs during development. Creates shell shims in `~/.padrone/bin/` that invoke the entry file with the detected runtime. Auto-detects entry from `package.json` bin field and runtime from lockfiles. Use `--setup` to automatically add `~/.padrone/bin` to PATH in shell config. Shell utilities (`detectShell`, `getRcFile`, `writeToRcFile`) extracted to `shell-utils.ts` for reuse.
- fdca76f: Add `.mount(name, program)` method for composing Padrone programs together. Mounts an existing program as a subcommand, recursively re-pathing all nested commands and preserving arguments, handlers, plugins, and schemas. Supports aliases via array syntax. Mounted program's root-level `version` is dropped. Type-level paths are recursively updated for correct inference with `eval()`, `find()`, `run()`, etc.
- 4706462: Add plugin system with middleware pattern for intercepting command execution phases. Plugins use an onion model with `next()` to wrap parse, validate, and execute phases. Registered via `.use()` on both programs and subcommand builders. Program-level plugins apply as outermost wrappers; subcommand plugins compose as inner layers. Parse phase runs root plugins only. Supports explicit ordering via `order` parameter, shared mutable `state` across phases, sync preservation, and short-circuiting.
- 1a44f9d: Add REPL command history, tab completion, and output styling. The built-in terminal REPL now supports up/down arrow history navigation and tab completion for command names, subcommands, options, and aliases. New `repl()` preferences: `history` (initial entries), `completion` (toggle tab completion), `spacing` (separators before/after command output — supports blank lines, repeated characters, multi-line arrays, and independent before/after config), and `outputPrefix` (prefix each output line, e.g. `'│ '`). The default prompt is bold in ANSI-capable terminals.
- a73bf6a: Add REPL mode. `program.repl()` starts an interactive Read-Eval-Print Loop that returns an `AsyncIterable<PadroneCommandResult>`, yielding a result for each successfully executed command. Errors are caught and printed without crashing the session. Built-in REPL commands (`exit`, `quit`, `clear`) are provided but yield to user-defined commands of the same name. The runtime gains a new `readLine` field for abstracting line input, with a default Node.js/Bun `readline` implementation.
- 5437416: Add scoped/contextual REPLs, `--repl` CLI flag, and dot-prefixed built-in commands. All REPL built-ins now use dot-prefix notation (`.exit`, `.quit`, `.clear`, `.scope`, `.help`, `.history`) to avoid collisions with user commands. `.scope <subcommand>` scopes the REPL session to a command subtree, `.scope ..`/`..` goes back up, `.` executes the current scoped command. `.help` shows REPL-specific commands and keybindings. `.history` shows session command history. Default greeting displays program name and version; configurable `hint` text shown below. Double Ctrl+C to exit (first press shows hint). The prompt updates to reflect scope (e.g. `myapp/db ❯`). `options.scope` allows starting pre-scoped and is strongly typed to valid command paths. The `--repl` flag in `cli()` starts a REPL (optionally scoped to a command).
- b021824: Removed parse options. Custom runtimes can be used for the same behavior.
- 3ad9c6f: Add stdin piping support. Commands can declare a `stdin` field in their arguments meta to read piped input and inject it into a schema field. Supports `text` mode (read all as string) and `lines` mode (read as string array). Precedence: CLI flags > stdin > env vars > config file > schema defaults. Stdin is only read when piped (not a TTY) and the target field wasn't already provided via CLI. Runtime abstraction (`PadroneRuntime.stdin`) enables custom stdin sources for testing and non-terminal environments. Test harness gains `.stdin(data)` builder method. Help output shows `[stdin > field]` in usage line.
- a64f576: Add `padrone/test` entry point with testing utilities. The `testCli(program)` function provides a fluent builder for setting up CLI test scenarios with mock I/O capture. Supports mocking environment variables (`.env()`), interactive prompt answers (`.prompt()`), config files (`.config()`), and REPL sessions (`.repl()`). Works with any test framework.
- 6269637: add async validation support
- 6d15076: Add built-in opt-in update checking via `.updateCheck()`. When enabled, the program checks the npm registry (or a custom URL) for newer versions in the background and displays a notification after command output. Checks are cached to avoid hitting the registry on every invocation. Respects CI environments, non-TTY contexts, `--no-update-check` flag, and a configurable env var to disable.

### Patch Changes

- 54de1b9: show built-in commands and flags (help, version, completion, --repl) in root help output
- 6fa2ac9: improve help output formatting: show actual positional argument names in usage line, use `[options]` instead of `[arguments]` for flags, and rename flags section from "Arguments" to "Options"
- bf6fe49: Add AI coding agent skill with API reference, examples, and installation instructions for Claude Code and other Agent Skills-compatible tools.

## 1.0.0

Initial stable release of Padrone - a TypeScript CLI framework with Zod schema support.

### Features

- Type-safe argument parsing with Zod schemas
- Interactive prompts with validation
- AI integration support via Vercel AI SDK
- Standard Schema compatibility
- Terminal UI components
- Command builder pattern
