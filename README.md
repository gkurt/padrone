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
program.run('greet', { names: ['John'], prefix: 'Mr.' });  // typed args
program.api().greet({ names: ['John'], prefix: 'Mr.' });   // as a function

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

**Env & Config** — load from environment variables with `.extend(padroneEnv(schema))` (or `padroneEnv({ prefix: 'MY_APP' })` for every option) and config files with `.extend(padroneConfig({ files, schema }))`. Precedence: CLI > stdin > env > config > defaults.

**Interactive prompts** — auto-prompt for missing fields. Booleans become confirm, enums become select, arrays become multi-select.

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
| `.action(handler)` | Set handler `(args, ctx, base?) => result` |
| `.dryRun(handler)` | Add `--dry-run` / `-n`: runs `handler` instead of the action and prints what would change |
| `.command(name, builder)` | Add subcommand (name or `[name, ...aliases]`) |
| `.context(transform?)` | Define typed context or transform inherited context |
| `.mount(name, program, options?)` | Mount another program as subcommand tree |
| `.configure(config)` | Set title, description, version, help customization (`help: { usage, before, after }` or `(info, ctx) => …`), etc. |
| `.extend(padroneEnv(schema))` | Map env vars to args (composable extension) |
| `.extend(padroneConfig({ files, schema }))` | Load args from config files, optionally layered (`merge`, `extends`) (composable extension) |
| `.wrap(config)` | Wrap an external CLI tool *(experimental)* |
| `.extend(padroneProgress(config?))` | Auto-managed progress indicator and `progress.tasks()` task lists (extension) |
| `.extend(padroneJson())` | `--json` flag: results and errors as JSON, `--jq` / `--template` to filter and format, `fields` for `--json name,url` (extension) |
| `.extend(padroneFormat())` | `--output`/`-o`: text, json, yaml, csv, tsv or table, with `--columns` / `--sort` / `--no-header` (extension) |
| `.extend(padroneConfirm())` | Confirm `mutation: true` commands, skipped with `--yes` (extension) |
| `.intercept(interceptor)` | Register middleware interceptor (use `defineInterceptor()`) |
| `.extend(extension)` | Apply a build-time extension (bundle of config, commands, interceptors) |
| `.runtime(runtime)` | Custom I/O (for non-terminal use) |
| `.extend(padroneUpdateCheck(config?))` | Background version check (extension) |
| `.extend(padroneUpgrade(options?))` | `upgrade` self-update command (extension) |
| `.extend(padroneAliases(options?))` | User-defined command aliases (extension) |
| `.async()` | Mark as async validation |

### Program (run commands)

| Method | What it does |
|--------|-------------|
| `.cli(prefs?)` | Entry point — parses `process.argv`, throws on errors. Pass `context` in prefs. |
| `.eval(input, prefs?)` | Parse + validate + execute string, returns errors softly. Pass `context` in prefs. |
| `.run(command, args, prefs?)` | Run by name with typed args (no validation). Pass `context` in prefs. |
| `.parse(input?)` | Parse without executing |
| `.api()` | Generate typed function API |
| `.repl(options?)` | Interactive REPL session |
| `.help(command?, prefs?)` | Generate help (text, ansi, markdown, html, json) |
| `.tool()` | Vercel AI SDK tool definition |
| `.mcp(prefs?)` | Start MCP server (HTTP or stdio) *(experimental)* |
| `.serve(prefs?)` | Start REST server with OpenAPI docs *(experimental)* |
| `.completion(shell?)` | Shell completion script |
| `.find(command)` | Look up command by path |
| `.stringify(command?, args?)` | Convert back to CLI string |

### Zod `.meta()` fields

| Field | Example | Purpose |
|-------|---------|---------|
| `flags` | `'v'` | Single-char short flag (`-v`) |
| `alias` | `'dry-run'` | Multi-char long alias (`--dry-run`) |
| `negative` | `'remote'` | Custom negation keyword for booleans (disables `--no-`) |
| `examples` | `['8080']` | Example values in help |
| `deprecated` | `'Use --debug'` | Deprecation warning |
| `hidden` | `true` | Hide from help |
| `group` | `'Advanced'` | Group in help output |
| `count` | `true` | Count repeated flags into a number (`-vvv` → 3) |
| `variadic` | `true` | Array option taking all following values (`--tag a b c`) |
| `conflicts` | `'json'` | Options that can't be used together with this one |
| `implies` | `{ color: false }` | Values for other options when this one is used |

### Arguments meta (second param of `.arguments()`)

```typescript
.arguments(schema, {
  positional: ['source', '...files', 'dest'],
  interactive: ['name', 'template'],
  optionalInteractive: ['typescript'],
  fields: { verbose: { flags: 'v' } },
  stdin: 'data',
  autoAlias: true,  // default
})
```

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
