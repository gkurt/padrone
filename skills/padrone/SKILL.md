---
name: padrone
description: Build CLI applications with the Padrone framework. Use when writing code that imports from 'padrone', creating CLI tools, defining commands with Zod schemas, or working with Padrone's builder API, interceptors, extensions, testing, REPL, or AI tool integration.
user-invocable: true
license: MIT
metadata:
  - type: npm-package
    name: padrone
    url: https://www.npmjs.com/package/padrone
---

# Padrone CLI Framework

Padrone is a type-safe CLI framework for Node.js/Bun. It uses any schema library that implements the [Standard Schema](https://github.com/standard-schema/standard-schema) spec (Zod, Valibot, ArkType, etc.) for argument validation and provides an immutable builder API for defining programs, commands, interceptors, and extensions.

## Installation

```bash
npm install padrone zod    # or any Standard Schema-compatible library instead of zod
```

## Quick Start

```ts
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('mycli')
  .configure({ version: '1.0.0', description: 'My CLI app' })
  .command('greet', (c) =>
    c
      .arguments(z.object({ name: z.string() }), { positional: ['name'] })
      .action((args) => `Hello, ${args.name}!`),
  )
  .command(['deploy', 'dp'], (c) =>
    c
      .arguments(z.object({
        env: z.enum(['staging', 'production']),
        dry: z.boolean().default(false),
      }))
      .action((args, { runtime }) => {
        runtime.output(`Deploying to ${args.env}...`);
        return { deployed: true };
      }),
  );

program.cli();
```

## Core Concepts

- **Immutable builder**: Every method returns a new builder/program instance
- **Standard Schema validation**: Any schema library supporting `standard-schema` (Zod, Valibot, ArkType, etc.) defines positional args, named flags, defaults, coercion, and validation
- **Two entry points**: `'padrone'` (core) and `'padrone/test'` (testing utilities)
- **Sync by default**: Returns become async only when async schemas or interceptors are used

## Builder API Summary

| Method | Purpose |
|---|---|
| `.arguments(schema, meta?)` | Define options/args with a Standard Schema |
| `.globalArgs(schema, meta?)` | Options for this command and all subcommands (before or after the subcommand name), merged into their args. Subcommands override by redefining a field, or extend via `.globalArgs((inherited) => inherited.extend({...}))` |
| `.action(handler?)` | Set the command handler `(args, ctx, base?) => result` |
| `.command(name, builderFn?)` | Add or extend a subcommand. For a builder in its own file: `defineCommand((c) => ...)`, or `defineCommand<Ctx>()((c) => ...)` with the program's context (`defineCommand<Ctx, typeof globals>()` also types its global args) (never `defineCommand<Ctx>(fn)`, a type error), or `defineCommand().requires<Ctx>().define(fn)` for interceptor-provided context |
| `.context(transform?)` | Define typed context or transform inherited context |
| `.mount(name, program, options?)` | Mount another Padrone program as a subcommand (with optional `{ context }`) |
| `.configure(config)` | Set title, description, version, deprecated, hidden, group, mutation, needsApproval, outputSchema, expose (which callers may run it: `false` = local only) |
| `.intercept(interceptor)` | Register a middleware interceptor |
| `.extend(...extensions)` | Apply build-time extensions in order (bundles of config, commands, interceptors): `.extend(padroneJson(), padroneFormat())` |
| `.describe(text)` | Set the description (shorthand for `.configure({ description })`) |
| `.extend(padroneEnv(schema))` | Parse environment variables into args; `{ prefix: 'APP' }` reads every option (`APP_DB__HOST` → `db.host`, `nestedSeparator` changes `__`; `scope: 'command'` reads a subcommand's own options from `APP_<COMMAND>_<OPTION>`), array options split on `arraySeparator` (`APP_TAGS=a,b`), empty variables count as unset unless `allowEmpty` (import `padroneEnv` from `'padrone'`) |
| `.extend(padroneConfig({ files, schema? }))` | Load args from config files; `profiles: true` adds `--profile`, per-command sections by default (`serve: { port: 3000 }`; `sections: 'auto'` reads a key as the running command's option of that name if it has one, `true` always as a section, `false` never), `command: true` a `config get\|set\|unset\|list\|path\|edit` command (`--local`/`--file`) (import `padroneConfig` from `'padrone'`) |
| `.dryRun(handler)` | Adds `--dry-run`/`-n`: `handler(args, ctx)` runs instead of the action and returns what would change (ideally the action's type; otherwise the result type becomes a union; call after `.action()`). Commands without one reject `--dry-run` |
| `.hook(name, handler)` | `'preAction'` (`(ctx) => …`) / `'postAction'` (`(ctx, result) => …`) around the action of this command and every subcommand (ancestors' pre-hooks first, post-hooks last; post only on success). `ctx` = action context + `args` (typed as this command's) + `dryRun`; async hooks are awaited |
| `.wrap(config)` | Wrap an external CLI tool *(experimental)*; `separator: '--'`, `flagStyle: 'equals'` |
| `.extend(padroneProgress(config?))` | Auto-managed progress indicator (import `padroneProgress` from `'padrone'`) |
| `.runtime(runtime)` | Custom I/O adapter (output, error, env, prompt) |
| `.extend(padroneUpdateCheck(config?))` | Enable background update notifications (import `padroneUpdateCheck` from `'padrone'`) |
| `.async()` | Mark command as using async validation |

## Program API Summary (after builder methods)

| Method | Purpose |
|---|---|
| `.cli(prefs?)` | Entry point from `process.argv` (one token per entry) — prints errors and sets the exit code (error's `exitCode`, or 1). Pass `context` in prefs. |
| `.eval(input, prefs?)` | Parse + validate + execute a string — returns issues softly. Pass `context` in prefs. |
| `.run(name, args, prefs?)` | Execute by name with args object: checked against the schema (defaults applied; invalid args in `argsResult.issues`), no parse/validate phases, nothing printed. Pass `context` in prefs (required when the program declares one). |
| `.parse(input?)` | Parse without executing |
| `.repl(options?)` | Start interactive REPL session |
| `.help(command?, prefs?)` | Generate help text |
| `.completion(shell?)` | Generate shell completion script |
| `.find(command)` | Look up a command by path |
| `.api(prefs?)` | Type-safe programmatic API: `api(prefs).db.migrate(args)` returns the result, throws on invalid args or a failing action |
| `.tool(prefs?)` | Vercel AI SDK tool definition; `timeout` aborts long calls |
| `.mcp(prefs?)` | Start MCP server (HTTP or stdio); hidden, built-in and unexposed commands are left out; `include`/`exclude`, `auth`/`bearer`, `allowedHosts`, `timeout`, `maxConcurrent`, `sessionTtl`, `maxSessions` *(experimental)* |
| `.serve(prefs?)` | Start REST server with OpenAPI docs; cross-site `Origin`s other than `cors` get 403, `maxBodySize` caps bodies; `include`/`exclude`, `auth`/`bearer` (401, identity in `ctx.auth`), `allowedHosts`, `timeout` (504), `maxConcurrent` (503) *(experimental)* |
| `.stringify(command?, args?)` | Convert back to CLI string |

## Arguments Meta

The second parameter to `.arguments()` configures positional args, interactive prompts, and field metadata:

```ts
.arguments(schema, {
  positional: ['source', '...files'],     // '...' prefix = variadic
  interactive: true,                       // or ['fieldName']; objects are asked key by key (db.host), blank required answers re-asked
  autoAlias: true,                         // auto kebab-case aliases for camelCase (default: true)
  exactlyOne: ['file', 'url'],             // exactly one of --file/--url (or [['a', 'b'], ['c', 'd']]); atLeastOne: one or more
  stdin: 'data',                           // infers text/lines from schema type; use zodAsyncStream() for streaming
                                           // { field: 'data', trim: true } trims; a lone `-` value reads stdin (cat -)
  fields: {
    output: { flags: 'o', description: 'Output path', examples: ['./dist'] },
    verbose: { flags: 'v', hidden: true },
    dryRun: { alias: 'dry' },             // multi-char long alias (--dry)
    local: { negative: 'remote' },        // --remote sets local to false, disables --no-local
    old: { deprecated: 'Use --new instead', group: 'Legacy' },
    level: { flags: 'v', count: true },   // -vvv → 3
    json: { conflicts: 'table', implies: { color: false } },
    output: { requiredIf: { format: 'file' } }, // also requires: 'x', requiredUnless: ['a', 'b']
    token: { sensitive: true },           // masked prompt, no help default; redactArgs(command, args) for logs
    body: { fromFile: true },             // --body @notes.md reads the file, - reads stdin, @@x → "@x" (command line only)
  },
})
```

Object, record and array-of-object options take JSON as well as dotted keys: `--db '{"host":"x"}' --db.port 5432` (dotted keys merge with the JSON, the later one winning), `--items '[{"name":"a"}]'` or one `--items '{"name":"a"}'` per item.

## Interceptor System

Seven phases in onion/middleware pattern with `next()`:

1. **start** — before pipeline (root only, not called by `parse()`/`run()`)
2. **parse** — command routing (root only)
3. **route** — after command resolved, before validation (root + command chain)
4. **validate** — schema validation (root + command chain)
5. **execute** — handler execution (root + command chain)
6. **error** — error handling, two layers: command-level first, then root-level (return `{ error: undefined, result }` to suppress); a command-level interceptor with a root one's `id` replaces it in both
7. **shutdown** — cleanup, always runs, two layers: command-level first, then root-level

All phase contexts include `context` (user-provided context), `signal` (AbortSignal for cancellation), `caller` (invocation method: `'cli'`, `'eval'`, `'run'`, etc.), `auth` (who made the request, from serve/MCP `auth` or `eval()`'s `auth`), and `runtime`.

```ts
import { defineInterceptor } from 'padrone';

const timer = defineInterceptor({ name: 'timer', order: -10 }, () => {
  let startTime: number;
  return {
    start: (ctx, next) => {
      startTime = Date.now();
      return next();
    },
    execute: (ctx, next) => {
      const result = next();
      console.log(`${ctx.command.path} took ${Date.now() - startTime}ms`);
      return result;
    },
  };
});
program.intercept(timer);
```

`defineInterceptor()` returns a factory — each execution gets fresh closure state. Supports `.provides<T>()` and `.requires<T>()` for typed context (`defineInterceptor(meta).provides<T>().factory(fn)` type-checks the `context` passed to `next()`) (`.requires()` and `.on()` return a new interceptor, leaving a shared one unchanged); `.requires<T>('padrone:logger')` also checks at runtime that the interceptor with that id is registered. `callers: LOCAL_CALLERS` (or `['cli', 'repl']`, `REMOTE_CALLERS`) in the meta runs it only for those callers. Custom events: `const deployed = defineEvent<{ env: string }>('myapp:deployed')`, handled with `interceptor.on(deployed, (payload, ctx) => ...)` and emitted with `await ctx.emit(deployed, { env })` from actions/interceptors (handlers on the command chain run in order) or `program.emit()` (root handlers). The built-in `commandNotFound` event (import from `'padrone'`) fires for an unknown command name: `event.handle((ctx) => result)` runs something in its place, `event.reroute(['deploy', ...event.args])` routes another input; otherwise the usual "Unknown command" error with suggestions follows (only emitted when a handler exists, so sync programs stay sync). Meta `extraCommands: (command) => [{ name, description, group }]` lists such commands in help and completion.

## Extension-First Architecture

Padrone's core is minimal — most features are implemented as extensions composed via `.extend()`. When you call `createPadrone()`, built-in extensions are automatically applied:

| Extension | Order | What it does |
|-----------|-------|-------------|
| `signal` | -2000 | SIGINT/SIGTERM handling, AbortSignal propagation; `{ signal: { forceExitMs, onForceExit } }` tunes the double Ctrl+C force exit; inside the REPL, Ctrl+C interrupts the running command |
| `autoOutput` | -1100 | Auto-print results (strings, promises, iterators) |
| `color` | -1001 | `--color[=always\|never\|auto\|<theme>]`/`--no-color` flag support |
| `stdin` | -1001 | Pipe stdin into argument fields |
| `help` | -1000 | `--help` flag, `help` command, error-phase help display |
| `version` | -1000 | `--version` flag (any command; `-v`/`-V` on the root), `version --verbose` shows runtime/platform/shell, `version --check` adds an update notice; without a configured version, reads the script's package.json |
| `repl` | -1000 | `--repl` flag, `repl` command |
| `interactive` | -999 | `--interactive` flag, auto-prompting |
| `suggestions` | -500 | "Did you mean?" for unknown commands/options |

Each can be disabled: `createPadrone('myapp', { builtins: { help: false } })`. `help` also takes options: `{ help: { showHelpOnError: true } }` prints full help after errors (default: a one-line `--help` hint on stderr); `{ help: { pager: true } }` pages long help through `$PAGER`/`less -FRX` in `cli()` (`--no-pager` skips); `{ help: { pickSubcommand: true } }` prompts for a subcommand when a group command runs without one; `{ help: { topics: { environment: { description, content } } } }` adds `help environment` guides ("Additional help topics"); `help --search <term>` searches commands and topics; `{ suggestions: { run: 'prompt' } }` offers to run the closest command after a typo; `{ help: { flags: ['help', '?'] } }` and `{ version: { flags: ['version'] } }` rename the flags. Customize help per command with `.configure({ help: { usage, before, after } })`, or with a function `(info, ctx) => info | string` that also applies to subcommands.

Advanced opt-in extensions imported from `'padrone'`: `padroneLogger()` (logs to stderr, colored when stderr is a terminal; `format: 'json'` for JSON lines, `stdout: true` for info on stdout, `redact: ['user.password', '*.token']`, `destination: 'app.log'` (or a function / `{ write }`, or an array of them and `{ destination?, level?, format? }` streams), `serializers: { req: (req) => ({ method: req.method }) }` (errors via `err`), `logger.child({ requestId })` bindings), `padroneTiming()` (`Done in …` / `Failed after …`, printed after the error; `format` callback), `padroneProgress()`, `padroneUpdateCheck()` (`shouldNotify(info)` suppresses the notice, `format(info)` rewords it), `padroneEnv()`, `padroneConfig()` (`merge: true` layers configs, `extends` keys pull in base configs (only a script config can extend a script); `searchParents: 'project'` or `stopDir` bounds the parent search; a script config may export a function of `{ command, env, envName, profile }` (type it with `defineConfig()`); `$production: { ... }` / `$env: { staging: { ... } }` override values for `envName` (default `NODE_ENV`); only keys a command has options for are applied; built-in commands like `help`/`serve`/`config` get no config or env values unless `builtins: true`, and `.configure({ builtin: true })` marks your own; `config`/`alias`/`upgrade`/`completion`/`man`/`serve`/`mcp` refuse serve, MCP and `tool()` calls), `padroneJson()` (`--json` output; `--jq '<expr>'` (lazy jq subset: paths, `select`/`map`/`sort_by`/`group_by`, `if`, `as $x`, arithmetic, `test`/`sub`/`gsub`, `"\(.x)"` interpolation, `range`/`limit`/`first(f)`/`any`/`all`, `paths`/`getpath`/`setpath`/`delpaths`/`tostream`, `$ENV`, `@csv`/`@tsv`/`@sh`/`@uri`/`@base64d`; compact JSON when piped; a step budget via `jqLimits: { maxSteps, remoteMaxSteps }`, and remote callers see an empty `$ENV`) and `--template '{{.name}}'`; `fields: true` for `--json=name,url`), `padroneFormat()` (`-o text|json|yaml|csv|tsv|table`; `tableFlags: true` adds `--columns`, `--sort`, `--no-header`; `columns: { id: 'ID' }` sets columns and header labels; `pipedTable: 'tsv'` prints tables as TSV when piped; `csvLineEnding: 'crlf'`; `sanitize: true` strips escape sequences from untrusted values; `csvFormulaEscape: true` guards csv/tsv cells against formula injection), `padroneConfirm()` (confirm `mutation: true` commands, `--yes` or `<PROGRAM>_YES=1` skips; `env` renames the variable; `nonInteractive: 'yes' | 'no'` runs or aborts without a terminal instead of failing; `.configure({ confirm: 'Drop all tables?' })` sets a command's question, `confirm: false` skips it), `padroneCredentials()` (`ctx.context.credentials.get/set/delete(name)`: macOS `security` / Linux `secret-tool` with the secret on stdin, else a `0600` file in `program.dirs.data`; serve/MCP/tool calls are refused unless `remote: true`; inject `runner` in tests), `padroneUpgrade()` (`upgrade` self-update command: checks first, then asks `padroneConfirm()` only when there is something to install; `--check`, `--check --exit-code`, `--to`, `--channel`; `verify: (plan) => boolean` refuses a release before installing; `verifySha256(bytes, sums, fileName)` checks a downloaded binary in a custom `installer`), `padroneAliases()` (user aliases: `alias set co checkout --force`; `$1`…`$N` and `$@` placeholders, `@file` words expand with response files; `alias list` prints YAML that `alias import <file|->` reads back (`--clobber` overwrites), `alias export [file] [--json]`), `padroneResponseFiles()` (`my-cli @args.txt` expands the file's arguments; `@@` escapes; a `fromFile` option's `@file` value is left to `fromFile`; `relativeTo: 'file'` resolves nested `@file`s beside the including file), `padroneExternalCommands()` (`my-cli foo --bar` runs `my-cli-foo --bar` from `PATH`: no shell, inherited stdio, its exit code; listed in help and completion; never for serve/MCP/`tool()`; `prefix`, `path`, `spawn` options), `padronePlugins()` (runtime plugins: modules default-exporting an extension or a program, loaded at startup from `plugins.json` in `program.dirs.data/plugins` and `packages`; `command: true` adds `plugins list|install|uninstall|link`; `exec`/`import` options for tests). Actions also get `ctx.prompt` (`text`, `password`, `confirm`, `select`, `multiselect`, `group({ key: ({ results }) => … })`; cancelling throws `PromptCancelledError`, and without a terminal or for remote callers prompts return their `default` or throw `PromptUnavailableError`; interceptors use `createPrompt(ctx)`), `ctx.runtime.editor(text)`, `ctx.runtime.open(url)`, `ctx.runtime.page(text)` and `ctx.program.dirs` (`config`, `cache`, `data`, `state`, `log`). Optional integrations live behind subpath imports to keep their dependencies out of the main bundle: `padroneInk` from `'padrone/ink'` (`remote: 'exit'` returns an app's last frame to serve/MCP/tool calls), `padroneMcp` from `'padrone/mcp'`, `padroneServe` from `'padrone/serve'`, `padroneTracing` from `'padrone/tracing'`, `padroneCompletion` from `'padrone/completion'` (dynamic completion with descriptions; `fields: { x: { complete: () => [...] } }` supplies values, as strings or `{ value, description }`, or `{ values, directive: 'dirs' }`; `.configure({ complete: ({ position, positionals, prefix, args, runtime, context }) => [...] })` completes a command's positionals; field meta `hint: 'dir' | 'file' | { ext: [...] } | 'command' | 'url' | 'none'` sets the fallback and `valueName: 'PATH'` the help placeholder; `padroneCompletion({ mode: 'static', descriptions: false })` or `completion <shell> --static --no-descriptions`), `padroneMan` from `'padrone/man'` (`{ section: 8, dir }` for the man section and `man --setup` directory). Safeguards: `padronePlugins({ allow, apiVersion, override, ignoreScripts })` pins installed plugins (version and SHA-256 in `plugins.json`) and adds `plugins update|info` and `list --json`; `padroneConfig({ scripts })` refuses or vets script configs (which run code); `padroneExternalCommands({ env })` limits the environment external commands inherit; `padroneCredentials` has `list()`; `padroneUpgrade` has `--rollback` and `verifySignature()` (Ed25519/ECDSA) next to `verifySha256()`; `padroneUpdateCheck({ channel })` follows a dist-tag.

## Testing

```ts
import { testCli } from 'padrone/test';

const result = await testCli(program).run('greet World');
// result: { command, args, result, issues, stdout, stderr, error }

// With mocks (and the typed context, if the program declares one)
await testCli(program)
  .context({ db })
  .env({ API_KEY: 'xxx' })
  .prompt({ name: 'myapp' })
  .run('deploy --env staging');

// REPL testing
const { results } = await testCli(program).repl(['greet Alice', 'greet Bob']);
```

## Progress Indicators

Auto-managed spinners for long-running commands via `padroneProgress()` context-providing interceptor:

```ts
.command('deploy', (c) =>
  c
    .async()
    .extend(padroneProgress({
      message: {
        progress: 'Deploying...',
        success: (result) => `Deployed v${result.version}`,
        error: 'Deploy failed',
      },
      bar: true,
      time: true,
      eta: true,
    }))
    .action(async (_args, ctx) => {
      await deploy();
      ctx.context.progress.update(0.5);
      ctx.context.progress.update('Finalizing...');
      return { version: '2.0' };
    }),
)
```

- **Auto-managed**: `padroneProgress()` starts before execution, calls `succeed`/`fail` automatically
- **Messages**: `message` accepts a string (progress message) or `{ validation?, progress?, success?, error? }`. Can also be provided from context via `progressConfig.message` — command-level fields take precedence
- **Manual control**: Use `ctx.context.progress` in action handlers — `update(string | number | { message?, progress?, indeterminate?, time?, prefixText?, suffixText? })`, `succeed`, `fail`, `stopAndPersist`, `stop`, `pause`, `resume`
- **Typed context**: `padroneProgress()` uses `.provides<{ progress: PadroneProgressContext }>()` — `ctx.context.progress` is fully typed
- **Task lists**: `await ctx.context.progress.tasks([{ title, task: (t) => ..., skip?, retry?, rollback? }], { concurrent?, exitOnError?, rendererOptions: { collapseSubtasks? } })` runs tasks drawn as a live list (listr2-style; plain start/finish lines without a TTY or in CI); `t.update(msg)`, `t.setTitle()`, `t.skip(reason)`, `t.tasks([...])` for subtasks, `t.signal`, `t.retry.count`. `retry: n | { tries, delay }` reruns a failing task; `rollback: (t, err) => ...` runs when it fails for good. `taskRenderer` replaces the drawing (`createSimpleTaskList` prints plain lines)
- **State**: `ctx.context.progress.isActive` / `isPaused`
- **Final line**: `ctx.context.progress.stopAndPersist({ symbol: 'ℹ', text: 'Up to date' })`; `prefixText` / `suffixText` in the config or `update({ prefixText })`
- **Dynamic messages**: `success`/`error` can be callbacks returning `string | null | { message, indicator }`
- **Spinner config**: `spinner` accepts preset name (`'dots'`, `'line'`, etc.), `true` (always show), `false` (disable), or `{ frames, interval, show }` object
- **Progress bar**: `bar: true` or `bar: { width, filled, empty, animation, show }` — renders percentage + bar. Indeterminate animations: `'bounce'`, `'slide'`, `'pulse'`
- **Elapsed time**: `time: true` shows `⏱ M:SS` counter. Can be toggled via `update({ time: true/false })`
- **ETA**: `eta: true` shows `ETA M:SS` based on progress rate. Requires numeric `update()` calls. Counts down between updates
- **Custom renderer**: `renderer: (message, options?) => PadroneProgress` to replace the built-in terminal renderer

## Error Classes

- `PadroneError` — base (exitCode, suggestions, command, phase)
- `RoutingError` — unknown command
- `ValidationError` — schema failures (has `.issues`)
- `ConfigError` — config file problems
- `ActionError` — throw from action handlers with structured metadata

## Additional Resources

- For the complete API reference with all type signatures, see [api-reference.md](api-reference.md)
- For full working examples covering common patterns, see [examples.md](examples.md)
