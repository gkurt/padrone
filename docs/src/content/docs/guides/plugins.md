---
title: Interceptors & Extensions
description: Intercept command execution and extend programs with composable middleware
---

Padrone's architecture is built on two complementary systems:

- **Extensions**: Build-time composition — reusable bundles of commands, configuration, and interceptors applied via `.extend()`. Most of Padrone's built-in features (help, version, REPL, color, signal handling, auto-output, stdin, interactive, suggestions) are implemented as extensions.
- **Interceptors**: Runtime phase interception — middleware that wraps the command lifecycle (parse, validate, execute, etc.) with an onion model. Extensions typically register interceptors under the hood.

This extension-first architecture means the core is minimal — features are layered on via the same `.extend()` and `.intercept()` APIs you use for your own code.

## Architecture Overview

When you call `createPadrone('myapp')`, built-in extensions are automatically applied:

| Extension | What it does | Interceptor Order |
|-----------|-------------|-------------------|
| **help** | `--help`/`-h` flag, `help` command and `<cmd> help`, error-phase help display | -1001.5 |
| **version** | `--version` flag (any command), `-v`/`-V` (root), `version [--verbose]` command | -1000 |
| **repl** | `--repl` flag, `repl` command | -1000 |
| **color** | `--color[=always\|never\|auto\|<theme>]`/`--no-color` flag | -1001 |
| **suggestions** | "Did you mean?" for unknown commands/options | -500 |
| **signal** | SIGINT/SIGTERM handling, double-tap force-exit, AbortSignal propagation | -2000 |
| **autoOutput** | Auto-print results (strings, promises, iterators) and, in `cli()`, errors the help extension didn't print | -1100 |
| **stdin** | Pipe stdin into argument fields (text, lines, or stream); not read for serve, MCP and `tool()` calls | -1001 |
| **interactive** | `--interactive`/`-i` flag, auto-prompting for missing fields | -999 |

Each can be disabled individually:

```typescript
const program = createPadrone('myapp', {
  builtins: { repl: false, color: false },
});
```

Additional opt-in extensions are available for advanced features:

| Extension | Import | What it does |
|-----------|--------|-------------|
| `padroneEnv(schema)` | `'padrone'` | Parse environment variables into args (`vars`, or `prefix` for every option, `APP_DB__HOST` for nested ones; empty variables count as unset unless `allowEmpty`) |
| `padroneConfig(options)` | `'padrone'` | Load args from config files (`xdg`, `searchParents`, `packageJson`, `merge`, `extends` options), `--profile` profiles (`profiles`), per-command sections (`sections`), and a `config get\|set\|unset\|list\|path\|edit` command (`command`, with `--local`/`--file`) |
| `padroneProgress(config)` | `'padrone'` | Auto-managed progress indicators and `progress.tasks()` task lists (no-op for serve, MCP and `tool()` calls) |
| `padroneLogger(options)` | `'padrone'` | Structured logging to stderr with levels (`--verbose` repeatable; `shortFlags`, `env`, `stdout`, `format: 'json'` options) |
| `padroneJson(options?)` | `'padrone'` | `--json` flag: results and errors as JSON; `--jq` and `--template` filter and format the result; `fields` adds gh-style `--json name,url` |
| `padroneFormat(options?)` | `'padrone'` | `--output`/`-o <format>`: text, json, yaml, csv, tsv or table; `tableFlags` adds `--columns`, `--sort`, `--no-header` |
| `padroneConfirm(options?)` | `'padrone'` | Confirmation prompt (or `--yes`) before `mutation: true` commands |
| `padroneTiming()` | `'padrone'` | Execution timing (`--time`) |
| `padroneUpdateCheck(config)` | `'padrone'` | Background version checking |
| `padroneUpgrade(options?)` | `'padrone'` | Self-update command (`upgrade`, `--check`, `--to`, `--channel`) using the package manager the program was installed with |
| `padroneAliases(options?)` | `'padrone'` | User-defined command aliases (`alias set co "checkout --force"`), expanded before routing |
| `padroneResponseFiles(options?)` | `'padrone'` | Response files: `my-cli @args.txt` reads arguments from `args.txt` (`@@` escapes a leading `@`) |
| `padroneInk()` | `'padrone/ink'` | React (Ink) rendering support; `remote: 'exit'` returns an app's last frame to serve, MCP and `tool()` calls |
| `padroneMcp()` | `'padrone/mcp'` | MCP server integration |
| `padroneServe()` | `'padrone/serve'` | REST server integration |
| `padroneTracing(config)` | `'padrone/tracing'` | OpenTelemetry tracing (pass `api: { context, trace }` for span parenting) |
| `padroneCompletion()` | `'padrone/completion'` | Shell completion generation (dynamic, with descriptions, field `complete` callbacks and `hint`s) |
| `padroneMan()` | `'padrone/man'` | Man page generation |

## Extensions

An extension is a function that receives a builder and returns a modified builder. Extensions can add commands, arguments, interceptors, and configuration — anything the builder supports.

### Using Extensions

Apply extensions with `.extend()`:

```typescript
import { createPadrone, padroneEnv, padroneConfig, padroneProgress } from 'padrone';

const program = createPadrone('myapp')
  .extend(padroneEnv(envSchema))
  .extend(padroneConfig({ files: 'app.config.json' }))
  .command('deploy', (c) =>
    c
      .extend(padroneProgress('Deploying...'))
      .action(async () => { /* ... */ })
  );
```

Extensions compose naturally — chain multiple `.extend()` calls to layer functionality. Extensions applied at the program level affect all commands; extensions applied inside a `.command()` callback affect only that command.

### Output Formats

`padroneJson()` adds `--json` (with `--jq` and `--template`), and `padroneFormat()` adds `--output`/`-o <format>`:

```typescript
import { createPadrone, padroneFormat, padroneJson } from 'padrone';

const program = createPadrone('myapp')
  .extend(padroneJson({ fields: true }))
  .extend(padroneFormat({ tableFlags: true }))
  .command('users', (c) => c.action(() => fetchUsers()));

// myapp users --json=id,name              only these fields of each user
// myapp users -o yaml
// myapp users -o csv --columns id,name --sort -createdAt --no-header
// myapp users -o table
```

**Field selection.** With `fields: true`, `--json=a,b` keeps only those keys of the result (of each item, for arrays and streamed items); `--jq` and `--template` then apply to what's left. The list must be attached with `=` so `--json` never takes the next argument (`myapp user --json 42` keeps `42` as a positional). With `fields: 'required'` (like `gh`), `--json a,b` also works, and a bare `--json` fails with `Specify one or more comma-separated fields for --json: …`. The available fields are `availableFields` when given (a list, or `(command) => list | undefined`), checked before the command runs; otherwise they're the keys of the result, checked when it's printed.

**Formats.** `text` (the default) is how auto-output prints results without the extension; `json` is the same as a bare `--json` that prints every field (errors print as JSON too); `yaml` uses a small built-in emitter (streamed items as `---` documents); `csv` (RFC 4180 quoting) and `tsv` (tabs and newlines escaped as `\t`/`\n`) print an object, or an array of objects, as rows under a header, and streamed items one row each (the header comes from the first item); `table` renders the rows with the table primitive (a stream is rendered when it ends). A string result (such as `--help` or `--version`) prints as text under every format but `json`, and any other result that isn't an object prints as text under csv, tsv and table. Options: `formats` restricts the accepted list, `default` sets the format without `-o`, `flags` renames the flag (`['output', 'o']`), `tableFlags` adds `--columns a,b` (pick and order), `--sort <column>` (`-column` for descending; sorted streams wait for the end) and `--no-header` for table, csv and tsv; unknown columns are errors.

`--json`, `--jq` and `--template` take precedence over `-o`. Serve, MCP and `tool()` calls get raw results either way. A command's own `--output`/`-o` option wins over the extension's.

### Writing Custom Extensions

A `PadroneExtension` is a function `(builder) => builder`:

```typescript
import type { PadroneExtension } from 'padrone';

// Simple extension that adds a shared interceptor
const withLogging = (builder) =>
  builder.intercept(defineInterceptor({ name: 'logger' }, () => ({
    execute: (ctx, next) => {
      console.log(`Running: ${ctx.command.name}`);
      return next();
    },
  })));

// Extension that adds commands and configuration
const withAdmin = (builder) =>
  builder
    .command('admin', (c) =>
      c
        .command('status', (s) => s.action(() => 'healthy'))
        .command('reset', (s) => s.configure({ mutation: true }).action(() => 'reset'))
    );

const program = createPadrone('myapp')
  .extend(withLogging)
  .extend(withAdmin);
```

### Extension Pattern: Interceptor + Command

Most built-in extensions follow this pattern — register a command (if needed) and an interceptor:

```typescript
function myFeature(options?: MyOptions) {
  return (builder) =>
    builder
      .command('my-feature', (c) =>
        c.configure({ hidden: true }).action(() => { /* ... */ })
      )
      .intercept(myFeatureInterceptor(options));
}
```

## Interceptors

Interceptors let you intercept the command lifecycle using a middleware pattern. They wrap each phase with an onion model, giving you full control to modify inputs, short-circuit execution, add logging, or implement cross-cutting concerns.

The full lifecycle is: **start → parse → route → validate → execute → shutdown** (with **error** on failure).

### Defining Interceptors with `defineInterceptor()`

The recommended way to create interceptors is with `defineInterceptor()`. It returns a factory function that creates fresh phase handlers per execution, enabling cross-phase state sharing via closures:

```typescript
import { defineInterceptor } from 'padrone';

const auditInterceptor = defineInterceptor({ name: 'audit', order: 10 }, () => {
  // Closure state — fresh per execution, shared across phases
  let startTime: number;

  return {
    start: (ctx, next) => {
      startTime = Date.now();
      return next();
    },
    execute: (ctx, next) => {
      const result = next();
      auditLog({ command: ctx.command.name, duration: Date.now() - startTime });
      return result;
    },
  };
});
```

The first argument is metadata (`name`, `order`, optional `id`). The second argument is a factory function that returns phase handlers.

**Metadata properties:**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Display name for the interceptor |
| `order` | `number` | Execution order — lower = outermost (default: `0`) |
| `id` | `string` | Deduplication key — when multiple interceptors share an `id`, the last one wins |
| `disabled` | `boolean` | Skip this interceptor during execution |
| `inherit` | `boolean` | When `false`, applies only to the command it's registered on (default: `true`) |
| `options` | `Record<string, OptionArity>` | Options the interceptor reads from `rawArgs` that aren't in the command's schema, keyed by long name or single-char flag. Tells the parser whether each takes a value: `'flag'`, `'value'`, `'optional'` or `'array'` |
| `env` | `Record<string, string \| string[]> \| (arg, command) => string \| string[] \| undefined` | Environment variables the interceptor reads into args, keyed by arg name (or a function of the arg and the command whose help is shown). Shown in help as `Env: NAME` for the command's own options |
| `helpOptions` | `HelpArgumentInfo[] \| (command) => HelpArgumentInfo[]` | Options (from `options`) listed in the help of the commands the interceptor applies to, e.g. `{ name: 'profile', type: 'string', optional: true, description: '...' }` |
| `async` | `boolean` | The interceptor may make the validate phase async (e.g. loading files). Commands it applies to count as async at runtime, so they aren't warned about returning a Promise from validation |
| `callers` | `PadroneCaller[]` | Run only for these callers (`'cli'`, `'eval'`, `'run'`, `'repl'`, `'serve'`, `'mcp'`, `'tool'`); skipped for the others, like `disabled`. `LOCAL_CALLERS` and `REMOTE_CALLERS` are exported. It still counts as registered for `requires` |
| `on` | `Record<string, handler>` | Custom event handlers keyed by event id (`.on(event, handler)` adds one with a typed payload; see [Custom Events](#custom-events)) |

If your interceptor reads its own flag from `rawArgs` (like the built-in `--help` or `--config`), declare it in `options` so the parser knows how to read it. A `flag` option given a value (`--yes=false`) arrives as that string, so treat `false`, `'false'`, `'0'`, `'no'` and `'off'` as off. For example, `options: { profile: 'value', p: 'value' }` makes `--profile dev deploy` read `dev` as the value and still route to `deploy`. The command's own schema takes precedence when both define the same name.

### Simple Interceptor Objects

For simple cases, you can also pass an object directly to `.intercept()`:

```typescript
const logger: PadroneInterceptor = {
  name: 'logger',
  execute: (ctx, next) => {
    console.log(`Running: ${ctx.command.name}`);
    const result = next();
    console.log(`Done: ${ctx.command.name}`);
    return result;
  },
};

program.intercept(logger);
```

### Registering Interceptors

Use `.intercept()` on programs or individual commands:

```typescript
const program = createPadrone('myapp')
  .intercept(logger)  // Applies to all commands
  .command('deploy', (c) =>
    c
      .intercept(deployGuard)  // Only applies to 'deploy'
      .arguments(schema)
      .action(handler)
  );
```

`.intercept()` is immutable — it returns a new builder with the interceptor added.

### Execution Phases

Interceptors can hook into seven phases — four core phases (parse, route, validate, execute) and three lifecycle phases (start, error, shutdown):

#### Start Phase

Runs before everything else, wrapping the entire pipeline. Only root-level interceptors run during start — subcommand interceptors are not invoked. Available in `eval()` and `cli()` only (not `parse()` or `run()`).

```typescript
const startup = defineInterceptor({ name: 'startup' }, () => ({
  start: (ctx, next) => {
    console.log('Starting up...');
    const result = next();  // Runs the full parse → validate → execute pipeline
    console.log('Pipeline complete');
    return result;
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | The root command |
| `input` | `string \| string[] \| undefined` | Raw CLI input: the string passed to `eval()`/REPL, or the argv array from `cli()` (each entry one token) |
| `signal` | `AbortSignal` | Cancellation signal (provided by the signal extension) |
| `context` | `unknown` | User-provided context from `cli()`/`eval()` |
| `caller` | `string` | Invocation method (`'cli'`, `'eval'`, `'repl'`, etc.) |
| `runtime` | `ResolvedPadroneRuntime` | The resolved runtime |
| `program` | `AnyPadroneProgram` | The root program |

**Result:** The full pipeline result (passed through from parse → validate → execute).

#### Parse Phase

Runs when CLI input is being parsed into a command and raw arguments. Only root-level interceptors run during parsing — subcommand interceptors are not invoked.

An interceptor that reads its own flags from `rawArgs` in the parse phase (like `--verbose`) should also read them in the validate phase when parse didn't run, so it works when applied to a single command. The built-in logger, timing and `--json` extensions do this.

```typescript
const parseLogger = defineInterceptor({ name: 'parse-logger' }, () => ({
  parse: (ctx, next) => {
    console.log('Input:', ctx.input);
    const result = next();
    console.log('Parsed command:', result.command.name);
    return result;
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | The root command |
| `input` | `string \| string[] \| undefined` | Raw CLI input: the string passed to `eval()`/REPL, or the argv array from `cli()` (each entry one token) |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context from `cli()`/`eval()` |
| `caller` | `string` | Invocation method |

**Result:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | Resolved command |
| `rawArgs` | `Record<string, unknown>` | Parsed raw arguments |
| `positionalArgs` | `string[]` | Positional argument values |

#### Route Phase

Runs after the target command is resolved (post-parse), before validation. Both root and command-level interceptors participate. Use for per-command setup like authorization checks, resource loading, or logging.

```typescript
const auth = defineInterceptor({ name: 'auth' }, () => ({
  route: (ctx, next) => {
    if (ctx.command.meta?.requiresAuth && !isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    return next();
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | Resolved target command |
| `rawArgs` | `Record<string, unknown>` | Parsed raw arguments |
| `positionalArgs` | `string[]` | Positional argument values |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context |
| `caller` | `string` | Invocation method |

**Result:** `void`

#### Validate Phase

Runs after routing, when raw arguments are being validated against the schema.

```typescript
const defaults = defineInterceptor({ name: 'inject-defaults' }, () => ({
  validate: (ctx, next) => {
    // Inject values before validation
    ctx.rawArgs.region ??= 'us-east-1';
    return next();
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | Resolved command |
| `rawArgs` | `Record<string, unknown>` | Mutable raw arguments — modify before `next()` |
| `positionalArgs` | `string[]` | Positional argument values |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context |
| `caller` | `string` | Invocation method |

**Result:**
| Property | Type | Description |
|----------|------|-------------|
| `args` | `unknown` | Validated arguments |
| `argsResult` | `StandardSchemaV1.Result` | Full validation result |

#### Execute Phase

Runs when the command's action handler is being invoked.

```typescript
const timer = defineInterceptor({ name: 'timer' }, () => ({
  execute: (ctx, next) => {
    const start = performance.now();
    const result = next();
    const duration = performance.now() - start;
    console.log(`Completed in ${duration.toFixed(0)}ms`);
    return result;
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | Resolved command |
| `args` | `unknown` | Mutable validated arguments — modify before `next()` |
| `dryRun` | `boolean \| undefined` | `true` under `--dry-run`: the command's dry-run handler runs instead of its action. Skip your own side effects |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context |
| `caller` | `string` | Invocation method |

**Result:**
| Property | Type | Description |
|----------|------|-------------|
| `result` | `unknown` | Action handler return value (the dry-run handler's under `--dry-run`) |

#### Error Phase

Called when the pipeline throws an error. Error handlers can log, transform, or suppress errors. Only runs for `eval()` and `cli()`. Runs in two layers: command-level error handlers run first (for route/validate/execute failures), then root-level error handlers (for all failures including parse).

```typescript
const errorReporter = defineInterceptor({ name: 'error-reporter' }, () => ({
  error: (ctx, next) => {
    // Log and pass through
    reportToSentry(ctx.error);
    return next();
  },
}));

const errorRecovery = defineInterceptor({ name: 'error-recovery' }, () => ({
  error: (ctx, next) => {
    // Suppress the error and return a fallback result
    if (ctx.error instanceof NetworkError) {
      return { error: undefined, result: cachedValue };
    }
    // Transform the error
    return { error: new AppError('Something went wrong', { cause: ctx.error }) };
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | The resolved command (target command for command-level, root for root-level) |
| `error` | `unknown` | The error that was thrown |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context |
| `caller` | `string` | Invocation method |

**Result:**
| Property | Type | Description |
|----------|------|-------------|
| `error` | `unknown \| undefined` | The error to throw. Set to `undefined` to suppress. |
| `result` | `unknown` | Replacement result when suppressing the error. |

Calling `next()` passes to the next error handler. The innermost core returns `{ error }` unchanged, which re-throws after shutdown runs. Command-level error handlers can suppress errors before they reach root-level handlers.

#### Shutdown Phase

Always runs after the pipeline completes — whether it succeeded or failed. Use for cleanup like closing connections or flushing logs. Only runs for `eval()` and `cli()`. Runs in two layers: command-level shutdown handlers run first (for the route/validate/execute scope), then root-level shutdown handlers (for the full pipeline scope).

```typescript
const cleanup = defineInterceptor({ name: 'cleanup' }, () => ({
  shutdown: (ctx, next) => {
    if (ctx.error) {
      console.error('Failed:', ctx.error);
    }
    db.close();
    return next();
  },
}));
```

**Context:**
| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | The resolved command (target command for command-level, root for root-level) |
| `error` | `unknown \| undefined` | The error, if the pipeline failed |
| `result` | `unknown \| undefined` | The pipeline result, if it succeeded |
| `signal` | `AbortSignal` | Cancellation signal |
| `context` | `unknown` | User-provided context |
| `caller` | `string` | Invocation method |

### Middleware Order

Interceptors compose as an onion — the first registered interceptor is the outermost wrapper:

```typescript
program
  .intercept(interceptorA)  // Outermost — runs first on entry, last on exit
  .intercept(interceptorB)  // Inner
  .intercept(interceptorC); // Innermost — runs last on entry, first on exit
```

Program-level interceptors always wrap subcommand interceptors:

```
Program interceptors (outermost) → Subcommand interceptors (inner) → Action handler (core)
```

#### Explicit Ordering

Use the `order` property to control position. Lower values run as outermost wrappers:

```typescript
const auth = defineInterceptor({ name: 'auth', order: -10 }, () => ({
  execute: (ctx, next) => {
    if (!isAuthenticated()) throw new Error('Not authenticated');
    return next();
  },
}));

const metrics = defineInterceptor({ name: 'metrics', order: 10 }, () => ({
  execute: (ctx, next) => {
    const result = next();
    reportMetrics(ctx.command.name);
    return result;
  },
}));
```

Interceptors with the same `order` (default: `0`) preserve their registration order.

Built-in extensions use negative orders to ensure they wrap user interceptors:

```
-2000  signal        (outermost)
-1100  autoOutput
-1001.5 help
-1001  color, stdin
-1000  version, repl
-999   interactive
-500   suggestions
  0    user interceptors (default)
```

#### Deduplication with `id`

When multiple interceptors share the same `id`, the **last one wins**. This lets you override built-in behavior:

```typescript
// The built-in auto-output interceptor has id: 'padrone:auto-output'
// Override it to disable for a specific command:
builder.intercept(defineInterceptor({
  name: 'no-auto-output',
  id: 'padrone:auto-output',
  disabled: true,
}, () => ({})));
```

### Cross-Phase State

Use the `defineInterceptor` factory's closure to share state across phases within a single execution. Each execution gets a fresh factory call, so state is isolated:

```typescript
const auditInterceptor = defineInterceptor({ name: 'audit' }, () => {
  let startTime: number;
  let parsedCommand: string;

  return {
    parse: (ctx, next) => {
      startTime = Date.now();
      const result = next();
      parsedCommand = result.command.name;
      return result;
    },
    execute: (ctx, next) => {
      const result = next();
      auditLog({ command: parsedCommand, duration: Date.now() - startTime });
      return result;
    },
  };
});
```

### Short-Circuiting

Return early without calling `next()` to skip the rest of the chain:

```typescript
const dryRun = defineInterceptor({ name: 'dry-run' }, () => ({
  execute: (ctx, next) => {
    if (ctx.args.dryRun) {
      console.log('Dry run — skipping execution');
      return { result: undefined };
    }
    return next();
  },
}));
```

### Overriding Phase Inputs

Pass overrides to `next()` to modify values for downstream interceptors:

```typescript
const signalInterceptor = defineInterceptor({ name: 'signal' }, () => ({
  start: (ctx, next) => {
    const controller = new AbortController();
    // Downstream phases see the new signal
    return next({ signal: controller.signal });
  },
}));
```

This is how the built-in signal extension propagates the `AbortSignal` — it creates an `AbortController` in the start phase and passes the signal downstream via `next({ signal })`.

### Context-Providing Interceptors

Interceptors can declare what they add to the context using `.provides()` and what they require with `.requires()`. The types have no runtime effect but enable typed `ctx.context` access:

```typescript
const withDb = defineInterceptor({ name: 'with-db' })
  .provides<{ db: Database }>()
  .factory(() => ({
    execute: (ctx, next) => {
      const db = createDatabase();
      return next({ context: { ...ctx.context, db } });
    },
  }));

// When this interceptor is registered, ctx.context.db is typed
```

The `padroneProgress()` extension uses this pattern — it declares `.provides<{ progress: PadroneProgress }>()` so `ctx.context.progress` is fully typed when the extension is applied.

Pass interceptor ids to `.requires()` (or `requires` in the meta) to also check at runtime that they're registered on the command or a parent. A command that runs without one fails with `Interceptor "audit" requires "padrone:logger", which isn't registered on this command or its parents`:

```typescript
const audit = defineInterceptor({ name: 'audit' })
  .requires<{ logger: PadroneLogger }>('padrone:logger')
  .factory(() => ({
    execute: (ctx, next) => {
      ctx.context.logger.info(`running ${ctx.command.path}`);
      return next();
    },
  }));
```

### Custom Events

Extensions can talk to each other through custom events, like oclif's `runHook`. Define an event with its payload type, handle it with `.on()` on an interceptor, and emit it with `ctx.emit()` from an action or an interceptor phase:

```typescript
import { defineEvent, defineInterceptor } from 'padrone';

export const deployed = defineEvent<{ env: string; version: string }>('myapp:deployed');

const slack = defineInterceptor({ name: 'slack' }, () => ({})).on(deployed, async (payload, ctx) => {
  await postToSlack(`Deployed ${payload.version} to ${payload.env}`);
});

program
  .intercept(slack)
  .command('deploy', (c) =>
    c.action(async (args, ctx) => {
      const version = await deploy(args.env);
      await ctx.emit(deployed, { env: args.env, version });
    }),
  );
```

`ctx.emit()` runs the handlers of the interceptors on the running command's chain (root and command-level, skipping disabled ones, non-inherited ones from parents and those `callers` filters out), one after another in interceptor order, and resolves once they've all run; a handler's error rejects it. Handlers get the payload and a context with the `command`, `runtime`, `context`, `caller`, `signal`, `program` and `emit`. `program.emit(event, payload)` emits outside any execution, to the root's interceptors (`caller: 'run'`). Handlers can also be given in the meta: `on: { [deployed.id]: handler }` (the payload is then untyped).

### Sync Preservation

Interceptors preserve sync/async behavior. If your interceptor and all inner interceptors are synchronous, the entire chain stays synchronous. Only return a Promise when you need async operations:

```typescript
// Sync interceptor — chain stays sync
const syncInterceptor = defineInterceptor({ name: 'sync' }, () => ({
  execute: (ctx, next) => {
    console.log('before');
    const result = next();
    console.log('after');
    return result;
  },
}));

// Async interceptor — chain becomes async
const asyncInterceptor = defineInterceptor({ name: 'async' }, () => ({
  execute: async (ctx, next) => {
    await someAsyncWork();
    return next();
  },
}));
```

### Which Methods Run Which Phases

| Method | Start | Parse | Route | Validate | Execute | Error | Shutdown |
|--------|-------|-------|-------|----------|---------|-------|----------|
| `eval()` / `cli()` | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `parse()` | No | Yes | No | Yes | No | No | No |
| `run()` | No | No | No | No | Yes | No | No |

To run an interceptor for some callers only, set `callers` in its meta: `defineInterceptor({ name: 'stdin', callers: LOCAL_CALLERS }, ...)` skips it for `serve`, `mcp` and `tool()` calls.

### How Built-in Extensions Use Interceptors

Understanding how built-in features are implemented helps illustrate the interceptor model:

**Signal handling** (`padroneSignalHandling`, order: -2000) — The outermost interceptor. In the start phase, creates an `AbortController` and subscribes to OS signals via `runtime.onSignal()`; it also aborts when the caller's `signal` (`eval(input, { signal })`) does. Passes the signal to all downstream phases via `next({ signal })`. The signal is aborted with a `SignalError` as its `reason`, so `ctx.signal.throwIfAborted()` (or an aborted `fetch`) exits with the signal's code (130 for SIGINT). In the error phase, wraps errors with signal info. In shutdown, cleans up subscriptions. Implements double-tap SIGINT force-exit (and force-exit on a repeated SIGTERM/SIGHUP) using closure state shared across phases.

**Auto-output** (`padroneAutoOutput`, order: -1100) — In the execute phase, intercepts the action result and writes it to `runtime.output()`. Handles promises (awaits), iterators (consumes and outputs each value), and plain values. In the error phase of `cli()`, prints the message of any error that no inner extension printed (help prints routing and validation errors), whichever phase threw it. Under JSON output (`--json`), it prints every error as `{ "error": { ... } }` on stdout instead. Extensions that print an error themselves call `markErrorReported(error)` so it isn't printed twice.

**Help** (`padroneHelp`, order: -1001.5) — Adds a `help` command and registers an interceptor with parse, validate, execute, and error phases. The parse phase detects `--help` flags; the execute phase renders the help, so flags read later in parsing (`--no-color`, `--json`) apply. Under JSON output the help is returned as an object. The error phase formats routing/validation errors with help text in CLI mode.

**Config file loading** (`padroneConfig`, order: -999.5) — Not included by default; must be explicitly applied via `.extend(padroneConfig(...))`. In the validate phase, loads the config file from the file system (or via a custom `loadConfig` function) and merges values into `rawArgs` before schema validation. Only keys the command has options for are applied (by option name, alias or kebab-case name), so one config file can serve every command; `null` means unset (in nested objects too), nested objects are filled key by key under CLI values, and positionals typed on the command line win. It runs inside env (env values win) and outside interactive prompting (values from config aren't prompted for). `--config`/`-c` (and with `profiles: true`, `--profile <name>`) is declared through `meta.options` and listed in help through `meta.helpOptions`; a profile selected by `--profile` or `<PROGRAM>_PROFILE` applies the config's `profiles.<name>` over its top-level values, and with `sections: true` the sections of the commands on the way (`serve: { ... }`) apply next. `--config` and `--profile` are read only for local callers: for serve, MCP and `tool()` calls they stay unknown options (unless `profiles: { remote: true }`), so a request can't make the program read a local file or switch profiles. Like env, it skips built-in commands (`builtin: true`, `isBuiltinCommand`) unless `builtins: true`, and names the file in validation errors about the values it filled. With `command: true`, it adds a `config` group whose `set`/`unset` write the JSON file (and `edit` any file but a script) in the user config directory (`program.dirs.config`); the group disables the interceptor for itself.

**Interactive prompting** (`padroneInteractive`, order: -999) — In the validate phase, prompts for missing field values via `runtime.prompt()` and injects responses into `rawArgs` before validation.

**Suggestions** (`padroneSuggestions`, order: -500) — In parse and validate error paths, enriches error messages with fuzzy-matched "Did you mean?" suggestions. With `builtins: { suggestions: { run: 'prompt' } }`, an unknown command in `cli()` or the REPL asks "Run "deploy" instead?" and, if accepted, parses again with the correction.

## Disabling and Overriding Built-in Extensions

### Disabling at Creation

```typescript
const program = createPadrone('myapp', {
  builtins: {
    help: false,
    version: false,
    repl: false,
    color: false,
    suggestions: false,
    signal: false,
    autoOutput: false,
    stdin: false,
    interactive: false,
  },
});
```

`help` also accepts options instead of `false`: `builtins: { help: { showHelpOnError: true } }` prints the full help after a routing or validation error, instead of the default one-line `--help` hint. `builtins: { help: { pager: true } }` shows help taller than the terminal through a pager, like git (`$PAGER`, or `less -FRX`; only in `cli()` on a terminal; `--no-pager` prints it directly). For other long output, call `ctx.runtime.page(text)` from an action. `builtins: { help: { pickSubcommand: true } }` asks which subcommand to run, with a select prompt, when a command that only groups subcommands runs without one (like `gh`); `--help` still shows help. `builtins: { help: { topics } }` adds help topics (`app help environment`), listed under "Additional help topics".

### Overriding via Deduplication

Built-in interceptors use `id` fields like `'padrone:help'`, `'padrone:auto-output'`, etc. Register an interceptor with the same `id` to replace the built-in behavior:

```typescript
// Custom help interceptor that replaces the built-in one
program.intercept(defineInterceptor({
  name: 'custom-help',
  id: 'padrone:help',
  order: -1000,
}, () => ({
  parse: (ctx, next) => {
    // Custom help flag handling
    return next();
  },
})));
```
