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
| `needsApproval` | `boolean \| (args) => boolean \| Promise<boolean>` | Whether `tool()` asks for approval before running the command. A function gets the validated args (call `.configure()` after `.arguments()` for them to be typed); with invalid args approval is asked. Defaults to `mutation`; dry runs never need approval |
| `confirm` | `boolean \| string \| (args) => string` | Whether `padroneConfirm()` asks before running the command, overriding its `when` (by default, `mutation` commands ask): `false` never asks, `true` asks the default question, a string or a function of the validated args is the question |
| `outputSchema` | `PadroneSchema` | Schema of the object the action returns: MCP's tool `outputSchema` (object schemas only) and the OpenAPI `result`. Not validated at runtime |
| `builtin` | `boolean` | Mark a command an extension adds for the program itself (like the built-in `help`, `config` or `serve`): `padroneConfig()` and `padroneEnv()` don't fill its options or its subcommands' unless their `builtins: true` |
| `expose` | `boolean \| PadroneCaller[]` | Which callers may run the command and its subcommands (a subcommand's own `expose` wins): `true` any (default), `false` local ones only (`cli`, `eval`, `run`, `repl`), or the callers allowed (`['cli', 'mcp']`). `serve()`/`mcp()` don't list a command they can't run, and running it from another caller fails (`"x" is only available on the command line`). Built-in commands default to `false`, except `help`, `version` and `repl` |
| `help` | `PadroneHelpConfig \| PadroneHelpTransform` | `{ usage?, before?, after? }` for this command, or `(info, ctx) => HelpInfo \| string` for this command and its subcommands. See [Customizing Help](/padrone/guides/commands-arguments/#customizing-help) |
| `complete` | `(ctx) => values \| { values, directive? }` (or a Promise) | Shell completion for the command's positionals (needs `padroneCompletion()`): called with `position`, `field`, `positionals`, `prefix`, `args`, `runtime` and `context`. A positional field's own `complete` wins. See [Command-level completion](/padrone/reference/args-meta/#command-level-completion) |

---

### .runtime(config)

Configure the runtime adapter for I/O abstraction. Allows the CLI framework to work outside of a terminal (e.g., web UIs, chat interfaces, AI agents, testing).

```typescript
program.runtime({
  interactive: 'supported',
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
| `interactive` | `'supported' \| 'unsupported' \| 'forced' \| 'disabled'` | auto (`'disabled'` in CI (`CI` set to anything but `false`/`0`) or when stdin or stdout isn't a terminal, else `'supported'`) | Whether prompts can be shown. `'unsupported'` can't be overridden; `-i`/`--interactive` and `cli()` preferences override the others (`'forced'` prompts even for given values) |
| `prompt` | `(config: InteractivePromptConfig) => Promise<unknown>` | Enquirer | Custom prompt implementation. Text answers are coerced like CLI input (`'3'` for a number field, `'a, b'` for an array) |
| `progress` | `(message: string, options?: PadroneProgressOptions) => PadroneProgress` | Built-in terminal spinner | Progress indicator factory. See [Progress Indicators](/padrone/guides/progress-indicators/) |
| `terminal` | `{ columns?, rows?, isTTY?, stderrIsTTY? }` | From `process.stdout` / `process.stderr` | Terminal size, whether stdout is a TTY (colors, wrapping, the help pager), and whether stderr is (colored log lines; falls back to `isTTY`) |
| `setExitCode` | `(code: number) => void` | Sets `process.exitCode` | Called by `cli()` when a run ends with an error or a signal. Override to capture or ignore it |
| `editor` | `(text, { extension? }) => Promise<string>` | `$VISUAL` / `$EDITOR` / `vi` on a temp file | Open text in the user's editor and resolve with what they saved, like `git commit` |
| `open` | `(target: string) => Promise<void>` | `open` / `xdg-open` / `cmd /c start` | Open a URL or file with the system's default app (on Windows, spaces and cmd metacharacters in the target are escaped) |
| `page` | `(text, { always?, pager? }) => Promise<void>` | `$PAGER` / `less -FRX` | Show text through a pager when it's taller than the terminal (or `always`), otherwise print it with `output`. Call it as `ctx.runtime.page(text)` |

In an action, use them through `ctx.runtime`:

```typescript
.command('commit', (c) =>
  c.async().action(async (_args, ctx) => {
    const message = await ctx.runtime.editor('# Describe your change\n', { extension: '.md' });
    await ctx.runtime.page(renderLog());       // long output through the pager
    await ctx.runtime.open('https://example.com/pr/1');
  }),
)
```

`padroneProgress()` hides its indicator while a prompt, the editor or the pager is open.

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
  - `stdin`: `string | { field, trim }` — read from stdin into an argument field (see [Stdin Configuration](#stdin-configuration))

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
| `prompt` | `PadronePrompt` | Prompts asked through `runtime.prompt`: `text`, `password`, `confirm`, `select`, `multiselect`, `group` and `available`. See [ctx.prompt](#ctxprompt) |

**Returns:** The program builder (chainable)

#### ctx.prompt

| Method | Resolves with | Options |
|--------|---------------|---------|
| `text(message \| options)` | `string` | `message`, `name`, `default` (a blank answer takes it), `validate(value) => error \| undefined` (asks again) |
| `password(message \| options)` | `string` | `message`, `name`, `validate`; masked, never prefilled |
| `confirm(message \| options)` | `boolean` | `message`, `name`, `default` |
| `select(options)` | the chosen value | `message`, `name`, `choices` (values or `{ value, label?, hint? }`), `default` |
| `multiselect(options)` | the chosen values | `message`, `name`, `choices`, `default` (array), `required` (at least one) |
| `group(steps)` | `{ [key]: answer }` | `{ key: ({ results }) => answer }`, run in order; `results` holds the earlier answers, `undefined` skips a step, and questions without a `name` are named after the step's key. Steps that read `results` infer as `unknown`: pass the type, `group<{ … }>(…)` |

- `name` is what `runtime.prompt` receives as `config.name` (and what `testCli().prompt({ … })` answers by); it defaults to the group step's key, else the message.
- Cancelling (Ctrl+C, Esc) throws a `PromptCancelledError` (exit code 130; `isPromptCancel(err)`); an empty answer is `''`. A custom `runtime.prompt` cancels by resolving with `PROMPT_CANCEL` or throwing a `PromptCancelledError`.
- Without an interactive terminal (CI, piped stdin, `--no-interactive`, `interactive: 'disabled'`/`'unsupported'`) or for `serve`/`mcp`/`tool` calls, prompts return their `default` without asking, or throw a `PromptUnavailableError`. `available` says whether they'd ask.
- Interceptors build the same object with `createPrompt(ctx)` from any phase context.

---

### .dryRun(handler)

Give the command a dry run. The command then accepts `--dry-run` / `-n`, and under that flag `handler` runs **instead of** the action (the action never runs), after validation and with the same arguments and context. Return what would change; it's printed like an action's result (JSON under `--json`).

```typescript
program.command('rm', (c) =>
  c
    .configure({ mutation: true })
    .arguments(z.object({ paths: z.string().array() }), { positional: ['...paths'] })
    .action(async (args) => ({ deleted: await removeFiles(args.paths) }))
    // Same shape as the action's result: what would be deleted
    .dryRun((args) => ({ deleted: args.paths })),
);
// files rm a.txt b.txt --dry-run   → { deleted: ['a.txt', 'b.txt'] }, nothing deleted
```

- Only commands with a dry-run handler accept the flag and show it in help; anywhere else `--dry-run` is an unknown option, so it's never silently ignored. A command's own `dryRun` / `dry-run` option, or its own `-n` flag, takes precedence over the framework's.
- Execute interceptors still run (so context such as a database connection reaches the handler), with `ctx.dryRun` set; `padroneConfirm()` doesn't ask for confirmation in a dry run.
- `parse()` reports `dryRun: true`; `tool()` needs no approval for a dry run; MCP and serve take `dryRun: true` as an argument on these commands.
- Types: ideally the handler returns the action's type, so callers handle one shape and the result type stays the same. A different type extends the command's result type to a union (`.action(() => 1).dryRun(() => 'would')` gives `number | string`). Call `.dryRun()` after `.action()`, since `.action()` sets the result type.

---

### .hook(name, handler)

Run code before or after the action of this command **and every subcommand below it**, like cobra's `PersistentPreRun` / `PersistentPostRun` or commander's `hook('preAction')`:

```typescript
const program = createPadrone('my-cli')
  .globalArgs(z.object({ verbose: z.boolean().optional() }))
  .hook('preAction', (ctx) => {
    if (ctx.args.verbose) enableDebugLogs();
  })
  .hook('postAction', (ctx, result) => {
    ctx.runtime.error(`${ctx.command.path} finished`);
  })
  .command('db', (db) =>
    db
      .hook('preAction', async (ctx) => {
        await connect(ctx.context);
      })
      .command('migrate', (c) => c.action(() => migrate())),
  );
// my-cli db migrate --verbose → root preAction, db preAction, action, db postAction, root postAction
```

- `preAction` runs after validation (and after execute interceptors such as `padroneConfirm()`), right before the action; `postAction` runs after the action succeeds, with its result (awaited when it's a promise). Neither runs when validation fails, and `postAction` doesn't run when the action (or a `preAction`) throws.
- An ancestor's `preAction` runs before a descendant's, and its `postAction` after. Several hooks on one command run in the order they were added.
- Handlers get the action's context (`command`, `runtime`, `context`, `signal`, `caller`, `auth`, `program`, `emit`) plus `args` and `dryRun`. On a command with subcommands, `command`, `args` and `context` are the running subcommand's; they're typed as the command's own, which its [global args](#globalargsschema-meta) always match.
- A hook can be async: the action waits for it and the run's result is a promise, as with an async action. Sync hooks keep a sync command sync.
- Hooks are execute-phase interceptors (innermost, order `10000`), so they also run for dry runs (`ctx.dryRun`) and `run()`, but not for what a [`commandNotFound`](#commandnotfound) handler runs.

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
- `options.vars`: Map arguments to variables directly, without a schema: `padroneEnv({ vars: { port: 'APP_PORT', token: ['API_TOKEN', 'TOKEN'] } })`. The first variable that is set wins, and values are coerced by the command's schema like CLI input; a dotted key sets a nested value (`{ 'db.host': 'DB_HOST' }`). These variables are shown in help (`Env: APP_PORT`). Can be combined with a schema.
- `options.prefix`: Read every option from a prefixed variable, like yargs' `.env('MY_APP')`: `padroneEnv({ prefix: 'MY_APP' })` reads `--dry-run` / `dryRun` from `MY_APP_DRY_RUN`, and a double underscore reaches into objects like viper and .NET (`MY_APP_DB__HOST` → `db.host`, `MY_APP_DB__MAX_CONNS` → `db.maxConns`). Variables named in `vars` take precedence. Shown in help.
- `options.nestedSeparator`: What separates the keys of a nested value in a prefixed variable name, in place of `__` (`nestedSeparator: '.'` reads `MY_APP_DB.HOST`) (default: `'__'`)
- `options.arraySeparator`: What splits a variable for an array option into items, like viper's string slices: `MY_APP_TAGS=a,b` gives `['a', 'b']`, `MY_APP_PORTS=80,443` gives `[80, 443]` for a number array. Items are trimmed and empty ones dropped; a value in brackets is read as a JSON array (`MY_APP_TAGS='["a,b", "c"]'`), and arrays of objects always take JSON. `false` keeps the value as one item. Applies to `vars`, `prefix` and `.env` variables named like options, not to what an env schema returns (default: `','`)
- `options.allowEmpty`: Read variables set to an empty string (`APP_PORT=`) as empty values. By default they count as unset, like viper, so an exported but empty variable doesn't fail validation or override a config value (default: `false`)
- `options.builtins`: Also fill the options of built-in commands (`help`, `version`, `config`, `serve`, …, anything marked `builtin: true`); by default `APP_KEY` doesn't fill `config get`'s `key` (default: `false`)
- `options.modes`, `local`, `dir`, `override`, `base`: `.env` file loading. Later files win, then `$VAR` / `${VAR}` references expand against the merged values and the process env (which wins unless `override`); single-quoted values aren't expanded. In an unquoted value, `#` after a space or tab starts a comment, and a quote that's never closed is read as an unquoted value. References take the shell's operators, like dotenv-expand:

  | Syntax | Gives |
  |--------|-------|
  | `${VAR:-default}` / `${VAR-default}` | `default` when `VAR` is unset or empty / unset |
  | `${VAR:+alt}` / `${VAR+alt}` | `alt` when `VAR` is set and non-empty / set, else `""` |
  | `${VAR:?message}` / `${VAR?message}` | `VAR`, or a `ConfigError` naming the file, the variable and `message` when `VAR` is unset or empty / unset: `.env: DATABASE_URL needs DB_HOST: set it in .env.local` |

  Defaults, alternatives and messages are expanded too (`${A:+--host=${HOST}}`). A value the process environment overrides isn't checked

Env values are applied after CLI args and stdin, but before config file values. A validation error about a value from a variable names it: `port: Invalid input: expected number, received string (from APP_PORT)`. Can be applied at the program level (inherited by all commands) or at the command level.

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

// Multiple file paths (first found wins); files without an extension are JSON, comments and trailing commas allowed
program.extend(padroneConfig({ files: ['app.config.json', '.apprc'] }));

// Look in parent directories too, and in the "myapp" key of package.json
program.extend(padroneConfig({ files: ['.myapprc.json'], searchParents: true, packageJson: 'myapp' }));
// ...but not above the project root (the nearest directory with .git or package.json), or above a directory
program.extend(padroneConfig({ files: ['.myapprc.json'], searchParents: 'project' }));
program.extend(padroneConfig({ files: ['.myapprc.json'], searchParents: true, stopDir: os.homedir() }));

// A script config can export a function (sync or async) of the command, env, envName and profile
// myapp.config.ts: export default defineConfig(({ command, envName }) => ({ port: envName === 'production' ? 80 : 3000 }));
program.extend(padroneConfig({ files: ['myapp.config.ts', 'myapp.config.json'] }));

// Per-environment overrides, like c12: { "port": 3000, "$production": { "port": 80 }, "$env": { "staging": { "port": 8080 } } }
// apply for NODE_ENV=production / staging (or `envName`)
program.extend(padroneConfig({ files: ['config.json'], envName: (env) => env.APP_ENV }));

// Layered: ~/.config/myapp/config.json < project root config < cwd config (objects merge, arrays are replaced)
program.extend(padroneConfig({ files: ['config.json'], xdg: true, searchParents: true, merge: true }));
// A config file can build on others: { "extends": ["./base.json", "@company/cli-config"], "port": 8080 }

// Profiles: { "port": 3000, "profiles": { "prod": { "port": 80 } } } — `--profile prod` or MYAPP_PROFILE=prod
program.extend(padroneConfig({ files: ['config.json'], profiles: true }));

// Per-command sections: { "port": 8080, "serve": { "port": 3000 }, "db": { "migrate": { "dryRun": true } } }
program.extend(padroneConfig({ files: ['config.json'], sections: true }));

// A `config` command for the user config file: myapp config set port 8080, config get port, config list, config edit
program.extend(padroneConfig({ command: true }));

// Disable config loading
program.extend(padroneConfig({ files: 'app.config.json', disabled: true }));
```

**Options:**
| Property | Type | Description |
|----------|------|-------------|
| `files` | `string \| string[]` | Config file path(s). When multiple paths are provided, the first existing file is used. An empty file, or one with only comments, is an empty config |
| `schema` | `StandardSchema` | Optional schema to validate/transform config values |
| `disabled` | `boolean` | Disable config file loading |
| `flag` | `boolean` | Enable/disable the `--config`/`-c` flag, listed in help (default: `true`). Serve, MCP and `tool()` calls can't use it: for them it's an unknown option |
| `inherit` | `boolean` | Whether the config interceptor inherits to subcommands (default: `true`) |
| `xdg` | `boolean \| string` | Also search the user config directory (`~/.config/<app>`, `~/Library/Application Support/<app>`, `%APPDATA%\<app>`) after cwd. `true` uses the program name |
| `searchParents` | `boolean \| 'project'` | Also search the parent directories of cwd, nearest first, like cosmiconfig: `true` up to the filesystem root (or `stopDir`), `'project'` up to the nearest directory with a `.git` (directory or file) or `package.json`, inclusive, like cosmiconfig's `searchStrategy: 'project'`; outside a project `'project'` searches only cwd (default: `false`) |
| `stopDir` | `string` | The last directory `searchParents` searches (inclusive), relative to cwd, like cosmiconfig's `stopDir`. When cwd isn't inside it, the search goes on to the root |
| `envName` | `string \| false \| (env) => string \| undefined` | The environment name for per-environment overrides, like c12's: `$<name>: { ... }`, then `$env: { <name>: { ... } }`, override the config's top-level values (and inside a profile, the profile's). Keys starting with `$` are never option values. `false` ignores the overrides (default: the `NODE_ENV` variable, from `.env` files too) |
| `packageJson` | `boolean \| string` | Read config from a `package.json` key in each searched directory, after its config files. `true` uses the program name (default: `false`) |
| `merge` | `boolean` | Merge every config found instead of using the first: the user config directory, then the searched directories from the farthest to cwd, each overriding the last. Objects merge key by key, arrays are replaced. A `--config` file is still used alone (default: `false`) |
| `extends` | `boolean` | Follow `extends` keys (a path relative to the file, a package name, or a list) to load base configs first; only a script config (`.js`, `.ts`, …) can extend a script (default: `true`) |
| `profiles` | `boolean \| { flag?: string; env?: string; remote?: boolean }` | Named value sets: `profiles.<name>` in a config overrides its top-level values when selected by `--profile <name>`, the `<PROGRAM>_PROFILE` env variable, or a top-level `profile` key (in that order). An unknown profile is a `ConfigError` listing the available ones. `flag`/`env` rename the flag and the variable. Like `--config`, the flag is an unknown option for serve, MCP and `tool()` calls unless `remote: true` (the variable and the `profile` key still apply) (default: `false`) |
| `sections` | `boolean` | Per-command sections, like viper and cobra: a key that names a subcommand (`"serve": { "port": 3000 }`, nested for deeper commands: `"db": { "migrate": { ... } }`) holds values for that command and its subcommands, overriding the ones above it. With sections on, such a key is always a section, never an option value (put a `serve` command's `db` option inside `"serve": { "db": ... }`). Profiles can hold sections too (default: `false`) |
| `builtins` | `boolean` | Also fill the options of built-in commands (`help`, `version`, `serve`, `config`, …, anything marked `builtin: true`); by default a config `port` doesn't feed `serve --port` (default: `false`) |
| `command` | `boolean \| string` | Add a command group that manages the user config file (`true` names it `config`). Also makes `xdg` default to `true` and `files` to `['config.json']` (default: `false`) |
| `loadConfig` | `(files: string \| string[], xdgAppName?: string, search?: { parents?, stopDir?, packageJsonKey?, merge?, extends?, env? }) => Record<string, unknown> \| undefined \| Promise<...>` | Custom config loader function. Replaces the built-in JSON/YAML/TOML loader (its data still gets `profiles`, `$<envName>` overrides and `sections` applied) |

**Function configs.** A script config (`.js`, `.mjs`, `.ts`, …) may default-export a function, like vite's and c12's, called on every run with a `PadroneConfigContext` and returning the values (or a promise of them):

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string` | The command that runs, as its path (`'db migrate'`; `''` for the program itself) |
| `env` | `Record<string, string \| undefined>` | The environment variables, with the ones `padroneEnv()` loaded from `.env` files |
| `envName` | `string \| undefined` | The environment name (`envName`, `NODE_ENV` by default) |
| `profile` | `string \| undefined` | The profile given with `--profile` or its variable (with `profiles`) |

`defineConfig(config)` (from `'padrone'`) types such a file and returns its argument as is: `export default defineConfig<{ port?: number }>(({ envName }) => ({ port: envName === 'production' ? 80 : 3000 }))`. A function config can `extends` other configs like an object one; a data config still can't extend a script.

Config values have the lowest precedence: CLI > stdin > env > config. Numbers and booleans are coerced to the option's type like CLI input, so YAML `name: 123` gives a string option `"123"` and `verbose: 1` a boolean `true` (before the `schema` validates, too). A validation error about a value from a config file names it: `port: Invalid input: expected number, received string (from config.json)`. Built-in commands (`builtin: true`) get no config values unless `builtins: true`. Not included by default — must be explicitly applied via `.extend(padroneConfig(...))`. Can be applied at the program level (inherited by all commands) or at the command level.

**The `config` command** (`command: true`), like `git config`. Keys are dotted for nested values (`db.host`; with `sections`, `serve.port` is the `serve` section's `port`), and every subcommand but `path` and `edit` takes `--profile <name>` when `profiles` is on (to read, or write inside `profiles.<name>`). Every subcommand takes `--local` (the project config file: the first of `files` in cwd, or with `searchParents` in the nearest parent that has one, else a new one in cwd named after the first JSON name in `files`, or for `edit` the first that isn't a script) or `--file <path>` to work on that one file instead of the user config file, like `git config --local`/`--file`:

| Subcommand | Does |
|------------|------|
| `config get <key>` | Prints the effective value from the configs the program loads (with the selected profile and the `$<envName>` overrides applied), or the value in the `--local`/`--file` file. Like `unset`, it takes an option's alias or kebab-case name too |
| `config set <key> <value>` | Writes to the user config file: the first of `files` in the user config directory, else the first JSON name in `files`. The key must be an option (name, alias or kebab-case name) of the command or one of its subcommands, or of global args, unless one of their schemas is loose; with a `schema`, the key and value must fit it instead. The value is coerced by the option's type (`[...]`/`{...}` are read as JSON) and validated. Only JSON files (JSONC and rc files included) are written, changing just that value, so comments and formatting stay; YAML, TOML and script files are refused |
| `config unset <key>` | Removes a value from the user config file (and objects left empty), keeping comments |
| `config list` (`ls`) | Prints every effective value as `key=value` with the file it comes from; values of `sensitive` options show as `[redacted]` |
| `config path` | Prints the user config file and the files loaded, lowest precedence first (with `--local`/`--file`, just that file) |
| `config edit` | Opens the user config file in `runtime.editor()` and saves it only if it still parses. A new file gets the first name in `files` that isn't a script, so YAML and TOML work too |

`set`, `unset` and `edit` are `mutation: true`. The group doesn't load configs or env variables into its own arguments.

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
   - String/Number arguments: `{ port: 3000 }` → `--port 3000` (`--port=3000` with `flagStyle: 'equals'`)
   - Array arguments: `{ files: ['a', 'b'] }` → `--files a --files b`
   - Positional arguments: Follow the order specified in `config.positional`, after a `--` with `separator: '--'` (so a value like `-rf` can't be read as an option)
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
| `prefixText` / `suffixText` | `string` | Text before the indicator / after the message, kept in the final line (like ora). Change them with `update({ prefixText, suffixText })` |
| `renderer` | `PadroneProgressRenderer` | Custom renderer factory (defaults to built-in terminal renderer) |
| `taskRenderer` | `PadroneTaskListRenderer` | Renderer for `progress.tasks()` lists (defaults to `createTerminalTaskList`, which prints plain lines through `createSimpleTaskList` without a TTY or in CI) |

`PadroneProgressMessages` fields: `validation` (string), `progress` (string), `success` (string/null/callback), `error` (string/null/callback). Callbacks can return a string, `null` (suppress), or `{ message, indicator }` for per-call icon customization. Messages can also be provided from context via `progressConfig.message` — command-level fields take precedence.

The indicator is available in actions as `ctx.context.progress`. `ctx.context.progress.stopAndPersist({ symbol?, text?, prefixText?, suffixText? })` stops it and leaves a final line with a custom symbol, like ora (`symbol` defaults to `' '`; a custom renderer without `stopAndPersist` gets `succeed(text, { indicator: symbol })`). `ctx.context.progress.tasks(tasks, options?)` runs a list of tasks drawn as a live list, like listr2: each task is `{ title, task: (t) => ..., skip?, retry?, rollback? }`, where `t` has `update(message)`, `setTitle(title)`, `skip(reason?)`, `tasks(subtasks)`, `signal` and `retry` (`{ count, error? }`). `retry: n` (or `{ tries, delay }`) runs a failing task again; `rollback: (t, error) => ...` runs once it has failed for good, and the task shows as rolled back. Options: `concurrent` (`true` or a limit), `exitOnError` (default `true`) and `rendererOptions: { collapseSubtasks }` (hide the subtasks of finished tasks). `ctx.context.progress.isActive` and `isPaused` tell whether the indicator (or a task list) is running and whether it's hidden right now. Serve, MCP and `tool()` calls get a no-op indicator, and their tasks run without drawing.

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

Extension that enables background version checking against a package registry in `cli()`, like update-notifier. The notice after the command's output comes from the latest version an earlier run cached; a stale cache is refreshed in a detached, unref'd process, so a slow registry never delays the exit (the notice shows from the next run).

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
| `packageName` | `string` | program name | Package name to check |
| `registry` | `string` | `'npm'` | Registry URL or `'npm'` shorthand |
| `interval` | `string` | `'1d'` | Check interval (e.g., `'1d'`, `'12h'`, `'30m'`, `'1w'`) |
| `cache` | `string` | `update-check.json` in `program.dirs.cache` | Path to cache file for last check timestamp. The `~/.config/<name>-update-check.json` older versions wrote is moved there |
| `disableEnvVar` | `string` | auto | Env var name that disables update checking |
| `updateCommand` | `string \| (packageName, latestVersion) => string` | `<name> upgrade` with `padroneUpgrade()`, else `npm update -g <name>` | Command suggested in the notice |
| `shouldNotify` | `(info) => boolean` | always | Called when a newer version is known (after the built-in rules below); `false` suppresses the notice, e.g. `({ runtime }) => !runtime.env().npm_lifecycle_event` inside npm scripts |
| `format` | `(info) => string` | `Update available: …` | The notice text, also used by `version --check`. `info` is `{ packageName, current, latest, updateCommand, runtime }` |

Needs the program's version: `.configure({ version })`, or the version of the package its script belongs to (see `version`); without one nothing is checked. `packageName` and `registry` default to `padroneUpgrade()`'s when it's registered. Runtimes that can't spawn a script (Deno, Node single-executable apps) refresh in-process instead, with a 3-second timeout. Skipped in CI (`CI` set to anything but `0`/`false`), when stdout isn't a TTY, when `NO_UPDATE_NOTIFIER` or the `disableEnvVar` variable is set, with `--no-update-check`, and for the `padroneUpgrade()` command.

---

### padroneUpgrade(options?)

Extension that adds a self-update command (`upgrade`), like oclif's plugin-update:

```typescript
import { padroneUpdateCheck, padroneUpgrade } from 'padrone';

program
  .extend(padroneUpgrade({ packageName: '@acme/my-cli' }))
  .extend(padroneUpdateCheck()); // suggests `my-cli upgrade`, checks @acme/my-cli
```

```bash
my-cli upgrade              # install the latest version with the package manager it was installed with
my-cli upgrade --check      # only report whether a newer version exists
my-cli upgrade --check --exit-code  # ...and exit with 1 when one does, like `npm outdated`
my-cli upgrade --to 2.1.0   # a given version (also a downgrade)
my-cli upgrade --channel next
my-cli upgrade --dry-run    # show the install command without running it
```

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `packageName` | `string` | program name | npm package to upgrade |
| `registry` | `string` | `'npm'` | `'npm'` or a URL returning `{ version }` or `{ "dist-tags": { ... } }` |
| `channel` | `string` | `'latest'` | Dist-tag to follow (`--channel` overrides it); other channels may be pre-releases |
| `installer` | `'npm' \| 'bun' \| 'pnpm' \| 'yarn' \| 'brew' \| (plan) => string[] \| void` | detected | How the program is installed. Detected from its script path with symlinks resolved (Homebrew cellar, `~/.bun`, pnpm/yarn global dirs, else npm), then from the executable of a compiled binary. A function returns the command to run, or performs the upgrade itself (e.g. downloading a binary) |
| `brewFormula` | `string` | package name | Formula for `brew upgrade`. Homebrew only upgrades to the formula's latest version, so `--to` and `--channel` fail |
| `command` | `string` | `'upgrade'` | Command name |
| `exec` | `(command: string[]) => Promise<number>` | spawn with inherited stdio | Runs the installer command |
| `verify` | `(plan) => boolean \| void \| Promise<boolean \| void>` | — | Checks the release before installing it (after confirmation, not on `--dry-run`): resolving `false` or throwing refuses the upgrade. `plan.command` is the package manager command about to run |

A custom `installer` that downloads a standalone binary can check it with `verifySha256(data, expected, fileName?)` (from `'padrone'`): `expected` is a hex digest, or a `SHA256SUMS` file whose line for `fileName` is used:

```typescript
import { padroneUpgrade, verifySha256 } from 'padrone';

padroneUpgrade({
  installer: async ({ version }) => {
    const base = `https://github.com/acme/my-cli/releases/download/v${version}`;
    const binary = new Uint8Array(await (await fetch(`${base}/my-cli-linux-x64`)).arrayBuffer());
    const sums = await (await fetch(`${base}/SHA256SUMS`)).text();
    if (!(await verifySha256(binary, sums, 'my-cli-linux-x64'))) throw new Error('Checksum mismatch; not installing');
    // ...replace the binary
  },
});
```

The command asks the registry first: when already up to date (or with `--check`) it says so and stops. Otherwise, since it's a `mutation`, `padroneConfirm()` asks before installing. `--force` reinstalls when already up to date. `--exit-code` (which implies `--check`) sets the result's `exitCode` to 1 when a newer version exists, which `cli()` exits with. The running version is the configured `version`, or that of the package the program's script belongs to.

---

### padroneAliases(options?)

Extension for command aliases, like `gh alias` or git aliases. The first word of the input is expanded before routing, in `cli()` and the REPL:

```typescript
import { padroneAliases } from 'padrone';

program.extend(padroneAliases({ aliases: { co: 'checkout' } }));
```

```bash
my-cli co main                                  # → my-cli checkout main
my-cli alias set pr "checkout pr/\$1 --force"   # $1, $2, … take the words after the alias
my-cli pr 42                                    # → my-cli checkout pr/42 --force
my-cli alias set co checkout --force            # no quotes needed: every word after the name is the expansion
my-cli alias set each 'run --all $@ --verbose'  # $@ takes the words no $N takes
my-cli alias set prod 'deploy @prod.args'       # @file words expand with padroneResponseFiles()
my-cli alias list                               # YAML: co: checkout --force
my-cli alias delete pr
my-cli alias import team-aliases.yml            # add aliases from YAML or JSON (- reads stdin)
my-cli alias import team-aliases.yml --clobber  # ...overwriting ones that already exist
my-cli alias export > my-aliases.yml            # the user's aliases as YAML (--json, or a .json file, for JSON)
my-cli alias export my-aliases.json
```

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `aliases` | `Record<string, string>` | none | Aliases the program defines; users' own aliases of the same name win |
| `file` | `string` | `aliases.json` in `program.dirs.config` | Where users' aliases are kept |
| `command` | `string \| false` | `'alias'` | Name of the management command (`set`, `list`/`ls`, `delete`/`rm`, `import`, `export`), or `false` for none |

A command always wins over an alias of the same name, and `alias set` refuses names of existing commands. Words after the alias that no `$N` uses go where `$@` is, or are appended when the alias has no `$@`; fewer words than its `$N` placeholders take is an error (`Alias "pr" needs 1 argument`). With [`padroneResponseFiles()`](#padroneresponsefilesoptions), the alias's own `@file` words expand as response files (before its placeholders are filled; the words typed after it were already expanded). An unknown command suggests alias names too (`Did you mean "publish"?`). `alias set` takes every word after the name as the expansion, options included (`alias set co checkout --force`); given as several words, a word with spaces stays one word (`alias set co checkout "my branch"`). `alias set` and `alias delete` are mutation commands (POST-only in serve, `destructiveHint` in MCP).

`alias list` prints every alias (the program's and the user's) as a YAML mapping, sorted by name, quoting expansions that YAML would read differently (`pr: "checkout pr/$1"`), so its output imports back. `alias import <file|->` like `gh alias import` reads a YAML or JSON object of names to expansions (JSON for `.json`/`.jsonc` files or text starting with `{`; under Node, without Bun's YAML parser, YAML is read as a flat `name: expansion` mapping), from stdin with `-`. Nothing is written when any entry is invalid (not a string, an invalid name, or a command's name); aliases that already exist with another expansion are skipped and listed unless `--clobber`. `alias export [file]` prints the user's own aliases as YAML, or writes them to `file` (JSON for `.json`); `--json` prints JSON. `import` is a mutation command.

---

### padroneResponseFiles(options?)

Extension for response files, like javac's `@argfiles` or clap's argfiles: each `@file` argument is replaced by the arguments in the file, before routing.

```typescript
import { padroneResponseFiles } from 'padrone';

program.extend(padroneResponseFiles());
```

```bash
my-cli @deploy.args deploy   # deploy.args: --env staging
                             #              --tag "release 2"
```

- Each line is split like a shell command line (quotes group words); blank lines and lines starting with `#` are skipped.
- Paths are relative to the working directory. Response files can reference others, up to 10 levels deep; with `relativeTo: 'file'`, like clap's argfiles, a path in a response file is relative to that file's directory instead (absolute paths stay as they are).
- A missing file (or a bare `@`) is an error. Write `@@text` for an argument that starts with `@` (`@@scope/pkg` → `@scope/pkg`); arguments after `--` are never expanded.
- Expanded in `cli()`, `eval()` and the REPL; serve, MCP and `tool()` calls never read response files.
- The value of an option with [`fromFile`](/padrone/reference/args-meta/#values-from-files) is left to it: `--body @notes.md` (and `--body=@notes.md`) reads the file into `body`, and `--body @@x` passes `@x`. A positional `fromFile` value is still expanded as a response file; write `@@path` there, or pick another `prefix`.

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `prefix` | `string` | `'@'` | The character that marks a response file |
| `relativeTo` | `'cwd' \| 'file'` | `'cwd'` | What a response file named inside another one is relative to: the working directory, or the directory of the file that names it. Response files on the command line (and in aliases) are always relative to the working directory |

---

### padroneExternalCommands(options?)

Extension for git-style external subcommands, like clap's `allow_external_subcommands` or cargo's: a top-level command the program doesn't have runs the executable `<program>-<name>` found on `PATH`, with the words typed after the name.

```typescript
import { padroneExternalCommands } from 'padrone';

program.extend(padroneExternalCommands());
```

```bash
my-cli foo --bar baz   # runs my-cli-foo --bar baz (from PATH), with the terminal's stdin/stdout/stderr
```

- The executable is spawned directly (no shell), with the arguments as typed (options and `--` included, so `my-cli foo --help` is `my-cli-foo --help`) and the runtime's environment. The run ends with its exit code (`cli()` exits with it; `eval()` results carry it as `exitCode`). On Windows, `PATHEXT` extensions are looked up, and a `.cmd` / `.bat` file runs under `cmd.exe` with its arguments escaped.
- The program's own commands always win. When no executable matches, the usual "Unknown command" error follows, with "Did you mean" suggestions that include the external commands.
- Found external commands are listed in help under "External Commands" and offered by shell completion (not in generated docs or man pages, nor in help shown to remote callers).
- Only for `cli()`, `eval()`, `run()` and the REPL: serve, MCP and `tool()` calls never run external commands.
- Built on the [`commandNotFound`](#commandnotfound) event, for top-level names only.

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `prefix` | `string` | `'<program>-'` | What an executable's name starts with |
| `path` | `string[]` | `PATH` of `runtime.env()` | Directories to look in, in order |
| `list` | `boolean` | `true` | List the external commands in help and completion |
| `spawn` | `(file, args, { env }) => Promise<number>` | spawn with inherited stdio | Runs an external command and resolves with its exit code (e.g. to test without spawning) |

---

### padronePlugins(options?)

Extension for plugins users install at runtime, like oclif's `plugins`. At startup (a start-phase interceptor, before routing) each plugin module is loaded and applied to the program, so its commands route, show in help and complete:

```typescript
import { padronePlugins } from 'padrone';

createPadrone('my-cli').extend(padronePlugins({ command: true })).cli();
```

```bash
my-cli plugins install my-cli-plugin-deploy   # npm install / bun add / pnpm add / yarn add into the plugins directory
my-cli plugins link ./my-plugin               # use a local directory or module file, for developing a plugin
my-cli plugins list
my-cli plugins uninstall my-cli-plugin-deploy
my-cli deploy                                 # a command the plugin adds
```

A plugin module default-exports (or exports as `plugin`) a `PadroneExtension`, or a program, which is mounted under its name:

```typescript
// my-cli-plugin-deploy/index.js
export default (program) => program.command('deploy', (c) => c.action(() => 'deployed'));
```

Prefer the extension form: a program export built with another copy of padrone still mounts, but its interceptors come from that copy.

- Plugins are listed in `plugins.json` in the plugins directory, which also holds the installed packages' `package.json` and `node_modules`. A package's entry point comes from its `package.json` (`exports`' `import` / `default`, `module`, `main`).
- A plugin that fails to load is reported on stderr (`Plugin "x" failed to load: …`) and skipped. `plugins install` checks that the package is a plugin, and uninstalls it again when it isn't; a spec starting with `-` is refused.
- With no plugins the run stays synchronous; loading plugins makes it async.
- The `plugins` commands are built-in and only available on the command line (serve, MCP and `tool()` calls are refused); `install`, `uninstall` and `link` are mutation commands. The plugins' own commands are ordinary commands, available to every caller.
- Plugins are applied with the start phase's `next({ program })`: the rest of the run (parse to execute) uses the program with the plugins, and plugins' root interceptors take part from the parse phase on. So runs with a start phase (`cli()`, `eval()`, the REPL, serve and MCP requests) have them, while `program.help()`, `parse()` and `run()` see the program without them; a REPL session keeps the plugins it started with.

**Configuration:**
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `dir` | `string` | `plugins` in `program.dirs.data` | Where installed plugins and `plugins.json` live |
| `packages` | `string[]` | none | Plugin modules the program always loads, before the user's (package names or absolute paths) |
| `command` | `boolean \| string` | `false` | Add the `plugins` group (`list`/`ls`, `install`/`add`, `uninstall`/`remove`/`rm`, `link`); a string names it |
| `packageManager` | `'npm' \| 'bun' \| 'pnpm' \| 'yarn'` | bun under Bun, else how the program was installed | What `install` / `uninstall` run |
| `ignoreScripts` | `boolean` | `false` | Install with `--ignore-scripts`, so install scripts don't run |
| `exec` | `(command, { cwd }) => Promise<number>` | spawn without a shell | Runs a package manager command (e.g. to test without installing) |
| `import` | `(specifier) => Promise<unknown>` | `import()` | Imports a plugin module (a `file:` URL, or a name from `packages`); pass your own to resolve `packages` from your program's location |

---

### program.dirs

The standard per-user directories for the program, named after it (none are created):

| Key | Linux (XDG) | macOS | Windows |
|-----|-------------|-------|---------|
| `config` | `~/.config/<app>` | `~/Library/Application Support/<app>` | `%APPDATA%\<app>` |
| `cache` | `~/.cache/<app>` | `~/Library/Caches/<app>` | `%LOCALAPPDATA%\<app>\Cache` |
| `data` | `~/.local/share/<app>` | `~/Library/Application Support/<app>` | `%LOCALAPPDATA%\<app>\Data` |
| `state` | `~/.local/state/<app>` | `~/Library/Application Support/<app>` | `%LOCALAPPDATA%\<app>\State` |
| `log` | `~/.local/state/<app>/log` | `~/Library/Logs/<app>` | `%LOCALAPPDATA%\<app>\Log` |

`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` are honored on every platform. In an action it's `ctx.program.dirs`; `getProgramDirs(name, env, platform?)` computes them for any name.

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
  - `auth`: Who made the request, available to actions and interceptors as `ctx.auth` (serve and MCP pass what their `auth` returned).

**Returns:** `PadroneCommandResult` with `command`, `args`, `argsResult`, and `result`. Returns a `Promise` when the matched command is async.

**Errors:** Routing and validation errors are printed with a `--help` hint (by the help extension); any other error, from whichever phase threw it (an interceptor's `route`, a config file, the action), is printed by the auto-output extension.

**Exit code:** When the run ends with an error (routing, validation, or a thrown action — including one that only surfaces on `drain()`), `cli()` sets the exit code through `runtime.setExitCode` to the error's `exitCode` (`PadroneError` carries one; 130 for SIGINT), or `1`. It uses `process.exitCode` rather than `process.exit()`, so output still flushes. Successful runs, `--help` and `--version` leave it at `0`, unless the result carries an `exitCode` (as `upgrade --check --exit-code` does when an update exists).

**Note:** Interactive prompting only triggers in `cli()` and `eval()`, not in `parse()` or `run()`. When a command has interactive meta and the runtime can prompt (`interactive` isn't `'disabled'` or `'unsupported'`), missing field values are prompted before validation. The `--repl` flag starts a REPL session (optionally scoped to a command).

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
- `preferences` (optional): `{ interactive?: boolean, context?: TContext, runtime?: PadroneRuntime, signal?: AbortSignal, auth?: unknown }` — override interactive prompting and the runtime, provide context, pass the caller's identity as `ctx.auth`, and cancel the run with `signal` (e.g. `AbortSignal.timeout(5000)`)

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

`program.emit(event, payload)` emits a custom event (see `defineEvent()`) outside any execution, to the root's interceptors.

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

Start a Model Context Protocol server, exposing all commands as MCP tools (except hidden and built-in ones, those `expose` keeps from `mcp`, and those `include`/`exclude` leave out).

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
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable. Also the one non-loopback `Origin` accepted (`'*'` any) |
| `maxBodySize` | `number` | 4 MiB | Largest HTTP request body in bytes; a larger one gets 413 |
| `include` | `string[] \| (command) => boolean` | — | Only offer these commands: paths (`'db migrate'` or `'db.migrate'`), globs (`*` within a name, `**` any number of names: `'db.**'` is `db` and all under it; `'**'` matches the root), or a predicate. Others are neither listed nor run |
| `exclude` | `string[] \| (command) => boolean` | — | Never offer these commands (same patterns) |
| `auth` | `(req: Request) => unknown` | — | Authenticates each request (HTTP; not the CORS preflight): return the identity (`ctx.auth` in actions and interceptors) or a falsy value for 401. Runs after `bearer` |
| `bearer` | `string \| string[]` | — | Accepted `Authorization: Bearer` tokens (compared in constant time); others get 401 with `WWW-Authenticate: Bearer`. `ctx.auth` is `{ token }` |
| `allowedHosts` | `string[] \| true \| 'all'` | — | `Host` names answered besides loopback ones and the bound host (`.example.com` covers subdomains), so non-loopback bindings are protected from DNS rebinding too (403 otherwise); `true`/`'all'` turns the check off |
| `timeout` | `number` | — | Longest a command may run, in ms: its signal is aborted and the request fails (JSON-RPC error `-32001`) |
| `maxConcurrent` | `number` | — | Most commands running at once; one over it fails right away (JSON-RPC error `-32000`) |
| `sessionTtl` | `number` | — | HTTP sessions idle this long (ms, no request and no call running) are dropped, aborting their calls; the client gets 404 and starts a new one |
| `maxSessions` | `number` | `1000` | Most HTTP sessions kept; a new one drops the least recently used. With `auth`/`bearer`, a session only answers the identity that created it |

**Returns:** `Promise<void>` (resolves when the server shuts down)

The HTTP transport implements the [2025-11-25 Streamable HTTP spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) with session management, SSE support (via `Accept: text/event-stream`), and CORS headers. A request with a non-loopback `Origin` (other than `cors`) gets 403, and so does a non-loopback `Host` header when bound to a loopback host (DNS rebinding).

Also available as a built-in CLI command: `myapp mcp [http|stdio] --port 3000 --host 0.0.0.0`

---

### .serve(prefs?) *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

Start a REST HTTP server that exposes commands as endpoints. Each command becomes a route (`users list` → `/users/list`); hidden and built-in commands are left out, as are those `expose` keeps from `serve` and those `include`/`exclude` leave out. Commands with `mutation: true` only accept POST; others accept both GET and POST.

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
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable. Also the one non-loopback, cross-site `Origin` accepted (`'*'` any) |
| `maxBodySize` | `number` | 4 MiB | Largest request body in bytes; a larger one gets 413 (`payload_too_large`) |
| `include` | `string[] \| (command) => boolean` | — | Only offer these commands: paths (`'db migrate'` or `'db.migrate'`), globs (`*` within a name, `**` any number of names: `'db.**'` is `db` and all under it; `'**'` matches the root), or a predicate. Others are neither listed nor run |
| `exclude` | `string[] \| (command) => boolean` | — | Never offer these commands (same patterns) |
| `auth` | `(req: Request) => unknown` | — | Authenticates each request (not the CORS preflight or `/_health`): return the identity (`ctx.auth` in actions and interceptors) or a falsy value for 401. Runs after `bearer` |
| `bearer` | `string \| string[]` | — | Accepted `Authorization: Bearer` tokens (compared in constant time); others get 401 with `WWW-Authenticate: Bearer`. `ctx.auth` is `{ token }` |
| `allowedHosts` | `string[] \| true \| 'all'` | — | `Host` names answered besides loopback ones and the bound host (`.example.com` covers subdomains), so non-loopback bindings are protected from DNS rebinding too (403 otherwise); `true`/`'all'` turns the check off |
| `timeout` | `number` | — | Longest a command may run, in ms: its signal is aborted and the request fails with 504 (`timeout`) |
| `maxConcurrent` | `number` | — | Most commands running at once; one over it fails right away with 503 (`unavailable`, `Retry-After: 1`) |
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
- **Origin/Host checks**: a request whose `Origin` isn't loopback, its own host, or `cors` gets 403, like MCP; bound to a loopback host, so does a non-loopback `Host` header

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

### .tool(prefs?)

Generate a Vercel AI SDK compatible tool.

```typescript
import { streamText } from 'ai';

const tool = program.tool();
// A call running longer than 30 s is aborted, and the model gets "Timed out after 30000 ms"
const limited = program.tool({ timeout: 30_000 });

await streamText({
  model: yourModel,
  tools: { myapp: tool },
});
```

**Returns:** AI SDK tool object. Its `execute` returns `{ result, logs, error }`: the action's return value, what the command printed (with its stderr when it succeeded), and the error message when it failed (a thrown error, a validation failure or an unknown command).

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
  - `historyFile`: Keep history between sessions in this file (`true`: `repl_history` in `program.dirs.state`)
  - `historySize`: Most history entries kept (default: `1000`; `0` keeps none). The file is created readable only by the user (`0600`)
  - `completion`: Enable tab completion (default: `true`)
  - `spacing`: Output separators (before/after command output)
  - `outputPrefix`: Prefix for output lines
  - `scope`: Start scoped to a command path (strongly typed)
  - `runtime`: Runtime overrides for the session (`readLine`, `output`, `error`, …), like `eval()`'s `runtime`
  - `context`: The context each command receives, like `eval()`'s `context` (the `repl` command and `--repl` pass on the one given to `cli()`)

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

### .completion(shell?, options?)

Generate shell completion script.

```typescript
const script = program.completion('bash');
// Or: 'zsh', 'fish', 'powershell'
program.completion('zsh', { mode: 'static', descriptions: false });
```

**Parameters:**
- `shell` (optional): Target shell. Auto-detected if omitted.
- `options.mode` (optional): `'dynamic'` or `'static'` (see below).
- `options.descriptions` (optional): `false` leaves descriptions out.

**Returns:** Shell completion script string

With the `padroneCompletion()` extension (`padrone/completion`) the scripts are dynamic: they call `<program> __complete2 <words>` for per-command subcommands, options and values with descriptions, including `complete` callbacks and `hint`s on fields (see [Completion Values](/padrone/reference/args-meta/#completion-values)). Without it, they're static lists of every command and option, following `hint`s for option values. `padroneCompletion({ mode: 'static' })` (or `completion <shell> --static`) prints the static script even with the extension, which runs nothing on tab; `--no-static` asks for the dynamic one. `padroneCompletion({ descriptions: false })` (or `--no-descriptions`, like cobra's) leaves descriptions out of either script. The extension's `completion` command also takes `--setup` (installs the script in the shell's config file under the runtime's `HOME`, keeping `--static`/`--no-descriptions`) and `--instructions` (prints how to install it for the named or detected shell).

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

Use the `--color` global flag, or the `NO_COLOR` / `FORCE_COLOR` / `CLICOLOR` / `CLICOLOR_FORCE` environment variables:

```bash
# Disable colors
myapp --help --no-color
myapp --help --color=never   # or --color=false / off / no / 0

# Force colors, e.g. when piping to a pager
myapp --help --color | less -R   # or --color=always / on / yes
myapp --help --color=ocean       # a theme (default, ocean, warm, monochrome; others are an error); values need `=`

# Detect from the terminal (the default)
myapp --help --color=auto

# Or via environment, checked in this order: FORCE_COLOR (FORCE_COLOR=0 disables), NO_COLOR,
# CLICOLOR_FORCE (on unless 0), CLICOLOR=0, TERM=dumb, CI (CI=false and CI=0 don't count), then the terminal
FORCE_COLOR=1 myapp --help
NO_COLOR=1 myapp --help
CLICOLOR_FORCE=1 myapp --help | less -R
CLICOLOR=0 myapp --help
TERM=dumb myapp --help
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
# args.data = "hello\n" (the text as piped, trailing newline included)
```

To drop surrounding whitespace (the trailing newline of `echo`), use `{ field, trim: true }`. Number and boolean fields are always trimmed, so `echo 21 | myapp double` works:

```typescript
.arguments(z.object({ token: z.string() }), { stdin: { field: 'token', trim: true } })
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

- Only reads when stdin is piped (not a TTY, including a custom `runtime.stdin` with `isTTY: true`) and the target field wasn't provided via CLI flags or positionally
- A lone `-` as the field's value (`myapp cat -`, `--data -`) reads stdin, even from a terminal, like `cat -`
- `trim: true` trims the text (each line, for arrays); number and boolean fields are trimmed anyway
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
| `id` | `string` | Deduplication key — when multiple interceptors share an `id`, the last one wins (a command's replaces the root's, error and shutdown included) |
| `disabled` | `boolean` | Skip this interceptor during execution |
| `requires` | `string[]` | Ids of interceptors this one needs; running a command without them fails with an error naming the missing one |
| `async` | `boolean` | The interceptor may make validation async |
| `callers` | `PadroneCaller[]` | Run only for these callers (e.g. `LOCAL_CALLERS` = `cli`/`eval`/`run`/`repl`, `REMOTE_CALLERS` = `serve`/`mcp`/`tool`); skipped otherwise. Still counts as registered for `requires` |
| `on` | `Record<string, handler>` | Custom event handlers keyed by event id |
| `extraCommands` | `(command) => { name, description?, group? }[]` | Commands the interceptor runs that aren't in the command tree (e.g. external commands on `PATH`), under `command`: listed in help on the command line and offered by shell completion; a real command of the same name hides one |

**Chaining methods (single-arg form):**
- `.provides<T>()` — Declare what this interceptor adds to the context (type-level only)
- `.requires<T>(...ids)` — Declare what this interceptor expects on the context; interceptor ids passed (`.requires<{ logger: PadroneLogger }>('padrone:logger')`) are also checked at runtime
- `.factory(fn)` — Set the factory function

The returned interceptor also has `.on(event, handler)`, which adds a typed handler for a custom event. `.on()` and `.requires()` return a new interceptor with the same `id`, meta and factory, leaving the original unchanged.

## defineEvent\<T\>(id)

Define a custom event for extensions to talk through. Handle it with `.on()` on an interceptor; emit it with `ctx.emit()` in an action or interceptor phase, which runs the handlers of the interceptors on the running command's chain one after another (in interceptor order) and resolves once they've run. `program.emit(event, payload)` emits outside an execution, to the root's interceptors.

```typescript
import { defineEvent, defineInterceptor } from 'padrone';

const deployed = defineEvent<{ env: string; version: string }>('myapp:deployed');

const slack = defineInterceptor({ name: 'slack' }, () => ({})).on(deployed, (payload, ctx) => notify(payload.env));

program.intercept(slack).command('deploy', (c) => c.action((args, ctx) => ctx.emit(deployed, { env: args.env, version: '1.2.0' })));
```

Handlers receive the payload and `{ command, runtime, context, caller, signal, program, emit }`; a handler's error rejects `emit()`.

**Returns:** A `PadroneInterceptor` — pass to `.intercept()` or use within an extension.

## commandNotFound

A built-in event, emitted when routing finds no command for a name: at the top level (`my-cli deploi`), or under a command that has subcommands and takes no positionals (`my-cli db migrat`). Like oclif's `command_not_found` hook or commander's `command:*`. A handler can run something in the unknown command's place, or route another input instead; when none does, the usual "Unknown command" error follows, with "Did you mean" suggestions.

```typescript
import { commandNotFound, defineInterceptor } from 'padrone';

const fallback = defineInterceptor({ name: 'fallback' }, () => ({})).on(commandNotFound, (event) => {
  if (event.name === 'ship') event.reroute(['deploy', ...event.args]); // an input to route instead
  else if (event.name === 'hello') event.handle((ctx) => `Hello from ${ctx.command.path}`); // runs in its place
});

program.intercept(fallback);
```

The payload (`PadroneCommandNotFound`):

| Property | Description |
|----------|-------------|
| `name` | The name that matched no command |
| `args` | The words typed after it, as typed (options included) |
| `command` | The command it was looked up in (the program for a top-level name) |
| `input` | The run's whole input |
| `suggestions` | Similar command names, as "Did you mean" lists them |
| `handled` | Whether a handler has called `handle()` or `reroute()` |
| `handle(action)` | Run `action(ctx)` in the unknown command's place: through the execute interceptors of `command`'s chain (not `.hook()` hooks), with no args to validate; its return value is the run's result, printed by `cli()` |
| `reroute(input)` | Route `input` instead (the parse interceptors don't run again) |

Handlers are those of the interceptors on `command`'s chain, run one at a time in interceptor order until one handles it. The event is only emitted when a handler is registered, so a program without one stays synchronous; interceptors with `callers` only get it from those callers. [`padroneExternalCommands()`](#padroneexternalcommandsoptions) is built on it.

---

## Built-in Extension Exports

These extensions are available as named exports from `'padrone'`:

| Export | Purpose |
|--------|---------|
| `padroneEnv(schema?, options?)` | Parse environment variables into args (`vars` maps args to variables, `prefix` reads every option from `PREFIX_*`; both shown in help; `arraySeparator` splits array values) |
| `padroneConfig(options)` | Load args from config files (layered with `merge` and `extends`; function configs with `defineConfig()`; `$production` overrides; `profiles`; a `config` command) |
| `padroneProgress(config)` | Auto-managed progress indicators, and task lists with `progress.tasks()` |
| `padroneLogger(options)` | Structured logging with levels (`--verbose` (repeatable), `--quiet`, `--log-level`; `shortFlags: true` adds `-v`/`-vv`/`-q`; `env` reads the level from a variable). Logs go to stderr with colored level labels; `stdout: true` sends `trace`/`debug`/`info` to stdout, and `format: 'json'` writes JSON lines (`logger.info({ userId }, 'signed in')` adds fields). `logger.child({ requestId })` adds bindings to every line; `redact: ['user.password', '*.token']` (or `{ paths, censor }`) censors logged objects; `destination` writes lines to a file path, a function or a `{ write }` stream instead, or to several: an array of destinations and `{ destination?, level?, format? }` streams (without `destination`, the runtime's streams; a stream's `level` holds whatever the flags say), e.g. `[{ level: 'info' }, { destination: 'debug.log', level: 'debug', format: 'json' }]`. `serializers: { req: (req) => ({ method: req.method }) }` turn fields and bindings into what's logged, before `redact`; errors go through `err` (default `{ name, message, stack }`). Colors follow whether stderr is a terminal |
| `padroneJson(options?)` | `--json` flag: prints the result as JSON (iterator items one per line). `--jq <expr>` filters it (a built-in, lazily evaluated jq subset with `if`, `as $x`, arithmetic, string interpolation (`"\(.a)"`, `@sh "echo \(.name)"`), regex `test`/`sub`/`gsub`, `range`, `limit`, `first(f)`, `any`/`all`, `paths`, `getpath`/`setpath`/`delpaths`, `tostream`, `..`, `$ENV`/`env` and `@csv`/`@tsv`/`@sh`/`@uri`/`@base64d`, or pass `jq: (input, expr, { env }) => outputs` for a full implementation; non-string outputs are compact JSON when piped, indented on a terminal) and `--template '{{.name}}'` formats it; both imply `--json`. Errors in `cli()` print as `{ "error": { ... } }` on stdout under JSON output. `fields: true` lets `--json=name,url` keep only those fields (`fields: 'required'`: also `--json name,url`, and a bare `--json` fails listing the fields); `availableFields` declares them. Every jq run has a step budget, so `[range(1e9)]` fails fast: `jqLimits: { maxSteps, remoteMaxSteps }` (defaults `10_000_000` and `1_000_000`). Remote callers (serve, MCP, `tool()`) get the lower budget and an empty `$ENV` |
| `padroneFormat(options?)` | `--output`/`-o <format>`: `text` (default), `json` (like `--json`), `yaml`, `csv`, `tsv`, `table`. Options: `formats`, `default`, `flags`, `tableFlags` for `--columns a,b`, `--sort [-]column` and `--no-header`, `columns` (`{ id: 'ID' }` or `(command) => …`: default columns and header labels), `pipedTable: 'tsv'` (`-o table` prints TSV when stdout isn't a terminal), `csvLineEnding: 'crlf'`, `sanitize: true` (strip terminal escape sequences and control characters from yaml/csv/tsv/table values, for untrusted data) and `csvFormulaEscape: true` (prefix `'` on csv/tsv cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return, numbers excepted). Table cells with newlines span several lines. String results print as text under yaml/csv/tsv/table (other non-objects under csv/tsv/table); `--json`/`--jq`/`--template` take precedence |
| `padroneConfirm(options?)` | Asks before running `mutation: true` commands in `cli()`/REPL; `--yes`/`-y` skips it, and so does `<PROGRAM>_YES=1` in the environment (`env` renames the variable, `false` turns it off). Without a terminal (CI, piped stdin or stdout, `--no-interactive`) the command fails unless one of those is given; `nonInteractive: 'yes'` runs it there and `'no'` aborts it. A command's `.configure({ confirm })` overrides `when` and `message`. Cancelling the question aborts. Options: `message`, `when`, `flags`, `env`, `nonInteractive` |
| `padroneCredentials(options?)` | Secret storage: `ctx.context.credentials.get(name)` / `set(name, secret)` / `delete(name)` / `backend()` (all async). `backend: 'auto'` (default) uses the OS keychain (macOS `security`, with the secret on stdin through `security -i`; Linux `secret-tool`, secret on stdin), else `credentials.json` in `program.dirs.data` (`file`) with mode `0600`; `'keychain'` fails without one, `'file'` always uses the file, or pass a `PadroneCredentialBackend`. `service` defaults to the program name. Serve, MCP and `tool()` calls are refused unless `remote: true`. `runner` (argv, no shell) and `platform` are injectable for tests |
| `padroneTiming(options?)` | Execution timing: `Done in 1.20s`, or `Failed after 1.20s` when the command fails, printed after its result or error. `enabled: true` turns it on without `--time`; `format: ({ elapsed, duration, failed, error }) => string \| null` changes the line |
| `padroneUpdateCheck(config)` | Background version checking |
| `padroneUpgrade(options?)` | `upgrade` command: self-update with the package manager the program was installed with (`--check`, `--exit-code`, `--to`, `--channel`; `verify` checks the release first) |
| `padroneAliases(options?)` | User-defined command aliases (`alias set|list|delete|import|export`), expanded before routing (`$1`…`$N` and `$@` placeholders) |
| `padroneResponseFiles(options?)` | Response files: `@file` arguments expand into the file's arguments (`@@` escapes, `prefix` and `relativeTo` options) |
| `padroneExternalCommands(options?)` | Git-style external subcommands: `my-cli foo` runs `my-cli-foo` from `PATH` (no shell, inherited stdio, its exit code); listed in help and completion; local callers only |
| `padronePlugins(options?)` | Runtime plugins loaded at startup from `plugins.json` and `packages`; `command: true` adds `plugins list\|install\|uninstall\|link` |

The following extensions live in their own subpath imports to keep optional dependencies and large transitive surfaces out of the main bundle:

| Export | Import from | Purpose |
|--------|-------------|---------|
| `padroneInk()` | `'padrone/ink'` | React (Ink) rendering support; serve, MCP and `tool()` calls get the first frame as text, or the last frame once the app exits with `remote: 'exit'` (`remoteTimeout`, default 10s) |
| `padroneMcp()` | `'padrone/mcp'` | MCP server integration |
| `padroneServe()` | `'padrone/serve'` | REST server integration |
| `padroneTracing(config)` | `'padrone/tracing'` | OpenTelemetry tracing. Pass `api: { context, trace }` from `@opentelemetry/api` to parent child spans to the command's span. The span is named `<caller> <command>` (`cli deploy`, `serve users list`), is a server span for serve and MCP calls (internal otherwise), has `padrone.command` and `padrone.caller` attributes (never args), and failures set its status message to the error's |
| `padroneCompletion(options?)` | `'padrone/completion'` | Shell completion generation, with dynamic per-command completion (`__complete2`), descriptions, field `complete` callbacks, `.configure({ complete })` hooks and `hint`s; `mode: 'static'` / `--static`, `descriptions: false` / `--no-descriptions` |
| `padroneMan(options?)` | `'padrone/man'` | Man page generation: the version and date (`SOURCE_DATE_EPOCH` when set) in `.TH`, parent and subcommand pages under SEE ALSO. `section` (default `1`) sets the man section; `dir` where `man --setup`/`--remove` install (default `man<section>` under `$XDG_DATA_HOME/man`, from the runtime env) |

The following extensions are applied automatically by `createPadrone()` and can be disabled via `builtins`:

| Export | Builtin key | Purpose |
|--------|-------------|---------|
| `padroneHelp(options?)` | `help` | Help command and `--help` flag. Options: `showHelpOnError` prints the full help after errors; `flags` renames the help flags (default `['help', 'h']`); `pager: true` shows help taller than the terminal through `$PAGER` or `less -FRX` in `cli()` (a string sets the fallback pager; `--no-pager` / `--pager` per run); `pickSubcommand: true` asks which subcommand to run (a select prompt) when a group command runs without one in `cli()`/REPL; `topics: { name: { title?, description?, content } }` adds `help <topic>` guides, listed under "Additional help topics" |
| `padroneVersion(options?)` | `version` | Version command and `--version` flag (on any command; single-character flags on the root only). `version --verbose` adds the runtime, platform, architecture and shell (an object under `--json`). `version --check` (or `--version --check`) asks the registry and adds an "Update available" notice like `gh version` (under `--json`: `{ name, version, latest, updateAvailable }`), using `padroneUpdateCheck()`'s or `padroneUpgrade()`'s package and registry, or npm with the program name; remote callers (serve, MCP, `tool()`) get the version without a check. Without `.configure({ version })`, the version comes from the nearest `package.json` above the program's script (symlinks resolved), never from the working directory. Options: `flags` renames the version flags (default `['version', 'v', 'V']`); `info` adds fields to `--verbose` |
| `padroneRepl()` | `repl` | REPL command and `--repl` flag |
| `padroneColor()` | `color` | `--color`/`--no-color` support; an unknown `--color=<theme>` is an error listing the themes |
| `padroneSuggestions(options?)` | `suggestions` | "Did you mean?" suggestions for unknown commands (and `padroneAliases()` names) and options (including extensions' `--json`, `--yes`, …). `run: 'prompt'` asks whether to run the closest command after an unknown one in `cli()`/REPL |
| `padroneSignalHandling(options?)` | `signal` | Signal handling and AbortSignal. A second Ctrl+C within `forceExitMs` (default `2000`; `0` turns it off) force-exits (only after a first process signal, not when a caller's `signal` aborted the run); inside the REPL, Ctrl+C belongs to the command running; `onForceExit(signal)` runs right before. Configure the builtin with `builtins: { signal: { forceExitMs, onForceExit } }` |
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
  PadroneHookName,
  PadroneHookContext,

  // Interceptor types
  PadroneInterceptor,
  PadroneCaller,
  PadroneEvent,
  PadroneEventHandler,
  PadroneEventContext,
  PadroneCommandNotFound,
  PadroneExtraCommand,
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

  // Prompt and credential types
  PadronePrompt,
  PadronePromptContext,
  PadronePromptGroup,
  PadronePromptChoice,
  PadroneTextPromptOptions,
  PadronePasswordPromptOptions,
  PadroneConfirmPromptOptions,
  PadroneSelectPromptOptions,
  PadroneMultiselectPromptOptions,
  PadroneCredentials,
  PadroneCredentialsOptions,
  PadroneCredentialBackend,
  PadroneCommandRunner,
  PadroneCommandRunResult,
  WithCredentials,
  PadroneEvalPreferences,
  PadroneMcpPreferences,
  PadroneServePreferences,

  // Progress types
  PadroneProgress,
  PadroneProgressConfig,
  PadroneProgressMessage,
  PadroneProgressOptions,
  PadroneProgressPersistOptions,
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
