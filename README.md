<p align="center">
  <img src="media/padrone.svg" alt="Padrone Logo" width="200" height="200" />
</p>

<p align="center">
  <strong>Type-safe CLI framework powered by Zod schemas</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/padrone"><img src="https://img.shields.io/npm/v/padrone.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/padrone"><img src="https://img.shields.io/npm/dm/padrone.svg" alt="npm downloads"></a>
  <a href="https://github.com/gkurt/padrone/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/padrone.svg" alt="license"></a>
</p>

---

Define your CLI with Zod schemas. Get type safety, validation, help generation, interactive prompts, shell completions, AI tool integration, and more — all from a single source of truth.

Built on [Standard Schema](https://github.com/standard-schema/standard-schema), so it also works with Valibot, ArkType, and others.

## Install

```bash
npm install padrone zod
```

## Scaffold a New Project

The fastest way to get started is with `padrone init`:

```bash
npx padrone init my-cli
cd my-cli && bun i && bun dev
```

## Quick Start

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('myapp')
  .command('greet', (c) =>
    c
      .arguments(
        z.object({
          names: z.array(z.string()).describe('Names to greet'),
          prefix: z.string().optional().describe('Prefix').meta({ flags: 'p' }),
        }),
        { positional: ['...names'] },
      )
      .action((args) => {
        for (const name of args.names) {
          console.log(`Hello, ${args.prefix ?? ''} ${name}!`);
        }
      }),
  );

program.cli();
```

```bash
myapp greet John Jane -p Mr.
# Hello, Mr. John!
# Hello, Mr. Jane!
```

## What It Does

```typescript
// Multiple ways to run commands
program.cli();                                              // from process.argv
program.eval('greet John --prefix Mr.');                    // from a string
program.run('greet', { names: ['John'], prefix: 'Mr.' });  // typed args, schema defaults applied
program.api().greet({ names: ['John'], prefix: 'Mr.' });   // as a function (returns the result, throws on errors)

// Parse without executing
const { args } = program.parse('greet John --prefix Mr.');

// Interactive REPL
for await (const result of program.repl()) { /* ... */ }

// AI tool for Vercel AI SDK
const tool = program.tool();

// MCP server for AI assistants (Claude, Cursor, etc.) [experimental]
await program.mcp();  // or: myapp mcp

// REST server with OpenAPI docs [experimental]
await program.serve();  // or: myapp serve

// Shell completions
const script = program.completion('zsh');

// Help in multiple formats
program.help('greet');                        // text
program.help('greet', { format: 'json' });   // json, markdown, html, ansi
```

## Features at a Glance

**Arguments** — positional args, variadic args, short flags (`-v`), long aliases (`--dry-run`), auto kebab-case aliases, negatable booleans (`--no-verbose`), custom negation keywords (`--remote` → sets `local` to `false`).

**Env & Config** — load from environment variables with `.extend(padroneEnv(schema))` (or `padroneEnv({ prefix: 'MY_APP' })` for every option, `MY_APP_DB__HOST` for nested ones, `MY_APP_TAGS=a,b` for arrays, `scope: 'command'` for `MY_APP_LIST_LIMIT`) and config files with `.extend(padroneConfig({ files, schema }))` (a script config can export a function, typed with `defineConfig()`; `$production: { ... }` overrides apply by `NODE_ENV`), with `--profile` profiles (`profiles: true`), per-command sections (`serve: { port: 3000 }`, on by default) and a `config get|set|list|edit` command (`command: true`, with `--local`/`--file`, keeping comments). Precedence: CLI > stdin > env > config > defaults.

**Interactive prompts** — auto-prompt for missing fields. Booleans become confirm, enums become select, arrays become multi-select. Actions ask their own questions with `ctx.prompt.text/confirm/select/multiselect/password/group`, which fail fast (or take their `default`) without a terminal.

**Progress indicators** — auto-managed spinners and progress bars with elapsed time and ETA. `.extend(padroneProgress({ message: 'Deploying...', bar: true, time: true, eta: true }))`.

**Extension-first architecture** — most built-in features (help, version, REPL, color, signal handling, auto-output, stdin, config, interactive, suggestions) are implemented as extensions composed via `.extend()`. Any built-in can be disabled or replaced.

**Interceptors** — middleware hooks for 7 phases (start, parse, route, validate, execute, error, shutdown). Onion model with `next()`. Extensions register interceptors under the hood. Create your own with `defineInterceptor()`.

**Composition** — mount programs as subcommands with `.mount()`, override commands with merge semantics.

**Wrapping** *(experimental)* — wrap external CLI tools with `.wrap({ command: 'git', args: ['commit'] })`.

## API

### Builder (define commands)

| Method | What it does |
|--------|-------------|
| `.arguments(schema, meta?)` | Define args with Zod schema, positional config, field metadata |
| `.globalArgs(schema, meta?)` | Define options shared by a command and all its subcommands, merged into their args |
| `.action(handler)` | Set handler `(args, ctx, base?) => result`; `ctx.run(name, args)` runs another command and resolves to its result |
| `.dryRun(handler)` | Add `--dry-run` / `-n`: runs `handler` instead of the action and prints what would change |
| `.hook('preAction' \| 'postAction', handler)` | Run code before / after the action of the command and all its subcommands (ancestors' pre-hooks first, post-hooks last) |
| `.command(name, builder)` | Add subcommand (name or `[name, ...aliases]`); `defineCommand((c) => ...)` types a builder kept in its own file (`defineCommand<Context>()((c) => ...)` with the program's context, `defineCommand<Context, typeof globals>()` with its global args too; `defineCommand().requires<T>()` for context an interceptor provides) |
| `.describe(text)` | Set the description shown in help (shorthand for `.configure({ description })`) |
| `.context(transform?)` | Define typed context or transform inherited context |
| `.mount(name, program, options?)` | Mount another program as subcommand tree |
| `.configure(config)` | Set title, description, version, help customization (`help: { usage, before, after }` or `(info, ctx) => …`), etc. |
| `.extend(padroneEnv(schema))` | Map env vars to args (composable extension) |
| `.extend(padroneConfig({ files, schema }))` | Load args from config files, optionally layered (`merge`, `extends`), with `profiles` and a `config` command (`command`) (composable extension) |
| `.wrap(config)` | Wrap an external CLI tool *(experimental)* |
| `.extend(padroneProgress(config?))` | Auto-managed progress indicator and `progress.tasks()` task lists (extension) |
| `.extend(padroneJson())` | `--json` flag: results and errors as JSON, `--jq` (a lazy jq subset with string interpolation, `@sh`, `range`/`limit`, paths and a step budget) / `--template` to filter and format, `fields` for `--json name,url` (extension) |
| `.extend(padroneFormat())` | `--output`/`-o`: text, json, yaml, csv, tsv or table, with `--columns` / `--sort` / `--no-header`, `columns` labels, `pipedTable: 'tsv'`, `csvLineEnding: 'crlf'`, `sanitize` and `csvFormulaEscape` for untrusted data (extension) |
| `.extend(padroneConfirm())` | Confirm `mutation: true` commands (or `.configure({ confirm })`), skipped with `--yes` or `<PROGRAM>_YES=1`; `nonInteractive` decides without a terminal (extension) |
| `.extend(padroneCredentials())` | Store secrets in the OS keychain (macOS `security`, Linux `secret-tool`) or a `0600` file: `ctx.context.credentials.get/set/delete` (extension) |
| `.intercept(interceptor)` | Register middleware interceptor (use `defineInterceptor()`) |
| `.extend(...extensions)` | Apply build-time extensions in order (bundles of config, commands, interceptors): `.extend(padroneJson(), padroneFormat())` |
| `.runtime(runtime)` | Custom I/O (for non-terminal use) |
| `.extend(padroneUpdateCheck(config?))` | Background version check (extension) |
| `.extend(padroneUpgrade(options?))` | `upgrade` self-update command (extension) |
| `.extend(padroneAliases(options?))` | User-defined command aliases with `$1`/`$@` placeholders, shared with `alias import`/`export` (extension) |
| `.extend(padroneResponseFiles(options?))` | `@file` arguments expand into the file's arguments (extension) |
| `.extend(padroneExternalCommands(options?))` | External subcommands: `my-cli foo` runs `my-cli-foo` from `PATH` (extension) |
| `.extend(padronePlugins(options?))` | Plugins users install at runtime (`plugins install\|uninstall\|list\|link`), loaded at startup (extension) |
| `.async()` | Mark as async validation |

### Program (run commands)

| Method | What it does |
|--------|-------------|
| `.cli(prefs?)` | Entry point — parses `process.argv`, throws on errors. Pass `context` in prefs. |
| `.eval(input, prefs?)` | Parse + validate + execute string, returns errors softly. Pass `context` in prefs. |
| `.run(command, args?, prefs?)` | Run by name with typed args: checked against the schema (defaults applied), without the parse/validate phases or printing. An async action's result is awaited, as in `.eval()`. Args can be left out (or `undefined` / `{}`) when none are required. Pass `context` in prefs (required when the program declares one). |
| `.parse(input?)` | Parse without executing |
| `.api(prefs?)` | Commands as typed functions that return the result and throw on invalid args or a failing action |
| `.repl(options?)` | Interactive REPL session |
| `.help(command?, prefs?)` | Generate help (text, ansi, markdown, html, json) |
| `.tool(prefs?)` | Vercel AI SDK tool definition. Pass `context` in prefs (as for `.serve()` / `.mcp()`). |
| `.mcp(prefs?)` | Start MCP server (HTTP or stdio) *(experimental)* |
| `.serve(prefs?)` | Start REST server with OpenAPI docs *(experimental)* |
| `.completion(shell?)` | Shell completion script |
| `.find(command)` | Look up command by path |
| `.stringify(command?, args?)` | Convert back to CLI string |

### Zod `.meta()` fields

| Field | Example | Purpose |
|-------|---------|---------|
| `description` | `'Output file'` | Help text (same as `.describe()`) |
| `flags` | `'v'` | Single-char short flag (`-v`) |
| `alias` | `'dry-run'` | Multi-char long alias (`--dry-run`) |
| `negative` | `'remote'` | Custom negation keyword for booleans (disables `--no-`) |
| `examples` | `['8080']` | Example values in help |
| `deprecated` | `'Use --debug'` | Deprecation warning |
| `hidden` | `true` | Hide from help |
| `group` | `'Advanced'` | Group in help output |
| `count` | `true` | Count repeated flags into a number (`-vvv` → 3) |
| `variadic` | `true` | Array option taking all following values (`--tag a b c`) |
| `fromFile` | `true` | `@path` reads the value from a file, `-` from stdin (`@@` escapes) |
| `conflicts` | `'json'` | Options that can't be used together with this one |
| `implies` | `{ color: false }` | Values for other options when this one is used |
| `requires` | `'password'` | Options that must be provided along with this one |
| `requiredIf` | `{ format: 'file' }` | Required when other options have these values |
| `requiredUnless` | `['user', 'key']` | Required unless one of these options is provided |
| `sensitive` | `true` | Secret value: masked prompt, no default in help or tool schemas |
| `hint` | `'dir'` | What shell completion offers for the value (`'file'`, `'dir'`, `{ ext: ['json'] }`, `'command'`, `'url'`, `'none'`) |
| `valueName` | `'PATH'` | Value placeholder in help (`--out <PATH>`) |

### Arguments meta (second param of `.arguments()`)

```typescript
.arguments(schema, {
  positional: ['source', '...files', 'dest'],
  interactive: ['name', 'template'],
  optionalInteractive: ['typescript'],
  fields: { verbose: { flags: 'v' } },
  stdin: 'data',     // or { field: 'data', trim: true }; a lone `-` reads stdin too
  autoAlias: true,  // default
})
```

An optional positional before required ones (`['method', 'url']`) only takes a value when they still get one: `http https://x` sets `url`. Object and record options take `key=value` (`-q page=2 -q sort=asc`), JSON or dotted keys (`--db.host x`). Keep a meta apart from the call with `defineArgsMeta(schema, meta)`, which types it against the schema.

## Agent Skill

Give your AI coding agent knowledge of the Padrone API:

```bash
npx skills add gkurt/padrone
```

## Requirements

- Node.js 18+ or Bun
- TypeScript 5.0+ (recommended)
- Zod (or any Standard Schema-compatible library)

## License

[MIT](LICENSE)
