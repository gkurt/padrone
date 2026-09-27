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
| `z.array(z.string())` | `--tags foo --tags bar` or `--tags=[foo,bar]`; with `.meta({ variadic: true })` also `--tags foo bar` |
| `z.union([z.boolean(), z.string()])` | `--cache` (→ `true`) or `--cache dir` (→ `"dir"`) |
| `z.object({ host: z.string() })` | `--db.host localhost` or `--db '{"host":"localhost"}'` |
| `z.record(z.string(), z.string())` | `--labels.env prod` or `--labels '{"app.kubernetes.io/name":"web"}'` |
| `z.array(z.object({ name: z.string() }))` | `--items '[{"name":"a"},{"name":"b"}]'` or `--items '{"name":"a"}' --items '{"name":"b"}'` |

Parsing follows the schema, so each option consumes values according to its type:

- A boolean never takes the next argument, so `build --verbose file.txt` keeps `file.txt` as a positional. An explicit boolean word is still accepted: `--verbose false` or `--verbose=off`.
- An option that needs a value takes the next argument even if it starts with `-`: `--offset -5`, `--pattern -foo`. A missing value is reported as `Option "--name" requires a value`.
- An option whose type allows both a boolean and a value (`--cache [dir]`) takes the next argument only when it doesn't look like an option or a subcommand.
- A repeated option keeps the last value (`--name a --name b` → `"b"`); array options collect every value.
- The `[a,b]` bracket syntax only applies to array options — `--title=[WIP]` stays a string.
- Objects, records and arrays of objects take a JSON value (a JSON object, or for arrays a JSON array or one object per occurrence). Dotted keys merge with it, the later value winning: `--db '{"host":"x","port":1}' --db.port 2` gives `{ host: 'x', port: 2 }`. Invalid JSON is reported as `Option "--db" has invalid JSON: …`. A JSON string from an env variable or a `fromFile` file (`--db @db.json`) is parsed too.
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

Options can depend on each other, and secrets can be kept out of help and prompts:

```typescript
z.object({
  user: z.string().optional().meta({ requires: 'password' }),              // --user needs --password
  password: z.string().optional().meta({ sensitive: true }),               // masked prompt, no help default
  format: z.enum(['file', 'stdout']).default('stdout'),
  output: z.string().optional().meta({ requiredIf: { format: 'file' } }),  // needed with --format file
  token: z.string().optional().meta({ requiredUnless: 'user' }),           // needed unless --user is given
})
```

See [Dependent options](/padrone/reference/args-meta/#dependent-options) and [Sensitive values](/padrone/reference/args-meta/#sensitive-values).

> **Note:** Single-character short flags use `flags`, not `alias`. The `alias` field is for multi-character long alternatives. By default, camelCase names automatically get kebab-case aliases (e.g., `dryRun` → `--dry-run`). For booleans, `negative` defines custom keyword(s) that set the option to `false` and disables the default `--no-` prefix (see [Arguments Metadata reference](/padrone/reference/args-meta/#custom-negation)).

### Values from Files and Response Files

With `fromFile: true`, a value can name a file to read it from: `--body @notes.md` reads the file, `--body -` reads stdin, and `@@text` passes `@text`. Only command-line values are read — never env, config, or serve/MCP/`tool()` args (see [Values from Files](/padrone/reference/args-meta/#values-from-files)).

```typescript
.arguments(z.object({ body: z.string() }), { fields: { body: { fromFile: true } } })
```

For long command lines, `padroneResponseFiles()` expands `@file` arguments into the arguments listed in the file (see the [API reference](/padrone/reference/api/#padroneresponsefilesoptions)):

```bash
app @deploy-args.txt deploy   # deploy-args.txt: "--env staging" on one line, "--tag v2" on the next
```

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

### Global Options

Options defined with `.globalArgs()` are accepted by a command and every subcommand below it, before or after the subcommand name, and merged into each command's `args`:

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
  );
```

```bash
app deploy prod -v --profile ci
app -v --profile ci deploy prod
```

A subcommand can **override** a global by defining a field with the same name in its own `.arguments()`, or **extend** the globals for its subtree with the function form:

```typescript
program
  .command('scale', (c) => c.arguments(z.object({ verbose: z.number().optional() })).action((args) => args.verbose)) // number
  .command('cloud', (c) =>
    c
      .globalArgs((inherited) => inherited.extend({ region: z.string().optional() }))
      .command('up', (u) => u.action((args) => args.region)),
  );
```

Global args are validated against their own schema and listed under "Global Options" in help, man pages, generated docs and shell completions.

A command with `interactive: true` also prompts for missing required global args. To prompt in every command of a subtree, pass it to `.globalArgs()`:

```typescript
program.globalArgs(z.object({ token: z.string() }), { interactive: ['token'] }); // every command becomes async
```

To copy a parent's options into a single subcommand instead, pass a function to `.arguments()`: `.arguments((parent) => parent.extend({ file: z.string() }))`. Define the parent's schema before its subcommands so the parameter is typed.

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

For a simple one-to-one mapping, skip the schema and use `vars`. Values are coerced by the command's schema like CLI input, the first variable that is set wins, and the variables are listed in help as `Env: APP_PORT`:

```typescript
.extend(padroneEnv({ vars: { port: 'APP_PORT', apiKey: ['API_KEY', 'APP_API_KEY'] } }))
```

To also read `.env` files, pass any file option: `modes` (loads `.env.{mode}` files too), `dir`, `local`, `base` or `override`. `padroneEnv({ dir: '.', vars })` loads `.env` and `.env.local` from the current directory; values already in the environment win unless `override: true`.

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

Multiple config file paths can be provided in the `files` array — the first existing file is used. The `--config <path>` / `-c <path>` flag picks a file explicitly (not for serve, MCP and `tool()` calls, which can't point the program at a local file); a missing or unparsable file is a `ConfigError`, and an empty one is an empty config. JSON (with comments and trailing commas), JavaScript and TypeScript modules work everywhere; YAML and TOML need Bun, or a custom `loadConfig`. If no schema is provided, config values are matched against the argument schema directly. `padroneConfig` can be applied at the program level (inherited by all commands) or at the command level.

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

### Customizing Help

Pass `help` to `.configure()` as a declarative object, which applies to that command only:

```typescript
.command('deploy', (c) =>
  c.configure({
    help: {
      usage: 'app deploy <env> [--force]',       // replaces the generated usage line
      before: 'Beta: this command may change.',  // shown before the help
      after: 'Docs: https://example.com/deploy', // shown after the help
    },
  }),
)
```

Or as a function, which applies to that command and its subcommands (a subcommand's own function wins). It receives the generated help info, with any declarative parts applied, and returns modified info, rendered in the requested format, or the final string:

```typescript
program.configure({
  help: (info, ctx) => ({ ...info, after: 'Report issues at https://example.com/issues' }),
});

program.configure({
  help: (info, ctx) => `${banner}\n${ctx.render(info)}`, // ctx.render uses the built-in formatter
});
```

`ctx` also has the `command`, the requested `format` and the `detail` level. The customization is used everywhere help is shown: `--help`, `help <command>`, `program.help()`, errors with `showHelpOnError`, and generated docs.

`--version` works on every command that doesn't define a `version` option itself; single-character version flags (`-v`, `-V`) only on the root command, since subcommands often use `-v` for verbose. `my-cli version --verbose` also shows the runtime, platform, architecture and shell (an object under `--json`); `version: { info: () => ({ Channel: 'beta' }) }` adds fields. `my-cli version --check` also asks the registry and adds an "Update available" notice when there's a newer version, like `gh version`. Without `.configure({ version })`, the version is read from the nearest `package.json` above the program's script, not from the working directory.

The help and version flags can be renamed, or removed by passing `[]` (the `help` and `version` commands remain):

```typescript
createPadrone('app', {
  builtins: {
    help: { flags: ['help', '?'] },  // --help, -?
    version: { flags: ['version'] }, // --version only, freeing -v and -V
  },
});
```

Long help can go through a pager, like `git help`: with `help: { pager: true }`, help that's taller than the terminal opens in `$PAGER`, or `less -FRX` when it isn't set (it quits right away if the help fits and keeps colors; there's no default pager on Windows). It only applies to `cli()` when stdout is a terminal. `PAGER=cat` turns it off, `--no-pager` prints the help directly for one run, and `--pager` pages it even when it fits. Pass a string (`pager: 'less -R'`) to choose the pager used when `$PAGER` isn't set.

Guides that aren't about one command can be help topics, like `gh help environment` or cobra's "Additional help topics":

```typescript
createPadrone('app', {
  builtins: {
    help: {
      topics: {
        environment: {
          title: 'Environment variables',
          description: 'Variables that configure app', // shown in the program's help
          content: '# Environment\n\n- `APP_TOKEN`: the API token',
        },
        formatting: { content: ({ format }) => formattingGuide(format) },
      },
    },
  },
});
```

`app help environment` prints the topic's content as is (through the pager when it's on), or `{ topic, title, content }` under JSON output. The program's help lists topics under "Additional help topics", `help <typo>` suggests topic names, and shell completion offers them after `help`. A command of the same name takes precedence. `generateDocs()` writes each topic to `topics/<name>.md` in Markdown output.

`app help --search <term>` (or `-s`) searches the whole tree, like `npm help-search`: it lists the commands whose name, aliases or description contain every word of the term (ignoring case), then the matching topics (by name, title, description or text), or `{ commands, topics }` under JSON output.

## Dry Runs

Commands that change things can offer a dry run with `.dryRun()`. The command then accepts `--dry-run` (or `-n`), and under that flag the dry-run handler runs instead of the action: arguments are parsed and validated as usual, but the action is never called.

```typescript
.command('deploy', (c) =>
  c
    .configure({ mutation: true })
    .arguments(z.object({ env: z.enum(['staging', 'production']) }), { positional: ['env'] })
    // Both return the list of changes: applied by the action, planned by the dry run
    .action(async (args) => ({ changes: await deploy(args.env) }))
    .dryRun(async (args) => ({ changes: await planDeploy(args.env) })),
)
```

```bash
my-cli deploy production --dry-run   # prints the planned changes, deploys nothing
```

The flag exists only on commands with a dry-run handler, and help shows it only there. On any other command `--dry-run` is rejected as an unknown option, so a command can't silently ignore it and make changes. Execute interceptors still run with `ctx.dryRun` set, and `padroneConfirm()` skips its prompt, since nothing will change.

Try to return the same type from the dry-run handler as from the action, as above: code calling the command then handles one result shape, and its result type doesn't change. If the types differ, the command's result type becomes the union of both. Declare `.dryRun()` after `.action()`, because `.action()` sets the result type.

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
