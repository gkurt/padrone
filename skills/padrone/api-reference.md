# Padrone API Reference

## Exports from `'padrone'`

### `createPadrone(name)`

Creates a root program. Returns a `PadroneProgram`.

```ts
const program = createPadrone('mycli');
```

### `createPadroneBuilder(command)`

Creates a builder from an existing `AnyPadroneCommand`. Used for command merging and remounting.

### `asyncSchema(schema)`

Brands a schema as async, causing `parse()` and `cli()` to return Promises.

```ts
import { asyncSchema } from 'padrone';
const schema = asyncSchema(z.object({ name: z.string() }).check(async (v) => { ... }));
```

### Error Classes

#### `PadroneError`

Base error. All Padrone errors extend this.

```ts
new PadroneError(message, {
  exitCode?: number,       // default: 1
  suggestions?: string[],  // actionable hints shown to user
  command?: string,        // command path that produced the error
  phase?: 'parse' | 'validate' | 'execute' | 'config',
  cause?: unknown,
})
```

Properties: `exitCode`, `suggestions`, `command`, `phase`.
Method: `toJSON()` for serialization.

#### `RoutingError extends PadroneError`

Unknown command or routing failure. Phase defaults to `'parse'`.

#### `ValidationError extends PadroneError`

Schema validation failure. Phase defaults to `'validate'`.
Additional property: `issues: readonly { path?: PropertyKey[]; message: string }[]`.

#### `ConfigError extends PadroneError`

Config file loading or validation failure. Phase defaults to `'config'`.

#### `ActionError extends PadroneError`

Throw from action handlers for structured errors. Phase defaults to `'execute'`.

```ts
throw new ActionError('Missing environment', {
  exitCode: 1,
  suggestions: ['Use --env production or --env staging'],
});
```

### Exported Types

```ts
import type {
  PadroneCommand,
  AnyPadroneCommand,
  PadroneProgram,
  AnyPadroneProgram,
  PadroneBuilder,
  PadroneSchema,
  AsyncPadroneSchema,
  PadroneActionContext,
  PadroneInterceptor,
  PadroneExtension,
  PadroneCommandResult,
  PadroneParseResult,
  PadroneErrorOptions,
  PadroneCommandConfig,
  PadroneEvalPreferences,
  PadroneCliPreferences,
  PadroneReplPreferences,
  PadroneRuntime,
  UpdateCheckConfig,
  InferArgsInput,
  InferArgsOutput,
  InferCommand,
} from 'padrone';
```

---

## Builder Methods

All builder methods are immutable — they return a new instance.

### `.arguments(schema?, meta?)`

Defines the arguments schema for a command. Accepts any Standard Schema-compatible schema (Zod, Valibot, ArkType, etc.) directly or a function receiving the parent's schema.

**Schema parameter:**
```ts
// Direct schema
.arguments(z.object({
  name: z.string(),
  count: z.coerce.number().default(1),
}))

// Function-based: extends the parent command's schema (define the parent's schema first for types)
.arguments((parentSchema) => parentSchema.extend({
  verbose: z.boolean().default(false),
}))
```

**Meta parameter:**

```ts
type ArgsMeta = {
  positional?: string[];              // field names; '...name' for variadic
  interactive?: boolean | string[];   // prompt for missing required fields
  optionalInteractive?: boolean | string[]; // prompt for optional fields too
  autoAlias?: boolean;                // auto kebab-case aliases for camelCase (default: true)
  exactlyOne?: string[] | string[][]; // exactly one of these options (several groups as arrays)
  atLeastOne?: string[] | string[][]; // at least one of these options
  stdin?: string | { field: string; trim?: boolean }; // text/lines inferred from the schema; a lone `-` value reads stdin
  fields?: Record<string, {
    flags?: string | string[];        // single-char short flags (-n, -v)
    alias?: string | string[];        // multi-char long aliases (--dry-run)
    description?: string;
    deprecated?: boolean | string;
    hidden?: boolean;
    examples?: unknown[];
    group?: string;
    count?: boolean;                  // -vvv → 3 (number fields)
    variadic?: boolean;               // array: --tag a b c (up to the next option or --)
    conflicts?: string | string[];    // options that can't be combined with this one
    implies?: Record<string, unknown>; // values for other options when this one is used
    requires?: string | string[];     // options that must be provided along with this one
    requiredIf?: Record<string, unknown> | Record<string, unknown>[]; // required when others have these values
    requiredUnless?: string | string[]; // required unless one of these is provided
    sensitive?: boolean;              // secret: masked prompt, hidden help default, writeOnly in tool schemas
    complete?: (ctx) => (string | { value: string; description?: string })[] | { values, directive? }; // shell completion values (padroneCompletion); ctx: { prefix, args, command, field, runtime, context }
    hint?: 'file' | 'dir' | 'url' | 'command' | 'none' | { ext: string[] }; // what completion falls back to
    valueName?: string;               // help placeholder: --out <DIR>
  }>;
};
```

### `.globalArgs(schema, meta?)`

Options accepted by this command and every subcommand below it, before or after the subcommand name. Values are merged into each command's `args` (typed). A subcommand's own field of the same name overrides the global; the function form extends the inherited globals for a subtree.

```ts
createPadrone('app')
  .globalArgs(z.object({ verbose: z.boolean().optional().meta({ flags: 'v' }) }))
  .command('deploy', (c) => c.arguments(z.object({ env: z.string() })).action((args) => args.verbose))
  .command('cloud', (c) => c.globalArgs((inherited) => inherited.extend({ region: z.string().optional() })))
```

`meta`: `{ fields?, autoAlias?, interactive?, optionalInteractive?, exactlyOne?, atLeastOne? }` (interactive prompts for missing globals in the whole subtree and makes it async). Validated separately from `.arguments()`; shown under "Global Options" in help/man/docs; included in completions and MCP/serve input schemas. A command's own `interactive: true` also prompts for missing required globals.

### `.context(transform?)`

Sets or transforms the typed context for this command. Context flows through the command tree — subcommands inherit the parent's context type.

```ts
// Type-only — declare context type without runtime transform
.context<{ db: Database }>()

// With transform — modify inherited context at runtime
.context((parentCtx) => ({ ...parentCtx, logger: createLogger() }))

// Chainable — multiple calls compose transforms
.context<{ db: Database }>()
.context((ctx) => ({ ...ctx, logger: createLogger() }))
```

When used without arguments, `.context<T>()` only changes the TypeScript type. When called with a transform function, the function is applied at runtime when resolving context from root to the target command.

### `.action(handler?)`

Defines the command handler. Called with no args to create a passthrough command (useful for commands that only have subcommands).

```ts
.action((args, ctx, base?) => result)
```

- `args`: Validated output from the schema
- `ctx`: `{ runtime, command, program, progress, context }`
- `base`: Previous handler when overriding an existing command

### `.dryRun(handler)`

Adds `--dry-run` / `-n` to the command. Under that flag `handler(args, ctx)` runs instead of the action (after validation, with the same context) and its return value is printed as the result. Only commands with a dry-run handler accept the flag; elsewhere it's an unknown option. Execute interceptors see `ctx.dryRun`; `padroneConfirm()` skips the prompt; MCP/serve take `dryRun: true`; `parse()` reports `dryRun`.

```ts
.action(async (args) => ({ deleted: await removeFiles(args.paths) }))
.dryRun((args) => ({ deleted: args.paths })) // same type as the action: result type unchanged
```

Return the action's type where possible; a different type widens the result type to a union. Call `.dryRun()` after `.action()` (which sets the result type).

### `.command(name, builderFn?)`

Creates or extends a subcommand.

```ts
// Simple
.command('list', (c) => c.action(() => 'list'))

// With aliases (tuple)
.command(['list', 'ls', 'l'], (c) => c.action(() => 'list'))

// Extending an existing command
.command('list', (c) => c.action((args, ctx, base) => {
  const original = base(args, ctx);
  return `modified: ${original}`;
}))

// Nested subcommands
.command('db', (c) =>
  c.command('migrate', (s) => s.action(() => 'migrated'))
   .command('seed', (s) => s.action(() => 'seeded'))
)
```

### `.mount(name, program, options?)`

Mounts an existing Padrone program as a subcommand tree.

```ts
const admin = createPadrone('admin')
  .command('users', (c) => c.action(() => 'users'))
  .command('roles', (c) => c.action(() => 'roles'));

const app = createPadrone('app')
  .mount('admin', admin)       // app admin users, app admin roles
  .mount(['db', 'd'], dbProgram); // with aliases

// With context transform
const app2 = createPadrone('app')
  .context<{ db: Database }>()
  .mount('admin', admin, {
    context: (appCtx) => ({ db: appCtx.db }),
  });
```

Re-paths all nested commands. Drops the mounted program's version. Preserves interceptors. The optional `{ context }` transform converts the parent's context type into what the mounted program expects.

### `.configure(config)`

```ts
.configure({
  title?: string,
  description?: string,
  version?: string,
  deprecated?: boolean | string,
  hidden?: boolean,
  mutation?: boolean,                 // POST-only in serve, destructiveHint in MCP, needsApproval default in tool()
  // tool() approval; a function gets the validated args (typed when .configure() comes after .arguments())
  needsApproval?: boolean | ((args) => boolean | Promise<boolean>),
  outputSchema?: PadroneSchema,       // result object schema: MCP outputSchema, OpenAPI result (not validated)
  // Positional shell completion (padroneCompletion), like cobra's ValidArgsFunction; a positional field's own `complete` wins
  complete?: (ctx: { prefix, args, command, position, field?, positionals, runtime, context }) =>
    (string | { value, description? })[] | { values, directive?: 'files' | 'dirs' | 'commands' | 'nofiles' | `ext:${string}` },
  // This command only: replace the usage line, add text before/after
  help?: { usage?: string; before?: string; after?: string }
    // Or a function for this command and its subcommands (nearest wins); return HelpInfo or the final string
    | ((info: HelpInfo, ctx: { command, format, detail, render: (info) => string }) => HelpInfo | string),
})
```

### `.intercept(interceptor)`

Registers an interceptor. See [Interceptor System](#interceptor-system).

### `.extend(extension)`

Applies a build-time extension. A `PadroneExtension` is a reusable bundle of configuration, commands, and interceptors.

#### `padroneEnv(schema)` extension

Parses environment variables into argument values. Replaces the former `.env()` builder method.

```ts
import { createPadrone, padroneEnv } from 'padrone';

.extend(padroneEnv(z.object({
  MY_APP_PORT: z.coerce.number(),
  MY_APP_HOST: z.string().optional(),
}).transform((e) => ({
  port: e.MY_APP_PORT,
  host: e.MY_APP_HOST,
}))))

// Or map args to variables directly (coerced by the command schema, shown in help as `Env: …`)
.extend(padroneEnv({ vars: { port: 'MY_APP_PORT', host: ['MY_APP_HOST', 'HOST'] } }))

// Or read every option from MY_APP_* variables (`dryRun` ← MY_APP_DRY_RUN, `db.host` ← MY_APP_DB__HOST), like yargs' .env('MY_APP')
.extend(padroneEnv({ prefix: 'MY_APP' }))
.extend(padroneEnv({ prefix: 'MY_APP', allowEmpty: true })) // MY_APP_NAME= gives '' (by default empty variables are unset)
.extend(padroneEnv({ prefix: 'MY_APP', nestedSeparator: '.' })) // MY_APP_DB.HOST → db.host (default '__')
.extend(padroneEnv({ prefix: 'MY_APP', arraySeparator: ';' })) // MY_APP_TAGS=a;b → ['a', 'b'] (default ','; false keeps one item)
```

Array options split variables on `arraySeparator` (`MY_APP_TAGS=a,b` → `['a', 'b']`, trimmed, empties dropped); `[...]` values are JSON arrays. `.env` files (`modes`, `dir`, …) expand `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `${VAR+alt}`, and `${VAR:?message}`/`${VAR?message}` (a `ConfigError` naming the file and variable when missing).

Built-in commands (`help`, `config`, `serve`, …, or `.configure({ builtin: true })`) get no env values unless `builtins: true`. Validation errors name the variable: `… (from MY_APP_PORT)`.

#### `padroneConfig(options)` extension

Loads arguments from config files. Not included by default — must be explicitly applied via `.extend(padroneConfig(...))`.

```ts
import { createPadrone, padroneConfig } from 'padrone';

.extend(padroneConfig({ files: 'app.config.json' }))
.extend(padroneConfig({ files: ['app.config.json', 'app.config.yaml'], schema: configSchema }))
.extend(padroneConfig({ files: 'app.config.json', disabled: true }))
.extend(padroneConfig({ files: 'app.config.json', flag: false })) // disable --config/-c flag
.extend(padroneConfig({ files: 'app.config.json', inherit: false })) // don't inherit to subcommands
.extend(padroneConfig({ files: 'app.config.json', loadConfig: myLoader })) // custom config loader
.extend(padroneConfig({ files: '.apprc.json', searchParents: true, packageJson: true })) // parent dirs + package.json "<program>" key
.extend(padroneConfig({ files: '.apprc.json', searchParents: 'project' })) // parents up to the nearest .git/package.json dir
.extend(padroneConfig({ files: '.apprc.json', searchParents: true, stopDir: os.homedir() })) // parents up to (and including) a dir
.extend(padroneConfig({ files: 'app.config.ts' })) // export default defineConfig(({ command, env, envName, profile }) => ({ ... }))
.extend(padroneConfig({ files: 'config.json', envName: (env) => env.APP_ENV })) // $<name>/$env.<name> overrides (default NODE_ENV)
.extend(padroneConfig({ files: 'config.json', xdg: true })) // also ~/.config/<program>/
.extend(padroneConfig({ files: 'config.json', profiles: true })) // `profiles.<name>` via --profile, <PROGRAM>_PROFILE or a `profile` key
.extend(padroneConfig({ files: 'config.json', profiles: { remote: true } })) // also let serve/MCP/tool() calls pass --profile
.extend(padroneConfig({ files: 'config.json', sections: true })) // { port: 1, serve: { port: 2 }, db: { migrate: { dryRun: true } } }
.extend(padroneConfig({ command: true })) // `config get|set|unset|list|path|edit` for the user config file (JSON)
```

`command: true` adds a `config` group (a string renames it) and makes `xdg` default to `true` and `files` to `['config.json']`. `config set <key> <value>` (dotted keys for nested values) writes the user config file; the key must be an option of the command, a subcommand or the global args (unless a schema is loose, or matches the `schema` option), and the value is coerced and validated by that option's schema. With `profiles`, the `config` subcommands take `--profile <name>`; all of them take `--local` (the project config in cwd, or in a parent with `searchParents`) or `--file <path>`. `set`/`unset` change just that value, keeping comments in JSON, JSONC and rc files.

Script configs may default-export a function (sync or async) of `PadroneConfigContext` (`{ command, env, envName, profile }`); `defineConfig()` from `'padrone'` types it. `$production: { ... }` and `$env: { staging: { ... } }` override a config's (or profile's) values for the active `envName`; `$` keys are never option values. `--config`/`-c` is listed in help. With `sections: true`, a key naming a subcommand is its section (never an option value), overriding the values above it for that command. Config numbers and booleans are coerced to the option's type (YAML `name: 123` → `"123"`), built-in commands get no config values unless `builtins: true`, and validation errors name the file: `… (from config.json)`. `--profile` is an unknown option for serve/MCP/`tool()` calls unless `profiles: { remote: true }`.

### `.wrap(config)` *(experimental)*

Wraps an external CLI tool.

```ts
.wrap({
  command: string,          // e.g., 'git', 'docker'
  args?: string[],          // fixed args like ['commit']
  positional?: string[],    // positional arg names for the external tool
  inheritStdio?: boolean,   // default: true
  schema?: Schema | (argsSchema) => Schema,  // transform args to external format
  separator?: '--' | false, // '--': positionals after `--` (default false)
  flagStyle?: 'separate' | 'equals', // `--key value` (default) or `--key=value`
})
```

Returns `Promise<WrapResult>` where `WrapResult = { exitCode, stdout?, stderr?, success }`.

### `.runtime(runtime)`

Custom I/O adapter for non-terminal environments.

```ts
.runtime({
  output?: (...args: unknown[]) => void,
  error?: (text: string) => void,
  argv?: () => string[],
  env?: () => Record<string, string | undefined>,
  format?: 'text' | 'ansi' | 'console' | 'markdown' | 'html' | 'json' | 'auto',
  interactive?: 'supported' | 'unsupported' | 'forced' | 'disabled',
  prompt?: (config) => Promise<unknown>,
  readLine?: (prompt: string) => Promise<string | null>,
  terminal?: { columns?, rows?, isTTY?, stderrIsTTY? },  // isTTY: stdout; stderrIsTTY: stderr (log colors)
  setExitCode?: (code: number) => void,  // cli() calls it on error; default sets process.exitCode
  editor?: (text, { extension? }) => Promise<string>,  // $VISUAL/$EDITOR on a temp file
  open?: (target: string) => Promise<void>,            // system default app
  page?: (text, { always?, pager? }) => Promise<void>, // $PAGER when taller than the terminal
})
```

### `padroneUpdateCheck(config?)` extension

Enables background update checking in `cli()`.

```ts
import { padroneUpdateCheck } from 'padrone';

.extend(padroneUpdateCheck({
  packageName?: string,     // defaults to program name
  registry?: 'npm' | string,
  interval?: string,        // '1d', '12h', '30m' (default: '1d')
  cache?: string,           // cache file path (default: update-check.json in program.dirs.cache)
  disableEnvVar?: string,   // env var to disable (default: <NAME>_NO_UPDATE_CHECK)
  updateCommand?: string | ((packageName, latestVersion) => string), // default: `<name> upgrade` with padroneUpgrade(), else `npm update -g <name>`
  shouldNotify?: (info) => boolean, // false suppresses the notice; info: { packageName, current, latest, updateCommand, runtime }
  format?: (info) => string,        // the notice text (also for `version --check`)
}))
```

Never delays the exit: the notice uses the latest version cached by an earlier run, and a stale cache is refreshed in a detached process (in-process on Deno / Node single-executable apps). The old `~/.config/<name>-update-check.json` is moved to the new cache location. Uses the program's `version`, or the version of the package its script belongs to. `packageName`/`registry` default to `padroneUpgrade()`'s. Skipped in CI (`CI` other than `0`/`false`), when stdout isn't a TTY, with `NO_UPDATE_NOTIFIER` or `--no-update-check`. Shows the notice after command output.

### `.async()`

Explicitly marks the command as async. Alternative to `asyncSchema()`.

---

## Program Methods

### `.cli(prefs?)`

CLI entry point. Parses `process.argv`, each entry one token (quoting from the shell is kept). Prints errors and sets the exit code (the error's `exitCode`, or 1) via `runtime.setExitCode`; never throws.

```ts
program.cli();
program.cli({ context: { db } });
program.cli({ context: { db } });  // provide typed context
```

Preferences:
```ts
type PadroneCliPreferences = {
  interactive?: boolean,
  context?: TContext,         // required when context type is not `unknown`
};
```

### `.eval(input, prefs?)`

Parse + validate + execute a command string. Returns issues softly (doesn't throw on validation errors).

```ts
const result = program.eval('greet --name Alice');
const result = program.eval('greet --name Alice', { context: { db } });
if (result.argsResult?.issues) { /* validation failed */ }
```

### `.run(name, args, prefs?)`

Execute a command by name with an args object. Always sync. No schema validation.

```ts
const result = program.run('greet', { name: 'World' });
const result = program.run('db migrate', { name: 'v1' });
const result = program.run('greet', { name: 'World' }, { context: { db } });
```

### `.parse(input?)`

Parse without executing. Returns `{ command, args?, argsResult? }`.

### `.repl(options?)`

Returns `AsyncIterable<PadroneCommandResult>`. Yields results for each executed command.

```ts
for await (const result of program.repl({
  prompt: 'app> ',
  greeting: 'Welcome!',
  hint: 'Type .help for commands',
  scope: 'db',              // start scoped to a subcommand
  spacing: { after: true },
  outputPrefix: '  ',
  completion: true,
  context: { db },          // the context each command receives
  historyFile: true,        // keep history in program.dirs.state/repl_history (or a path)
  historySize: 1000,        // most entries kept (0: none); the file is created with mode 0600
})) {
  // handle each result
}
```

REPL built-in commands: `.help`, `.exit`, `.quit`, `.history`, `.scope <cmd>`, `.scope ..`. A mistyped `.scope` gets "Did you mean", and `help <cmd>` inside a scope is relative to it.

### `.help(command?, prefs?)`

```ts
program.help();                              // root help
program.help('deploy');                      // command help
program.help('deploy', { format: 'json' }); // format: text|ansi|console|markdown|html|json|auto
program.help('deploy', { detail: 'full' }); // detail: minimal|standard|full
```

### `.completion(shell?)`

Returns shell completion script. Auto-detects shell if not specified.

```ts
program.completion('bash');
program.completion('zsh');
program.completion('fish');
program.completion('powershell');
```

With `padroneCompletion()`, `<program> completion <shell> --instructions` prints install instructions instead of the script; `--static` prints the static script (default with `padroneCompletion({ mode: 'static' })`, `--no-static` overrides), `--no-descriptions` leaves descriptions out (`padroneCompletion({ descriptions: false })`), and `--setup` keeps both flags in the installed snippet. `program.completion(shell, { mode, descriptions })` does the same. Completion offers kebab-case option names (as help shows them), short flags for `-`, and leaves out hidden and deprecated commands and options (deprecated ones still complete when nothing else matches).

`help --search <term>` (`-s`) lists commands (by name, aliases, description) and help topics matching every word. Man pages (`generateDocs(program, { format: 'man', date?, section? })`; `padroneMan({ section, dir })` for `man` and `man --setup`, which installs under `$XDG_DATA_HOME/man/man<section>` from the runtime env by default) put the date (`date`, `SOURCE_DATE_EPOCH`, or today) and `<program> <version>` in `.TH`, and link parent/subcommand pages under SEE ALSO.

### `.find(command)`

Returns the command object or `undefined`.

```ts
const cmd = program.find('db migrate');
```

### `.api()`

Type-safe programmatic API. Nested by command tree.

```ts
const api = program.api();
api.greet({ name: 'World' });
api.db.migrate({ name: 'v1' });
```

### `.tool()`

Returns a Vercel AI SDK `Tool` definition.

```ts
import { generateText } from 'ai';
const tool = program.tool();
```

### `.mcp(prefs?)` *(experimental)*

Starts a Model Context Protocol server (2025-11-25 spec). Exposes all commands as MCP tools, except hidden and built-in ones (`builtin: true`).

```ts
// HTTP (default) — Streamable HTTP with session management and SSE support
await program.mcp({ port: 3000, host: '127.0.0.1' });

// stdio — newline-delimited JSON over stdin/stdout
await program.mcp({ transport: 'stdio' });
```

Options: `transport` (`'http'` | `'stdio'`), `port`, `host`, `basePath`, `name`, `version`, `cors` (`string | false`), `maxBodySize` (bytes, default 4 MiB; larger bodies get 413).

Object results are also returned as `structuredContent`; `.configure({ outputSchema })` (an object schema) is advertised as the tool's `outputSchema`. Over HTTP, a request whose `Origin` isn't a loopback origin (`localhost`, `127.0.0.1`, `[::1]`) or the explicitly set `cors` origin gets 403 (so does a non-loopback `Host` when bound to a loopback host), and `DELETE` (session termination) aborts that session's calls in flight.

Also available as a built-in CLI command: `myapp mcp [http|stdio] --port 3000`

### `.serve(prefs?)` *(experimental)*

Starts a REST HTTP server. Each command becomes an endpoint (`users list` → `/users/list`); hidden and built-in commands are left out. Commands with `mutation: true` accept POST only; others accept GET and POST.

```ts
await program.serve({ port: 3000, basePath: '/api/' });
```

Options: `port`, `host`, `basePath`, `cors` (`string | false`; also the one cross-site `Origin` accepted, `'*'` any), `maxBodySize` (bytes, default 4 MiB; 413 `payload_too_large`), `builtins` (`{ health, help, schema, docs }`), `onRequest`, `onError`.

Built-in endpoints: `/_health`, `/_help`, `/_schema`, `/_docs` (Scalar OpenAPI viewer), `/_openapi`.

Responses hold `result`, `output` (printed lines) and `stderr` (what the command wrote to stderr), each left out when empty. Like MCP, a request whose `Origin` isn't loopback, its own host or `cors` gets 403, and so does a non-loopback `Host` when bound to a loopback host. `sensitive` fields (and objects or arrays holding one) are rejected in GET query strings (400) and left out of the OpenAPI GET parameters; a command with a required sensitive field is POST-only in the spec.

Also available as a built-in CLI command: `myapp serve --port 3000`

### `.stringify(command?, args?)`

Converts command and arguments back to a CLI string.

---

## Interceptor System

### defineInterceptor(meta, factory?)

Creates a reusable interceptor with metadata and a factory function. The factory is called fresh per execution, enabling cross-phase state sharing via closures.

```ts
import { defineInterceptor } from 'padrone';

// Two-arg form: metadata + factory
const timer = defineInterceptor({ name: 'timer', order: 10 }, () => {
  let startTime: number;
  return {
    start: (ctx, next) => { startTime = Date.now(); return next(); },
    shutdown: (ctx, next) => { console.log(`${Date.now() - startTime}ms`); return next(); },
  };
});

// Single-arg form with chaining (for typed context)
const withDb = defineInterceptor({ name: 'with-db' })
  .provides<{ db: Database }>()
  .factory(() => ({
    execute: (ctx, next) => next({ context: { ...ctx.context, db: createDb() } }),
  }));
```

**Metadata:** `name` (string), `order` (number, lower = outermost, default: 0), `id` (string, deduplication key — last wins), `disabled` (boolean), `callers` (callers it runs for, e.g. `LOCAL_CALLERS`/`REMOTE_CALLERS`; still counts for `requires`), `on` (event handlers keyed by event id).

**Chaining:** `.provides<T>()` and `.requires<T>(...ids)` for typed context (ids are checked at runtime), `.factory(fn)` to set the factory, `.on(event, handler)` for a typed custom event handler. `.requires()` and `.on()` return a new interceptor (same id, meta and factory); the original is unchanged.

### Custom events

```ts
const deployed = defineEvent<{ env: string; version: string }>('myapp:deployed');
const slack = defineInterceptor({ name: 'slack' }, () => ({})).on(deployed, (payload, ctx) => notify(payload));
// in an action or interceptor phase: runs the handlers on the command chain, in interceptor order
await ctx.emit(deployed, { env, version });
await program.emit(deployed, { env, version }); // outside an execution: root handlers, caller 'run'
```

### PadroneInterceptor Type

A `PadroneInterceptor` can be created with `defineInterceptor()` or as a plain object:

```ts
type PadroneInterceptor = {
  name: string;
  order?: number;
  id?: string;
  disabled?: boolean;
  start?: (ctx: InterceptorStartContext, next: () => T) => T;
  parse?: (ctx: InterceptorParseContext, next: () => InterceptorParseResult) => InterceptorParseResult;
  validate?: (ctx: InterceptorValidateContext, next: () => InterceptorValidateResult) => InterceptorValidateResult;
  execute?: (ctx: InterceptorExecuteContext, next: () => InterceptorExecuteResult) => InterceptorExecuteResult;
  error?: (ctx: InterceptorErrorContext, next: () => InterceptorErrorResult) => InterceptorErrorResult;
  shutdown?: (ctx: InterceptorShutdownContext, next: () => void) => void;
};
```

All handlers can return Promises for async behavior.

### Phase Contexts

**Shared across all phases:**
- `command`: The resolved command
- `context`: The user-provided context (from `cli()`/`eval()`/`run()` prefs)
- `signal`: `AbortSignal` for cancellation (provided by the signal extension)
- `runtime`: The resolved runtime
- `caller`: Invocation method (`'cli'`, `'eval'`, `'run'`, `'repl'`, `'serve'`, `'mcp'`, `'tool'`)
- `emit`: Emit a custom event to the command chain's handlers

**Phase-specific fields:**

| Phase | Extra context fields | `next()` returns |
|---|---|---|
| start | `input`, `program` | Pipeline result |
| parse | `input` | `{ command, rawArgs, positionalArgs }` |
| route | `rawArgs`, `positionalArgs` | `void` |
| validate | `rawArgs` (mutable), `positionalArgs` | `{ args, argsResult }` |
| execute | `args` (mutable) | `{ result }` |
| error | `error` | `{ error?, result? }` |
| shutdown | `error?`, `result?` | `void` |

`next()` accepts optional overrides: `next({ signal, context, runtime, ... })` to modify values for downstream interceptors.

### Phase Execution Rules

| Entry point | Phases run |
|---|---|
| `eval()` / `cli()` | start, parse, route, validate, execute, [error], shutdown |
| `parse()` | parse, validate |
| `run()` | execute only |

- Start, parse use **root interceptors only**
- Route, validate, execute use **collected parent chain** (root outermost, subcommand innermost)
- Error, shutdown run in **two layers**: command-level interceptors first (for route/validate/execute failures), then root-level (for all failures)
- Subcommand interceptors registered via `.intercept()` inside `.command()` apply only to that command

### Ordering

- Lower `order` = outermost (runs first before `next()`, last after)
- Same `order` preserves registration order
- First-registered = outermost by default
- Built-in extension orders: signal (-2000), autoOutput (-1100), color/stdin (-1001), help/version/repl (-1000), interactive (-999), suggestions (-500)
- When multiple interceptors share the same `id`, last one wins (deduplication), also across root and command: the command's replaces the root's for route/validate/execute and for error/shutdown

---

## Testing Utilities (`'padrone/test'`)

### `testCli(program)`

Returns a fluent test builder.

```ts
import { testCli } from 'padrone/test';

const builder = testCli(program);
```

**Builder methods (all chainable):**

| Method | Purpose |
|---|---|
| `.args(input)` | Set CLI input string |
| `.env(vars)` | Set environment variables |
| `.prompt(answers)` | Mock interactive prompt answers |
| `.stdin(data)` | Mock piped stdin |
| `.context(value)` | Context commands receive, as passed to `cli()` |
| `.run(input?)` | Execute and return `TestCliResult` |
| `.repl(inputs)` | Run REPL session with array of inputs |

**`TestCliResult`:**

```ts
{
  command: AnyPadroneCommand,
  args: unknown,
  result: unknown,
  issues: { message: string; path?: PropertyKey[] }[] | undefined,
  stdout: unknown[],   // captured runtime.output() calls
  stderr: string[],    // captured runtime.error() calls
  error?: unknown,     // thrown error (if any)
}
```

**`TestReplResult`:**

```ts
{
  results: { command, args, result, issues }[],
  stdout: unknown[],
  stderr: string[],
}
```

---

## Type Helpers

```ts
import type {
  InferArgsInput,   // Extract input type of a command's args schema
  InferArgsOutput,  // Extract output type of a command's args schema
  InferCommand,     // Get command type by path: InferCommand<typeof program, 'db migrate'>
  InferContext,     // Extract context type: InferContext<typeof program>
} from 'padrone';
```

---

## Key Types Quick Reference

```ts
type PadroneActionContext<TContext = unknown> = {
  runtime: ResolvedPadroneRuntime;
  command: AnyPadroneCommand;
  program: AnyPadroneProgram;
  progress: PadroneProgress;
  context: TContext;
};

type PadroneCommandResult<T> = {
  command: T;
  args?: ArgsOutput;
  argsResult?: StandardSchemaV1.Result<ArgsOutput>;
  result: ActionReturnType;
};

type PadroneParseResult<T> = {
  command: T;
  args?: ArgsOutput;
  argsResult?: StandardSchemaV1.Result<ArgsOutput>;
};

type WrapResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  success: boolean;
};
```
