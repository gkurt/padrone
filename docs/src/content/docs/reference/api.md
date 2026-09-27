---
title: API Reference
description: Complete API reference for Padrone
---

## createPadrone(name)

Creates a new Padrone program with the given name.

```typescript
import { createPadrone } from 'padrone';

const program = createPadrone('myapp');
```

**Parameters:**
- `name` (string): The program name, used in help output and as the root command name

**Returns:** A `PadroneProgram` builder instance

---

## Program Methods

### .configure(config)

Configure program or command properties.

```typescript
program.configure({
  title: 'My Application',
  description: 'A helpful CLI tool',
  version: '1.0.0',
});
```

**Configuration:**
| Property | Type | Description |
|----------|------|-------------|
| `title` | `string` | Display title for help output |
| `description` | `string` | Program/command description |
| `version` | `string` | Version string |
| `deprecated` | `boolean \| string` | Mark as deprecated with optional message |
| `hidden` | `boolean` | Hide from help output |
| `group` | `string` | Group name for organizing in help output |
| `mutation` | `boolean` | Mark as mutation (POST-only in serve, destructiveHint in MCP, defaults needsApproval in tool) |
| `help` | `PadroneHelpConfig \| PadroneHelpTransform` | `{ usage?, before?, after? }` for this command, or `(info, ctx) => HelpInfo \| string` for this command and its subcommands. See [Customizing Help](/padrone/guides/commands-arguments/#customizing-help) |

---

### .runtime(config)

Configure the runtime adapter for I/O abstraction. Allows the CLI framework to work outside of a terminal (e.g., web UIs, chat interfaces, AI agents, testing).

```typescript
program.runtime({
  interactive: true,
  prompt: myCustomPromptFn,
  output: (text) => panel.append(text),
  error: (text) => panel.appendError(text),
  format: 'html',
});
```

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `output` | `(text: string) => void` | `console.log` | Write normal output |
| `error` | `(text: string) => void` | `console.error` | Write error output |
| `argv` | `() => string[]` | `process.argv.slice(2)` | Return raw CLI arguments. Each entry is taken as one token, as the shell split it |
| `env` | `() => Record<string, string \| undefined>` | `process.env` | Return environment variables |
| `format` | `string` | `'auto'` | Default help output format |
| `interactive` | `boolean` | `false` | Whether the runtime supports interactive prompts |
| `prompt` | `(config: InteractivePromptConfig) => Promise<unknown>` | Enquirer (when `interactive: true`) | Custom prompt implementation |
| `progress` | `(message: string, options?: PadroneProgressOptions) => PadroneProgress` | Built-in terminal spinner | Progress indicator factory. See [Progress Indicators](/padrone/guides/progress-indicators/) |
| `terminal` | `{ columns?, rows?, isTTY? }` | From `process.stdout` | Terminal size and whether stdout is a TTY (colors, wrapping, the help pager) |
| `setExitCode` | `(code: number) => void` | Sets `process.exitCode` | Called by `cli()` when a run ends with an error or a signal. Override to capture or ignore it |

Successive `.runtime()` calls merge with previous configuration.

---

### .arguments(schema, meta?)

Define arguments using a Zod schema.

```typescript
program.arguments(
  z.object({
    port: z.number().default(3000).describe('Port number'),
    host: z.string().default('localhost'),
  }),
  {
    positional: ['port'],
    fields: {
      host: { flags: 'h' },
    },
  }
);
```

**Parameters:**
- `schema`: Zod object schema defining the arguments
- `meta` (optional): Additional configuration
  - `positional`: Array of argument names to treat as positional arguments
  - `fields`: Per-argument metadata (`flags`, `alias`, `description`, `examples`, `deprecated`, `hidden`, `group`)
  - `interactive`: `true | string[]` — fields to prompt when missing (see [Interactive Prompting](/padrone/guides/interactive-prompting/))
  - `optionalInteractive`: `true | string[]` — optional fields offered after required prompts
  - `autoAlias`: `boolean` — auto-generate kebab-case aliases for camelCase names (default: `true`)
  - `stdin`: `string | { field, as }` — read from stdin into an argument field

When `interactive` or `optionalInteractive` is set, the command becomes async — `parse()` and `cli()` return Promises.

`schema` can also be a function receiving the parent command's schema, to extend it: `.arguments((parent) => parent.extend({ file: z.string() }))`. To share options with a whole subtree, prefer [`.globalArgs()`](#globalargsschema-meta).

---

### .globalArgs(schema, meta?)

Define options accepted by this command and every subcommand below it, before or after the subcommand name. Their values are merged into each command's `args`.

```typescript
const program = createPadrone('app')
  .globalArgs(z.object({
    verbose: z.boolean().optional().meta({ flags: 'v' }),
    profile: z.string().default('default'),
  }))
  .command('deploy', (c) =>
    c
      .arguments(z.object({ env: z.string() }), { positional: ['env'] })
      .action((args) => args), // { verbose?: boolean; profile: string; env: string }
  )
  // Override: a field with the same name in .arguments() replaces the global for this command
  .command('scale', (c) => c.arguments(z.object({ verbose: z.number().optional() })).action((args) => args))
  // Extend: the function form receives the inherited globals, for this subtree
  .command('cloud', (c) =>
    c.globalArgs((inherited) => inherited.extend({ region: z.string().optional() })).command('up', (u) => u.action((args) => args.region)),
  );
```

**Parameters:**
- `schema`: A schema, or a function receiving the inherited global schema (the nearest ancestor's) and returning a new one
- `meta` (optional): `fields` (per-field `flags`, `alias`, `description`, …), `autoAlias`, and `interactive` / `optionalInteractive` to prompt for missing globals in every command of the subtree (which makes those commands async)

Global args are validated against their own schema, separately from each command's `.arguments()`. They are listed under **Global Options** in help, man pages and generated docs, included in shell completions and in the input schemas of MCP tools and serve endpoints. A command with `interactive: true` also prompts for missing required globals.

---

### .context(transform?)

Set or transform the typed context for this command. Context is a user-defined object that flows through the command tree. Subcommands inherit the parent's context type but can transform it.

```typescript
// Type-only — declare context type without runtime transform
program.context<{ db: Database }>();

// With transform — modify inherited context at runtime
program.context((parentCtx) => ({ ...parentCtx, logger: createLogger() }));

// Chainable — multiple calls compose transforms
program
  .context<{ db: Database }>()
  .context((ctx) => ({ ...ctx, logger: createLogger() }));
```

When called without arguments, `.context<T>()` only changes the TypeScript type. When called with a transform function, the function is applied at runtime to the inherited context as it resolves from root to the target command.

**Returns:** The program builder (chainable)

---

### .action(handler)

Set the handler function for the command.

```typescript
program.action((args, ctx) => {
  console.log('Arguments:', args);
  console.log('Context:', ctx.context);
  return { success: true };
});
```

**Parameters:**
- `handler`: Function receiving `(args, ctx, base)`
  - `args`: Parsed and validated arguments object
  - `ctx`: Action context object containing `runtime`, `command`, `program`, `progress`, and `context` (see below)
  - `base`: Previous handler function (useful when [overriding commands](/padrone/guides/composition/#command-override))

**Action Context (`ctx`):**
| Property | Type | Description |
|----------|------|-------------|
| `runtime` | `ResolvedPadroneRuntime` | The resolved runtime for this command |
| `command` | `PadroneCommand` | The command being executed |
| `program` | `PadroneProgram` | The root program instance |
| `progress` | `PadroneProgress` | Auto-managed progress indicator, or lazy indicator for manual use. See [Progress Indicators](/padrone/guides/progress-indicators/) |
| `context` | `TContext` | User-defined context, resolved through the command parent chain |

**Returns:** The program builder (chainable)

---

### .dryRun(handler)

Give the command a dry run. The command then accepts `--dry-run` / `-n`, and under that flag `handler` runs **instead of** the action (the action never runs), after validation and with the same arguments and context. Return what would change; it's printed like an action's result (JSON under `--json`).

```typescript
program.command('rm', (c) =>
  c
    .configure({ mutation: true })
    .arguments(z.object({ paths: z.string().array() }), { positional: ['...paths'] })
    .dryRun((args) => args.paths.map((path) => `delete ${path}`).join('\n'))
    .action((args) => removeFiles(args.paths)),
);
// files rm a.txt b.txt --dry-run   → delete a.txt / delete b.txt, nothing deleted
```

- Only commands with a dry-run handler accept the flag and show it in help; anywhere else `--dry-run` is an unknown option, so it's never silently ignored. A command's own `dryRun` / `dry-run` option, or its own `-n` flag, takes precedence over the framework's.
- Execute interceptors still run (so context such as a database connection reaches the handler), with `ctx.dryRun` set; `padroneConfirm()` doesn't ask for confirmation in a dry run.
- `parse()` reports `dryRun: true`; `tool()` needs no approval for a dry run; MCP and serve take `dryRun: true` as an argument on these commands.
- The result is typed as the action's, but under `--dry-run` it's the dry-run handler's return value.

---

### padroneEnv(schema)

Extension for parsing environment variables into arguments. The schema validates `process.env` and transforms env var names into argument field names. Imported from `'padrone'`.

```typescript
import { createPadrone, padroneEnv } from 'padrone';

program.extend(
  padroneEnv(
    z.object({
      APP_PORT: z.coerce.number().optional(),
      API_KEY: z.string().optional(),
    }).transform((env) => ({
      port: env.APP_PORT,
      apiKey: env.API_KEY,
    }))
  )
);
```

**Parameters:**
- `schema`: A Standard Schema that validates env vars and transforms them to argument names
- `options.vars`: Map arguments to variables directly, without a schema: `padroneEnv({ vars: { port: 'APP_PORT', token: ['API_TOKEN', 'TOKEN'] } })`. The first variable that is set wins, and values are coerced by the command's schema like CLI input. These variables are shown in help (`Env: APP_PORT`). Can be combined with a schema.
- `options.prefix`: Read every option from a prefixed variable, like yargs' `.env('MY_APP')`: `padroneEnv({ prefix: 'MY_APP' })` reads `--dry-run` / `dryRun` from `MY_APP_DRY_RUN`. Variables named in `vars` take precedence. Shown in help.
- `options.modes`, `local`, `dir`, `override`, `base`: `.env` file loading

Env values are applied after CLI args and stdin, but before config file values. Can be applied at the program level (inherited by all commands) or at the command level.

---

### padroneConfig(options)

Extension for loading arguments from configuration files. Not included by default — must be explicitly applied via `.extend(padroneConfig(...))`. Imported from `'padrone'`.

```typescript
import { createPadrone, padroneConfig } from 'padrone';

// Simple: config file with matching argument names
program.extend(padroneConfig({ files: 'app.config.json' }));

// With schema: transform config keys to argument names
program.extend(
  padroneConfig({
    files: 'app.config.json',
    schema: z.object({
      port: z.number().optional(),
      apiKey: z.string().optional(),
    }),
  })
);

// Multiple file paths (first found wins)
program.extend(padroneConfig({ files: ['app.config.json', '.apprc'] }));

// Look in parent directories too, and in the "myapp" key of package.json
program.extend(padroneConfig({ files: ['.myapprc.json'], searchParents: true, packageJson: 'myapp' }));

// Layered: ~/.config/myapp/config.json < project root config < cwd config (objects merge, arrays are replaced)
program.extend(padroneConfig({ files: ['config.json'], xdg: true, searchParents: true, merge: true }));
// A config file can build on others: { "extends": ["./base.json", "@company/cli-config"], "port": 8080 }

// Disable config loading
program.extend(padroneConfig({ files: 'app.config.json', disabled: true }));
```

**Options:**
| Property | Type | Description |
|----------|------|-------------|
| `files` | `string \| string[]` | Config file path(s). When multiple paths are provided, the first existing file is used |
| `schema` | `StandardSchema` | Optional schema to validate/transform config values |
| `disabled` | `boolean` | Disable config file loading |
| `flag` | `boolean` | Enable/disable the `--config`/`-c` flag (default: `true`) |
| `inherit` | `boolean` | Whether the config interceptor inherits to subcommands (default: `true`) |
| `xdg` | `boolean \| string` | Also search the user config directory (`~/.config/<app>`, `~/Library/Application Support/<app>`, `%APPDATA%\<app>`) after cwd. `true` uses the program name |
| `searchParents` | `boolean` | Also search the parent directories of cwd, nearest first, like cosmiconfig (default: `false`) |
| `packageJson` | `boolean \| string` | Read config from a `package.json` key in each searched directory, after its config files. `true` uses the program name (default: `false`) |
| `merge` | `boolean` | Merge every config found instead of using the first: the user config directory, then the searched directories from the farthest to cwd, each overriding the last. Objects merge key by key, arrays are replaced. A `--config` file is still used alone (default: `false`) |
| `extends` | `boolean` | Follow `extends` keys (a path relative to the file, a package name, or a list) to load base configs first (default: `true`) |
| `loadConfig` | `(files: string \| string[], xdgAppName?: string, search?: { parents?, packageJsonKey?, merge?, extends? }) => Record<string, unknown> \| undefined \| Promise<...>` | Custom config loader function. Replaces the built-in JSON/YAML/TOML loader |

Config values have the lowest precedence: CLI > stdin > env > config. Not included by default — must be explicitly applied via `.extend(padroneConfig(...))`. Can be applied at the program level (inherited by all commands) or at the command level.

---

### .wrap(config) *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

Wrap an external CLI tool with optional schema transformation in the config object.

The config can include a `schema` property that transforms command arguments to external CLI arguments. The schema's **input type** should match the current command's arguments (from `.arguments()`), and its **output type** defines the arguments expected by the external command.

```typescript
// Define command arguments first
program
  .command('commit', (c) =>
    c
      .arguments(
        z.object({
          message: z.string(),
          all: z.boolean().optional(),
        }),
        {
          positional: ['message'],
        }
      )
      .wrap({
        command: 'git',
        args: ['commit'],
        positional: ['m'],  // Positional for external command
        schema: z.object({
          message: z.string(),
          all: z.boolean().optional(),
        }).transform((args) => ({
          m: args.message,  // Map 'message' to 'm' flag
          a: args.all,      // Map 'all' to 'a' flag
        })),
      })
  );
```

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `command` | `string` | required | The external command to execute (e.g., 'git', 'docker', 'npm') |
| `args` | `string[]` | `[]` | Fixed arguments that always precede the arguments (e.g., `['commit']` for 'git commit') |
| `positional` | `string[]` | command's positional | Positional argument configuration for the external command. Defaults to the wrapping command's positional config. |
| `inheritStdio` | `boolean` | `true` | Whether to inherit stdio streams from the parent process. Set to `false` to capture stdout/stderr |
| `schema` | `Schema \| (cmdSchema) => Schema` | identity | Optional transformation schema. If not provided, command arguments are passed through as-is. |

**Returns:** The program builder with an action that executes the external command

**Result Type:** `WrapResult` (when `inheritStdio` is `false`)
```typescript
type WrapResult = {
  exitCode: number;      // The exit code of the process
  stdout?: string;       // Standard output (only if inheritStdio is false)
  stderr?: string;       // Standard error (only if inheritStdio is false)
  success: boolean;      // Whether the process exited successfully (exit code 0)
}
```

**Examples:**

```typescript
// No transformation - pass arguments through as-is
program
  .command('echo', (c) =>
    c
      .arguments(z.object({ message: z.string() }))
      .wrap({
        command: 'echo',
      })
  );

// Function-based schema for type safety
program
  .command('run', (c) =>
    c
      .arguments(
        z.object({
          image: z.string(),
          detach: z.boolean().optional(),
          interactive: z.boolean().optional(),
        })
      )
      .wrap({
        command: 'docker',
        args: ['run'],
        positional: ['image'],
        schema: (cmdSchema) => cmdSchema.transform(args => ({
          image: args.image,
          d: args.detach,
          i: args.interactive,
        })),
      })
  );

// Usage: program.run('run', { image: 'nginx', detach: true })
// After transform: { image: 'nginx', d: true }
// Executes: docker run --d nginx
```

```typescript
// Direct schema with transform
program
  .command('install', (c) =>
    c
      .arguments(
        z.object({
          packages: z.string().array(),
          saveDev: z.boolean().optional(),
        }),
        {
          positional: ['...packages'],
        }
      )
      .wrap({
        command: 'npm',
        args: ['install'],
        positional: ['...packages'],
        inheritStdio: false,  // Capture output
        schema: z.object({
          packages: z.string().array(),
          saveDev: z.boolean().optional(),
        }).transform(args => ({
          packages: args.packages,
          'save-dev': args.saveDev,  // Map to exact flag name
        })),
      })
  );

// Usage:
const result = await program.run('install', {
  packages: ['react', 'react-dom'],
  saveDev: true,
});
console.log(result.result.stdout);  // npm install output
console.log(result.result.exitCode);  // 0 if successful
```

**Type Safety:**

The `.wrap()` method maintains full type safety:
- Input schema matches command arguments from `.arguments()`
- Output schema defines external CLI arguments structure
- Return type is inferred as `Promise<WrapResult>`
- TypeScript enforces correct types when calling `.run()` or `.cli()`

**How it works:**

1. **Schema Transformation**: The wrap schema transforms command arguments to external CLI arguments
   - Input: Parsed command arguments (from `.arguments()`)
   - Output: External program arguments

2. **Arguments → CLI Arguments**: Padrone converts transformed arguments to CLI arguments:
   - Boolean arguments: `{ verbose: true }` → `--verbose`
   - String/Number arguments: `{ port: 3000 }` → `--port 3000`
   - Array arguments: `{ files: ['a', 'b'] }` → `--files a --files b`
   - Positional arguments: Follow the order specified in `config.positional`
   - Argument keys are used as-is with `--` prefix

3. **Process Execution**: Uses `spawn` to execute the external command with the generated arguments

---

### padroneProgress(config?)

Extension that adds an auto-managed progress indicator to the command (`import { padroneProgress } from 'padrone'`, applied with `.extend(padroneProgress(...))`). The indicator starts before validation and is automatically stopped on success or failure. See the [Progress Indicators guide](/padrone/guides/progress-indicators/) for full details.

```typescript
// Simple message
.extend(padroneProgress('Deploying...'))

// Full config
.extend(padroneProgress({
  message: {
    validation: 'Validating...',
    progress: 'Deploying...',
    success: (result) => `Deployed v${result.version}`,
    error: 'Deploy failed',
  },
  spinner: 'line',
  bar: true,
  time: true,
  eta: true,
}))

// Dynamic indicator icons
.extend(padroneProgress({
  message: {
    progress: 'Running...',
    success: (result) => ({ message: 'All passed', indicator: '🎉' }),
  },
}))
```

**Parameters:**
- `config` (optional): `string | PadroneProgressConfig`
  - `string` — custom progress message for all states
  - Object — full control with messages, visual options, and renderer

**Object fields:**
| Property | Type | Description |
|----------|------|-------------|
| `message` | `string \| PadroneProgressMessages` | Per-phase messages. String sets the `progress` message. Object has `validation`, `progress`, `success`, `error` |
| `spinner` | `PadroneSpinnerConfig` | Spinner preset, `true` (always show), `false` (disable), or `{ frames, interval, show }` |
| `bar` | `boolean \| PadroneBarConfig` | `true` for defaults, or `{ width, filled, empty, animation, show }` for customization |
| `time` | `boolean` | Show elapsed time (`⏱ M:SS`). Can also be toggled via `update({ time: true/false })` |
| `eta` | `boolean` | Show estimated time remaining (`ETA M:SS`). Requires numeric `update()` calls |
| `renderer` | `PadroneProgressRenderer` | Custom renderer factory (defaults to built-in terminal renderer) |
| `taskRenderer` | `PadroneTaskListRenderer` | Renderer for `progress.tasks()` lists (defaults to `createTerminalTaskList`) |

`PadroneProgressMessages` fields: `validation` (string), `progress` (string), `success` (string/null/callback), `error` (string/null/callback). Callbacks can return a string, `null` (suppress), or `{ message, indicator }` for per-call icon customization. Messages can also be provided from context via `progressConfig.message` — command-level fields take precedence.

The indicator is available in actions as `ctx.context.progress`. `ctx.context.progress.tasks(tasks, options?)` runs a list of tasks drawn as a live list, like listr2: each task is `{ title, task: (t) => ..., skip? }`, where `t` has `update(message)`, `setTitle(title)`, `skip(reason?)`, `tasks(subtasks)` and `signal`. Options: `concurrent` (`true` or a limit) and `exitOnError` (default `true`). Serve, MCP and `tool()` calls get a no-op indicator, and their tasks run without drawing.

---

### .intercept(interceptor)

Register an interceptor for middleware-style interception of command phases. See the [Interceptors & Extensions guide](/padrone/guides/plugins/) for full details.

```typescript
import { defineInterceptor } from 'padrone';

const logger = defineInterceptor({ name: 'logger' }, () => ({
  execute: (ctx, next) => {
    console.log(`Running: ${ctx.command.name}`);
    const result = next();
    console.log(`Done: ${ctx.command.name}`);
    return result;
  },
}));

program.intercept(logger);
```

**Parameters:**
- `interceptor`: A `PadroneInterceptor` — either created with `defineInterceptor()` or a plain object with `name`, optional `order`/`id`/`disabled`, and phase handlers (`start`, `parse`, `route`, `validate`, `execute`, `error`, `shutdown`)

**Returns:** New builder with the interceptor added (immutable)

Available on both programs and subcommand builders. Program-level interceptors apply as outermost wrappers; subcommand interceptors compose as inner layers.

---

### .extend(extension)

Apply a build-time extension. An extension is a function that receives the builder and returns a modified builder. Extensions can add commands, arguments, interceptors, and configuration.

```typescript
import { createPadrone, padroneEnv, padroneConfig, padroneProgress } from 'padrone';

const program = createPadrone('myapp')
  .extend(padroneEnv(envSchema))
  .extend(padroneConfig({ files: 'config.json' }))
  .command('deploy', (c) =>
    c
      .extend(padroneProgress('Deploying...'))
      .action(async () => { /* ... */ })
  );
```

**Parameters:**
- `extension`: A function `(builder) => builder` — receives the current builder and returns a modified builder

**Returns:** The modified builder returned by the extension

Extensions compose naturally — chain multiple `.extend()` calls to layer functionality. Most of Padrone's built-in features are implemented as extensions applied automatically by `createPadrone()`. See the [Interceptors & Extensions guide](/padrone/guides/plugins/) for the full list.

---

### padroneUpdateCheck(config?)

Extension that enables background version checking against a package registry in `cli()`. The program checks for a newer version in the background and displays a notification after command output.

```typescript
import { padroneUpdateCheck } from 'padrone';

program.extend(padroneUpdateCheck({
  registry: 'npm',       // or custom URL
  interval: '1d',        // check at most once per day
  cache: '~/.myapp-update',
  updateCommand: (name, latest) => `bun add -g ${name}@${latest}`,
}));
```

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `packageName` | `string` | auto-detected | Package name to check |
| `registry` | `string` | `'npm'` | Registry URL or `'npm'` shorthand |
| `interval` | `string` | `'1d'` | Check interval (e.g., `'1d'`, `'12h'`, `'30m'`, `'1w'`) |
| `cache` | `string` | auto | Path to cache file for last check timestamp |
| `disableEnvVar` | `string` | auto | Env var name that disables update checking |
| `updateCommand` | `string \| (packageName, latestVersion) => string` | `npm update -g <name>` | Command suggested in the notice |

Non-blocking (the registry request times out after 3 seconds) and caches check timestamps. Skipped in CI, when stdout isn't a TTY, when `NO_UPDATE_NOTIFIER` or the `disableEnvVar` variable is set, and with `--no-update-check`.

---

### .async()

Explicitly mark a command as using async validation. When async, `parse()` and `cli()` return Promises.

```typescript
program.command('create', (c) =>
  c
    .arguments(z.object({ name: z.string() }).check(async (ctx) => { /* ... */ }))
    .async()
    .action((args) => args.name)
);
```

This is an alternative to `asyncSchema()` when you can't brand the schema itself.

**Returns:** The program builder (chainable)

---

### .command(name, builder)

Add a subcommand. Re-registering a command with the same name merges the definitions — see [Program Composition](/padrone/guides/composition/) for details.

```typescript
program.command('serve', (c) =>
  c
    .arguments(schema)
    .action(handler)
);

// With aliases
program.command(['serve', 's'], (c) =>
  c.arguments(schema).action(handler)
);
```

**Parameters:**
- `name`: Command name string, or `[name, ...aliases]` array for aliases
- `builder`: Function receiving a command builder, returns configured command

---

### .cli(prefs?)

Execute the program as a CLI. This is the main process entry point that reads from `process.argv` (each entry one token, as the shell split it) and exits non-zero when the run fails.

```typescript
// Parse process.argv
program.cli();

// With preferences
program.cli({ interactive: true });

// With context
program.cli({ context: { db, logger } });

// Start a REPL session from CLI
// myapp --repl
// myapp --repl db
```

**Parameters:**
- `prefs` (optional): `PadroneCliPreferences`
  - `interactive`: Override interactive prompting (`true` = force, `false` = suppress, `undefined` = inherit from runtime)
  - `runtime`: Override runtime configuration (including `argv`)
  - `context`: User-defined context object. Required when the program has a non-`unknown` context type.
  - `signal`: `AbortSignal` that cancels the run. Actions and interceptors see it through `ctx.signal`, together with process signals.

**Returns:** `PadroneCommandResult` with `command`, `args`, `argsResult`, and `result`. Returns a `Promise` when the matched command is async.

**Errors:** Routing and validation errors are printed with a `--help` hint (by the help extension); any other error, from whichever phase threw it (an interceptor's `route`, a config file, the action), is printed by the auto-output extension.

**Exit code:** When the run ends with an error (routing, validation, or a thrown action — including one that only surfaces on `drain()`), `cli()` sets the exit code through `runtime.setExitCode` to the error's `exitCode` (`PadroneError` carries one; 130 for SIGINT), or `1`. It uses `process.exitCode` rather than `process.exit()`, so output still flushes. Successful runs, `--help` and `--version` leave it at `0`.

**Note:** Interactive prompting only triggers in `cli()` and `eval()`, not in `parse()` or `run()`. When a command has interactive meta and the runtime has `interactive: true`, missing field values are prompted before validation. The `--repl` flag starts a REPL session (optionally scoped to a command).

---

### .eval(input, preferences?)

Parse, validate, and execute a command string with soft error handling. Returns a result with issues instead of throwing on validation errors.

```typescript
const result = await program.eval('serve --port 8080');
const result = await program.eval('serve --port 8080', { context: { db } });

if (result.argsResult?.issues) {
  console.error('Validation errors:', result.argsResult.issues);
} else {
  console.log('Result:', result.result);
}
```

**Parameters:**
- `input`: Command string to parse and execute
- `preferences` (optional): `{ interactive?: boolean, context?: TContext, runtime?: PadroneRuntime, signal?: AbortSignal }` — override interactive prompting and the runtime, provide context, and cancel the run with `signal` (e.g. `AbortSignal.timeout(5000)`)

**Returns:** `PadroneCommandResult` with `command`, `args`, `argsResult`, and `result`. Returns a `Promise` when the matched command is async.

**Difference from `cli()`:** `eval()` is designed for programmatic use (REPL, AI tools, testing). It uses soft error handling — validation failures are returned as `argsResult.issues` rather than thrown. `cli()` is the process entry point that prints errors, sets a non-zero exit code on failure, and reads from `process.argv`.

---

### .run(command, args, prefs?)

Run a command programmatically with typed arguments.

```typescript
const result = program.run('serve', {
  port: 8080,
  host: 'localhost',
});

// With context
const result = program.run('serve', { port: 8080 }, { context: { db } });
```

**Parameters:**
- `command`: Command path (e.g., `'serve'` or `'db migrate up'`)
- `args`: Arguments object matching the command's schema
- `prefs` (optional): `{ context?: TContext, signal?: AbortSignal }` — provide context and a cancellation signal

**Returns:** The action handler's return value

---

### .parse(input?)

Parse input without executing the action.

```typescript
const result = program.parse('serve --port 8080');

console.log(result.command);     // PadroneCommand for 'serve'
console.log(result.args);        // { port: 8080, host: 'localhost' }
console.log(result.argsResult);  // Standard Schema validation result
```

**Parameters:**
- `input` (optional): String or string array to parse

**Returns:** `PadroneParseResult` with `command`, `args`, and `argsResult` properties. Returns a `Promise` when the matched command is async.

---

### .stringify(command?, args?)

Convert a command and arguments back to a CLI string.

```typescript
const cliString = program.stringify('serve', { port: 8080 });
// 'serve --port 8080'
```

**Parameters:**
- `command` (optional): Command name
- `args` (optional): Arguments object

**Returns:** CLI string representation

---

### .api()

Generate a typed API object for programmatic use.

```typescript
const api = program.api();

// Call commands as methods
api.serve({ port: 8080 });
api.db.migrate.up({ steps: 1 });
```

**Returns:** Typed API object with methods for each command

---

### .help(command?, preferences?)

Generate help text.

```typescript
// Program help
console.log(program.help());

// Command help
console.log(program.help('serve'));

// Different formats
program.help('', { format: 'markdown' });
```

**Parameters:**
- `command` (optional): Command to get help for
- `preferences` (optional): `{ format: 'text' | 'ansi' | 'console' | 'markdown' | 'html' | 'json', detail: 'minimal' | 'standard' | 'full', theme: ColorTheme | ColorConfig }`

**Returns:** Help text string (or object for JSON format)

---

### .mcp(prefs?) *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

Start a Model Context Protocol server, exposing all commands as MCP tools.

```typescript
// Start with defaults (HTTP on port 3000)
await program.mcp();

// With options
await program.mcp({
  transport: 'stdio',
  port: 8080,
  host: '0.0.0.0',
  cors: 'https://example.com',
});
```

**Parameters:**
- `prefs` (optional): `PadroneMcpPreferences`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `transport` | `'http' \| 'stdio'` | `'http'` | Transport mode |
| `port` | `number` | `3000` | HTTP port |
| `host` | `string` | `'127.0.0.1'` | HTTP host |
| `basePath` | `string` | `'/mcp'` | HTTP endpoint path |
| `name` | `string` | program name | Server name reported to clients |
| `version` | `string` | program version | Server version reported to clients |
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable |

**Returns:** `Promise<void>` (resolves when the server shuts down)

The HTTP transport implements the [2025-11-25 Streamable HTTP spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) with session management, SSE support (via `Accept: text/event-stream`), and CORS headers.

Also available as a built-in CLI command: `myapp mcp [http|stdio] --port 3000 --host 0.0.0.0`

---

### .serve(prefs?) *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

Start a REST HTTP server that exposes commands as endpoints. Each command becomes a route (`users list` → `/users/list`). Commands with `mutation: true` only accept POST; others accept both GET and POST.

```typescript
// Start with defaults (port 3000)
await program.serve();

// With options
await program.serve({
  port: 8080,
  host: '0.0.0.0',
  basePath: '/api/',
  cors: 'https://example.com',
});
```

**Parameters:**
- `prefs` (optional): `PadroneServePreferences`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | `number` | `3000` | HTTP port |
| `host` | `string` | `'127.0.0.1'` | HTTP host |
| `basePath` | `string` | `'/'` | Base path prefix for all routes |
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable |
| `builtins.health` | `boolean` | `true` | Enable `GET /_health` endpoint |
| `builtins.help` | `boolean` | `true` | Enable `GET /_help` and `GET /_help/:command` |
| `builtins.schema` | `boolean` | `true` | Enable `GET /_schema` and `GET /_schema/:command` |
| `builtins.docs` | `boolean` | `true` | Enable `GET /_docs` (Scalar OpenAPI viewer) and `GET /_openapi` |
| `onRequest` | `(req: Request) => Response \| void \| Promise<...>` | — | Hook to run before each request (auth, rate-limiting) |
| `onError` | `(error: unknown, req: Request) => Response` | — | Custom error response handler |

**Returns:** `Promise<void>` (resolves when the server shuts down)

**Request handling:**
- **GET requests**: Query parameters are converted to CLI flags → `eval()`
- **POST requests**: JSON body is serialized to CLI flags → `eval()`
- **Mutation commands**: Only accept POST (returns 405 for GET)

**Built-in endpoints:**
| Endpoint | Description |
|----------|-------------|
| `GET /_health` | Returns `{ status: "ok" }` |
| `GET /_help` | Program help (JSON or markdown based on Accept header) |
| `GET /_help/:path` | Command-specific help |
| `GET /_schema` | JSON Schema map of all commands |
| `GET /_schema/:path` | JSON Schema for a single command |
| `GET /_docs` | Scalar OpenAPI docs viewer |
| `GET /_openapi` | Raw OpenAPI 3.1.0 JSON spec |

Also available as a built-in CLI command: `myapp serve --port 3000 --host 0.0.0.0 --base-path /api/`

---

### .tool()

Generate a Vercel AI SDK compatible tool.

```typescript
import { streamText } from 'ai';

const tool = program.tool();

await streamText({
  model: yourModel,
  tools: { myapp: tool },
});
```

**Returns:** AI SDK tool object

---

### .mount(name, program, options?)

Mount an existing Padrone program as a subcommand. All nested commands are recursively re-pathed. See the [Program Composition guide](/padrone/guides/composition/) for full details.

```typescript
const users = createPadrone('users')
  .command('list', (c) => c.action(() => 'listing users'))
  .command('create', (c) =>
    c.arguments(z.object({ name: z.string() })).action((args) => args.name)
  );

const app = createPadrone('app')
  .mount('users', users);

// With aliases
const app2 = createPadrone('app')
  .mount(['users', 'u'], users);

// With context transform
const app3 = createPadrone('app')
  .context<{ db: Database }>()
  .mount('users', users, {
    context: (appCtx) => ({ db: appCtx.db }),
  });
```

**Parameters:**
- `name`: Command name string, or `[name, ...aliases]` array for aliases
- `program`: A Padrone program to mount
- `options` (optional): `{ context?: (parentCtx) => mountedCtx }` — transform the parent's context into what the mounted program expects

**Returns:** New builder with the mounted program

---

### .repl(options?)

Start an interactive REPL session. Returns an `AsyncIterable` that yields a result for each executed command. See the [REPL guide](/padrone/guides/repl/) for full details.

```typescript
for await (const result of program.repl()) {
  console.log(result.command.name, result.result);
}

// With options
for await (const result of program.repl({
  prompt: 'app> ',
  scope: 'db',
  greeting: 'Welcome!',
})) {
  // ...
}
```

**Parameters:**
- `options` (optional): REPL preferences
  - `prompt`: Custom prompt string or function
  - `greeting`: Welcome message (`false` to suppress)
  - `hint`: Hint text below greeting (`false` to suppress)
  - `history`: Initial history entries
  - `completion`: Enable tab completion (default: `true`)
  - `spacing`: Output separators (before/after command output)
  - `outputPrefix`: Prefix for output lines
  - `scope`: Start scoped to a command path (strongly typed)

**Returns:** `AsyncIterable<PadroneCommandResult>`

---

### .find(command)

Find a command by name.

```typescript
const cmd = program.find('db migrate up');
if (cmd) {
  console.log(cmd.name);  // 'up'
}
```

**Parameters:**
- `command`: Command path string

**Returns:** Command instance or undefined

---

### .completion(shell?)

Generate shell completion script.

```typescript
const script = program.completion('bash');
// Or: 'zsh', 'fish', 'powershell'
```

**Parameters:**
- `shell` (optional): Target shell. Auto-detected if omitted.

**Returns:** Shell completion script string

With the `padroneCompletion()` extension (`padrone/completion`) the scripts are dynamic: they call `<program> __complete <words>` for per-command subcommands, options and values, including `complete` callbacks on fields. Without it, they're static lists of every command and option.

---

## Color Themes

Padrone supports color themes for ANSI help output. Themes control the colors used for different semantic roles in help text.

### Built-in Themes

Pass a theme name to `.help()` or configure it on the program:

```typescript
// Use a built-in theme
program.help('', { theme: 'ocean' });
```

| Theme | Description |
|-------|-------------|
| `'default'` | Cyan commands, green args, yellow types |
| `'ocean'` | Blue commands, cyan args, green types |
| `'warm'` | Yellow commands, red args, magenta types |
| `'monochrome'` | Bold/underline/dim only, no colors |

### Custom Color Config

Pass a `ColorConfig` object to customize individual roles:

```typescript
import type { ColorConfig } from 'padrone';

const myTheme: ColorConfig = {
  command: ['blue', 'bold'],
  arg: ['green'],
  type: ['yellow'],
  description: ['dim'],
  label: ['bold'],
  meta: ['gray'],
  example: ['underline'],
  exampleValue: ['italic'],
  deprecated: ['strikethrough', 'gray'],
};

program.help('', { theme: myTheme });
```

### Color Roles

| Role | Description |
|------|-------------|
| `command` | Command names |
| `arg` | Argument/option names |
| `type` | Type annotations (string, number, etc.) |
| `description` | Description text |
| `label` | Section labels (Arguments, Commands, etc.) |
| `meta` | Metadata (defaults, choices, etc.) |
| `example` | Example labels |
| `exampleValue` | Example values |
| `deprecated` | Deprecated items |

### Available ANSI Styles

Each role accepts an array of styles: `'bold'`, `'dim'`, `'italic'`, `'underline'`, `'strikethrough'`, `'red'`, `'green'`, `'yellow'`, `'blue'`, `'magenta'`, `'cyan'`, `'white'`, `'gray'`.

### Disabling Colors

Use the `--color` global flag, or the `NO_COLOR` / `FORCE_COLOR` environment variables:

```bash
# Disable colors
myapp --help --no-color
myapp --help --color=never   # or --color=false

# Force colors, e.g. when piping to a pager
myapp --help --color | less -R   # or --color=always
myapp --help --color=ocean

# Detect from the terminal (the default)
myapp --help --color=auto

# Or via environment (FORCE_COLOR wins over NO_COLOR; FORCE_COLOR=0 disables)
NO_COLOR=1 myapp --help
FORCE_COLOR=1 myapp --help
```

The flag switches the `auto` format to `text` or `ansi`; an explicit non-ANSI `format` (such as `json`) is kept.

---

## Stdin Configuration

Configure stdin reading in the `.arguments()` meta to pipe data into argument fields.

### Basic Usage

```typescript
// Read all stdin as text into 'data' field
.arguments(
  z.object({ data: z.string() }),
  { stdin: 'data' }
)
```

```bash
echo "hello" | myapp
# args.data = "hello"
```

### Reading Lines

When the target field is an array type, stdin is automatically read line-by-line:

```typescript
// Read stdin line-by-line into an array (inferred from schema)
.arguments(
  z.object({ lines: z.array(z.string()) }),
  { stdin: 'lines' }
)
```

```bash
cat urls.txt | myapp
# args.lines = ["https://...", "https://...", ...]
```

### Streaming with `asyncStream`

For large inputs, you can receive stdin as an `AsyncIterable` instead of buffering everything into memory. Each line is yielded lazily as it arrives.

```typescript
import { zodAsyncStream } from 'padrone/zod';

// String stream — yields raw lines
.arguments(
  z.object({ lines: zodAsyncStream() }),
  { stdin: 'lines' }
)
.action(async ({ lines }) => {
  for await (const line of lines) {
    process.stdout.write(transform(line) + '\n');
  }
})
```

```typescript
import { zodAsyncStream, jsonCodec } from 'padrone/zod';

// Typed stream — each line validated through a JSON codec
const recordSchema = z.object({ name: z.string() });

.arguments(
  z.object({ records: zodAsyncStream(jsonCodec(recordSchema)) }),
  { stdin: 'records' }
)
.action(async ({ records }) => {
  for await (const record of records) {
    console.log(record.name);
  }
})
```

The `jsonCodec` helper wraps a schema to automatically `JSON.parse` each line before validation. If the input is already an object (not a string), it passes through as-is.

When no stdin is piped, the stream yields nothing (empty iterable). If an item fails validation, the stream throws immediately.

#### Generic `asyncStream` (non-Zod)

For other Standard Schema libraries, use `asyncStream()` from `padrone` directly with `.meta()`:

```typescript
import { asyncStream } from 'padrone';

// String stream (no item validation)
z.custom<AsyncIterable<string>>().meta(asyncStream())

// With item validation (item schema must handle JSON parsing itself)
z.custom<AsyncIterable<MyType>>().meta(asyncStream(myItemSchema))
```

### Stdin Behavior

- Only reads when stdin is piped (not a TTY) and the target field wasn't provided via CLI flags or positionally
- A `stdin` field makes the command async (like interactive fields): `eval()`/`parse()` return a Promise, no `.async()` needed
- Read mode is inferred from the schema: `string` fields read all stdin as text, `string[]` fields read line-by-line, `zodAsyncStream()`/`asyncStream()` fields stream lazily
- Resolution priority: CLI args > stdin > env vars > config files > defaults

### Runtime Stdin API

The runtime exposes stdin through the `PadroneRuntime.stdin` interface:

```typescript
type StdinConfig = {
  isTTY: boolean;
  text(): Promise<string>;
  lines(): AsyncIterable<string>;
};
```

This is automatically handled when using `stdin` in arguments meta. For custom runtimes (testing, web), override `runtime.stdin` to provide mock data.

---

## defineInterceptor(meta, factory?)

Create a reusable interceptor with metadata and a factory function. The factory is called fresh per execution, enabling cross-phase state sharing via closures.

```typescript
import { defineInterceptor } from 'padrone';

// Two-arg form: metadata + factory
const timer = defineInterceptor({ name: 'timer', order: 10 }, () => {
  let startTime: number;
  return {
    start: (ctx, next) => {
      startTime = Date.now();
      return next();
    },
    shutdown: (ctx, next) => {
      console.log(`Completed in ${Date.now() - startTime}ms`);
      return next();
    },
  };
});

// Single-arg form with chaining (for typed context)
const withDb = defineInterceptor({ name: 'with-db' })
  .provides<{ db: Database }>()
  .factory(() => ({
    execute: (ctx, next) => {
      return next({ context: { ...ctx.context, db: createDb() } });
    },
  }));
```

**Metadata:**
| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Display name |
| `order` | `number` | Execution order — lower = outermost (default: `0`) |
| `id` | `string` | Deduplication key — when multiple interceptors share an `id`, the last one wins |
| `disabled` | `boolean` | Skip this interceptor during execution |

**Chaining methods (single-arg form):**
- `.provides<T>()` — Declare what this interceptor adds to the context (type-level only)
- `.requires<T>()` — Declare what this interceptor expects on the context (type-level only)
- `.factory(fn)` — Set the factory function

**Returns:** A `PadroneInterceptor` — pass to `.intercept()` or use within an extension.

---

## Built-in Extension Exports

These extensions are available as named exports from `'padrone'`:

| Export | Purpose |
|--------|---------|
| `padroneEnv(schema?, options?)` | Parse environment variables into args (`vars` maps args to variables, `prefix` reads every option from `PREFIX_*`; both shown in help) |
| `padroneConfig(options)` | Load args from config files (layered with `merge` and `extends`) |
| `padroneProgress(config)` | Auto-managed progress indicators, and task lists with `progress.tasks()` |
| `padroneLogger(options)` | Structured logging with levels (`--verbose` (repeatable), `--quiet`, `--log-level`; `shortFlags: true` adds `-v`/`-vv`/`-q`; `env` reads the level from a variable). Logs go to stderr with colored level labels; `stdout: true` sends `trace`/`debug`/`info` to stdout, and `format: 'json'` writes JSON lines (`logger.info({ userId }, 'signed in')` adds fields) |
| `padroneJson(options?)` | `--json` flag: prints the result as JSON (iterator items one per line). `--jq <expr>` filters it (a built-in jq subset, or pass `jq: (input, expr) => outputs` for a full implementation) and `--template '{{.name}}'` formats it; both imply `--json`. Errors in `cli()` print as `{ "error": { ... } }` on stdout under JSON output |
| `padroneConfirm(options?)` | Asks before running `mutation: true` commands in `cli()`/REPL; `--yes`/`-y` skips it, and without a terminal the command fails unless `--yes` is given. Options: `message`, `when`, `flags` |
| `padroneTiming()` | Execution timing |
| `padroneUpdateCheck(config)` | Background version checking |

The following extensions live in their own subpath imports to keep optional dependencies and large transitive surfaces out of the main bundle:

| Export | Import from | Purpose |
|--------|-------------|---------|
| `padroneInk()` | `'padrone/ink'` | React (Ink) rendering support; serve, MCP and `tool()` calls get the first frame as text |
| `padroneMcp()` | `'padrone/mcp'` | MCP server integration |
| `padroneServe()` | `'padrone/serve'` | REST server integration |
| `padroneTracing(config)` | `'padrone/tracing'` | OpenTelemetry tracing. Pass `api: { context, trace }` from `@opentelemetry/api` to parent child spans to the command's span |
| `padroneCompletion()` | `'padrone/completion'` | Shell completion generation, with dynamic per-command completion (`__complete`) and field `complete` callbacks |
| `padroneMan()` | `'padrone/man'` | Man page generation |

The following extensions are applied automatically by `createPadrone()` and can be disabled via `builtins`:

| Export | Builtin key | Purpose |
|--------|-------------|---------|
| `padroneHelp(options?)` | `help` | Help command and `--help` flag. Options: `showHelpOnError` prints the full help after errors; `flags` renames the help flags (default `['help', 'h']`); `pager: true` shows help taller than the terminal through `$PAGER` or `less -FRX` in `cli()` (a string sets the fallback pager; `--no-pager` / `--pager` per run) |
| `padroneVersion(options?)` | `version` | Version command and `--version` flag (on any command; single-character flags on the root only). `version --verbose` adds the runtime, platform, architecture and shell (an object under `--json`). Options: `flags` renames the version flags (default `['version', 'v', 'V']`); `info` adds fields to `--verbose` |
| `padroneRepl()` | `repl` | REPL command and `--repl` flag |
| `padroneColor()` | `color` | `--color`/`--no-color` support |
| `padroneSuggestions()` | `suggestions` | "Did you mean?" suggestions |
| `padroneSignalHandling()` | `signal` | Signal handling and AbortSignal |
| `padroneAutoOutput(options?)` | `autoOutput` | Auto-print results and errors. `errorStack: true` (or the `DEBUG` env variable) prints stack traces with their `cause` chain |
| `padroneStdin()` | `stdin` | Stdin piping support |
| `padroneInteractive()` | `interactive` | Interactive prompting |

---

## Type Exports

Padrone exports these TypeScript types:

```typescript
import type {
  // Core types
  PadroneProgram,
  PadroneCommand,
  PadroneBuilder,
  PadroneExtension,
  PadroneParseResult,
  PadroneCommandResult,
  PadroneAPI,
  PadroneSchema,
  AsyncPadroneSchema,
  PadroneCommandConfig,

  // Interceptor types
  PadroneInterceptor,
  InterceptorBaseContext,
  InterceptorStartContext,
  InterceptorParseContext,
  InterceptorParseResult,
  InterceptorValidateContext,
  InterceptorValidateResult,
  InterceptorExecuteContext,
  InterceptorExecuteResult,
  InterceptorErrorContext,
  InterceptorErrorResult,
  InterceptorShutdownContext,

  // Runtime types
  PadroneRuntime,
  ResolvedPadroneRuntime,
  InteractivePromptConfig,
  PadroneReplPreferences,
  PadroneEvalPreferences,
  PadroneMcpPreferences,
  PadroneServePreferences,

  // Progress types
  PadroneProgress,
  PadroneProgressConfig,
  PadroneProgressMessage,
  PadroneProgressOptions,
  PadroneSpinnerConfig,
  PadroneSpinnerPreset,

  // Type utilities
  MaybePromise,
  OrAsync,
  OrAsyncMeta,
  HasInteractive,
  IsAsyncSchema,

  // Inference helpers
  InferArgsInput,
  InferArgsOutput,
  InferCommand,
  InferContext,
} from 'padrone';
```
