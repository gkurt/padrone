---
title: Commands & Arguments
description: Learn how to define commands and arguments in Padrone
---

This guide covers how to work with commands, arguments, positional arguments, and nested command hierarchies in Padrone.

## Defining Arguments

Arguments are defined using Zod schemas. Each property in the schema becomes a CLI argument:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('app')
  .arguments(
    z.object({
      port: z.number().default(3000).describe('Port to listen on'),
      host: z.string().default('localhost').describe('Host to bind to'),
      verbose: z.boolean().optional().describe('Enable verbose logging'),
    })
  )
  .action((args, ctx) => {
    // args: { port: number; host: string; verbose?: boolean }
    // ctx: { runtime, command, program, progress, context }
  });
```

### Supported Types

Padrone supports these Zod types:

| Zod Type | CLI Input Example |
|----------|-------------------|
| `z.string()` | `--name "John"` |
| `z.number()` | `--port 3000` |
| `z.boolean()` | `--verbose` or `--no-verbose` (customizable via `negative` meta) |
| `z.enum(['a', 'b'])` | `--level high` |
| `z.array(z.string())` | `--tags foo --tags bar` or `--tags=[foo,bar]` |
| `z.union([z.boolean(), z.string()])` | `--cache` (→ `true`) or `--cache dir` (→ `"dir"`) |

Parsing follows the schema, so each option consumes values according to its type:

- A boolean never takes the next argument, so `build --verbose file.txt` keeps `file.txt` as a positional. An explicit boolean word is still accepted: `--verbose false` or `--verbose=off`.
- An option that needs a value takes the next argument even if it starts with `-`: `--offset -5`, `--pattern -foo`. A missing value is reported as `Option "--name" requires a value`.
- An option whose type allows both a boolean and a value (`--cache [dir]`) takes the next argument only when it doesn't look like an option or a subcommand.
- A repeated option keeps the last value (`--name a --name b` → `"b"`); array options collect every value.
- The `[a,b]` bracket syntax only applies to array options — `--title=[WIP]` stays a string.
- `--` ends option parsing; everything after it is positional. A lone `-` is a positional (commonly stdin).

### Argument Flags

Add short flags using `.meta()`:

```typescript
z.object({
  port: z.number().default(3000).meta({ flags: 'p' }),
  verbose: z.boolean().optional().meta({ flags: 'v' }),
})
```

Users can now use `-p 8080` instead of `--port 8080`. Short flags are single-character and stackable: `-vp 8080` = `-v -p 8080`. A flag that takes a value can have it attached: `-p8080`, `-p=8080`, or `-vp8080`.

### Argument Metadata

The `.meta()` method supports several properties:

```typescript
z.string().meta({
  flags: 'o',              // Short flag (-o)
  alias: 'out',            // Long alias (--out)
  negative: 'remote',      // Custom negation keyword (booleans only)
  examples: ['file.txt'],  // Example values for help text
  deprecated: 'Use --out', // Deprecation warning
  hidden: true,            // Hide from help output
  group: 'Output',         // Group in help output
})
```

> **Note:** Single-character short flags use `flags`, not `alias`. The `alias` field is for multi-character long alternatives. By default, camelCase names automatically get kebab-case aliases (e.g., `dryRun` → `--dry-run`). For booleans, `negative` defines custom keyword(s) that set the option to `false` and disables the default `--no-` prefix (see [Arguments Metadata reference](/padrone/reference/args-meta/#custom-negation)).

## Positional Arguments

Positional arguments let users provide values without argument names:

```typescript
.arguments(
  z.object({
    source: z.string().describe('Source file'),
    dest: z.string().describe('Destination file'),
  }),
  { positional: ['source', 'dest'] }
)
```

```bash
# Both are equivalent:
app copy file.txt backup.txt
app copy --source file.txt --dest backup.txt
```

### Variadic Arguments

Use `...` prefix for variadic (rest) arguments that capture multiple values:

```typescript
.arguments(
  z.object({
    files: z.array(z.string()).describe('Files to process'),
    output: z.string().describe('Output directory'),
  }),
  { positional: ['...files', 'output'] }
)
```

```bash
app process a.txt b.txt c.txt ./out
# files: ['a.txt', 'b.txt', 'c.txt'], output: './out'
```

## Commands

Add commands using the `.command()` method:

```typescript
const program = createPadrone('git')
  .command('clone', (c) =>
    c
      .arguments(
        z.object({
          url: z.string().describe('Repository URL'),
          depth: z.number().optional().describe('Clone depth'),
        }),
        { positional: ['url'] }
      )
      .action((args) => {
        console.log(`Cloning ${args.url}`);
      })
  )
  .command('status', (c) =>
    c.action(() => {
      console.log('On branch main');
    })
  );
```

### Command Configuration

Configure commands with `.configure()`:

```typescript
.command('serve', (c) =>
  c
    .configure({
      title: 'Dev Server',
      description: 'Start the development server',
    })
    .arguments(schema)
    .action(handler)
)
```

### Nested Commands

Commands can contain subcommands to any depth:

```typescript
const program = createPadrone('db')
  .command('migrate', (c) =>
    c
      .command('up', (c) =>
        c.action(() => console.log('Running migrations'))
      )
      .command('down', (c) =>
        c
          .arguments(z.object({ steps: z.number().default(1) }))
          .action((args) => console.log(`Rolling back ${args.steps} migrations`))
      )
      .command('status', (c) =>
        c.action(() => console.log('Migration status'))
      )
  );
```

```bash
db migrate up
db migrate down --steps 3
db migrate status
```

### Sharing Options With Subcommands

Pass a function to `.arguments()` to extend the parent command's schema. The subcommand then accepts the parent's options too, before or after its own name:

```typescript
const program = createPadrone('app')
  .arguments(z.object({ verbose: z.boolean().optional().meta({ flags: 'v' }) }))
  .command('rm', (c) =>
    c
      .arguments((parent) => parent.extend({ file: z.string() }), { positional: ['file'] })
      .action((args) => args), // { verbose?: boolean; file: string }
  );
```

```bash
app rm x.txt -v
app -v rm x.txt
```

Define the parent's schema before its subcommands so the parameter is typed.

## Environment Variables

Bind arguments to environment variables using the `padroneEnv` extension:

```typescript
import { createPadrone, padroneEnv } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('app')
  .command('serve', (c) =>
    c
      .arguments(
        z.object({
          port: z.number().default(3000),
          apiKey: z.string().describe('API key'),
        }),
      )
      .extend(
        padroneEnv(
          z.object({
            APP_PORT: z.coerce.number().optional(),
            API_KEY: z.string().optional(),
          }).transform((env) => ({
            port: env.APP_PORT,
            apiKey: env.API_KEY,
          }))
        )
      )
      .action((args) => {
        console.log(`Server on port ${args.port}`);
      }),
  );
```

The env schema validates `process.env` and transforms env var names into argument names. `padroneEnv` can be applied at the program level (inherited by all commands) or at the command level.

A variable that is set but invalid (e.g. `APP_PORT=abc`) is reported as a validation error. A variable that isn't set is skipped, leaving the argument to the CLI or its default, so keep env fields `.optional()`.

Priority order: CLI argument > Stdin > Environment variable > Config file > Interactive prompt > Default value

## Config Files

Load arguments from configuration files using the `padroneConfig` extension:

```typescript
import { createPadrone, padroneConfig } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('app')
  .command('serve', (c) =>
    c
      .arguments(
        z.object({
          port: z.number().default(3000),
          host: z.string().default('localhost'),
        }),
      )
      .extend(
        padroneConfig({
          files: ['app.config.json', '.apprc'],
          schema: z.object({
            port: z.number().optional(),
            host: z.string().optional(),
          }),
        })
      )
      .action((args) => {
        console.log(`Server on ${args.host}:${args.port}`);
      }),
  );
```

Multiple config file paths can be provided in the `files` array — the first existing file is used. If no schema is provided, config values are matched against the argument schema directly. `padroneConfig` can be applied at the program level (inherited by all commands) or at the command level.

Priority order: CLI argument > Stdin > Environment variable > Config file > Interactive prompt > Default value

## Interactive Prompting

Commands can prompt users for missing field values when running in an interactive terminal. This is configured in the arguments meta and requires the runtime to have `interactive: true`.

```typescript
const program = createPadrone('app')
  .runtime({ interactive: true })
  .command('init', (c) =>
    c
      .arguments(
        z.object({
          name: z.string().describe('Project name'),
          template: z.enum(['react', 'vue', 'svelte']).describe('Starter template'),
          typescript: z.boolean().default(false).describe('Use TypeScript'),
        }),
        {
          interactive: ['name', 'template'],
          optionalInteractive: ['typescript'],
        }
      )
      .action((args) => {
        console.log(`Creating ${args.name} with ${args.template}`);
      })
  );
```

Running `app init` without arguments will:
1. Prompt for `name` (text input) and `template` (select from enum choices)
2. Ask "Would you also like to configure:" with `typescript` as a choice
3. Prompt for any selected optional fields

Values provided via CLI, env vars, or config files skip the prompt. Running `app init myproject --template react` only prompts for nothing — all required interactive fields are already provided.

Interactive prompting only occurs in `cli()` and `eval()`, not in `parse()` or `run()`. See the [Interactive Prompting guide](../interactive-prompting/) for full details.

## Help Generation

Padrone automatically generates help text:

```typescript
// Print help for the program
console.log(program.help());

// Print help for a specific command
console.log(program.help('migrate up'));

// Different formats
program.help('', { format: 'text' });   // Plain text
program.help('', { format: 'ansi' });   // With colors
program.help('', { format: 'markdown' });
program.help('', { format: 'html' });
program.help('', { format: 'json' });
```

## Command Override

Re-registering a command with the same name merges the new definition with the existing one. The new handler receives the previous handler as a `base` parameter:

```typescript
const program = createPadrone('app')
  .command('deploy', (c) =>
    c
      .arguments(z.object({ target: z.string() }))
      .action((args) => `deploying to ${args.target}`)
  )
  .command('deploy', (c) =>
    c.action((args, ctx, base) => {
      console.log('Pre-deploy hook');
      const result = base(args, ctx);
      console.log('Post-deploy hook');
      return result;
    })
  );
```

Configuration is shallow-merged, subcommands are recursively merged by name, and aliases are preserved from the original when the override doesn't specify new ones. See the [Program Composition guide](../composition/) for full details.

## Finding Commands

Look up commands programmatically:

```typescript
const migrateUp = program.find('migrate up');
if (migrateUp) {
  console.log(migrateUp.name); // 'up'
}
```
