---
title: Arguments Metadata
description: Reference for Zod meta arguments and positional argument configuration
---

Padrone uses Zod schemas with `.meta()` to configure CLI-specific behavior. This reference covers all available metadata configuration.

## Zod Meta Configuration

Use `.meta()` on individual Zod schema properties to configure their CLI behavior:

```typescript
z.object({
  output: z.string()
    .describe('Output file path')
    .meta({
      flags: 'o',
      alias: 'out',
      examples: ['output.json', './dist/bundle.js'],
    }),
})
```

### Available Meta Properties

| Property | Type | Description |
|----------|------|-------------|
| `flags` | `string \| string[]` | Single-character short flags (e.g., `'p'` for `-p`). Stackable: `-abc` = `-a -b -c` |
| `alias` | `string \| string[]` | Multi-character long aliases (e.g., `'dry-run'` for `--dry-run`) |
| `negative` | `string \| string[]` | Custom negative keyword(s) for booleans. Disables `--no-` prefix |
| `examples` | `unknown[]` | Example values shown in help |
| `deprecated` | `string \| boolean` | Mark as deprecated with optional message |
| `hidden` | `boolean` | Hide from help output |
| `group` | `string` | Group name for organizing under a labeled section in help output |
| `count` | `boolean` | Count repeated flags into a number (`-vvv` → `3`) |
| `variadic` | `boolean` | Array option that takes every following value up to the next option (`--tag a b c`) |
| `fromFile` | `boolean` | Command-line values can be `@path` (the file's contents) or `-` (stdin); `@@text` passes `@text` |
| `conflicts` | `string \| string[]` | Options that can't be used together with this one |
| `implies` | `Record<string, unknown>` | Values for other options when this one is used |
| `requires` | `string \| string[]` | Options that must be provided when this one is |
| `requiredIf` | `Record<string, unknown> \| Record<string, unknown>[]` | Required when other options have these values (any object of an array) |
| `requiredUnless` | `string \| string[]` | Required unless one of these options is provided |
| `sensitive` | `boolean` | Secret value: prompted without echo, default and examples hidden from help and tool schemas |
| `complete` | `(ctx) => (string \| { value, description? })[]` (or a Promise) | Values shell completion offers for this option or positional (`fields` config only; needs `padroneCompletion()`) |
| `hint` | `'file' \| 'dir' \| 'url' \| 'command' \| 'none' \| { ext: string[] }` | What shell completion falls back to for the value (see [Value hints](#value-hints)) |
| `valueName` | `string` | Placeholder for the value in help and docs (`--out <DIR>`, `<FILE>` for a positional) |

:::note
Single-character short flags use `flags`, not `alias`. The `alias` field is for multi-character long alternatives like `--dry-run` for `--dryRun`.
:::

---

## Meta Configuration

The second argument to `.arguments()` configures positional arguments and per-argument metadata:

```typescript
.arguments(schema, {
  positional: ['source', '...files', 'dest'],
  fields: {
    verbose: { flags: 'v' },
    dryRun: { alias: 'dry' },
    format: { deprecated: 'Use --output instead' },
  },
})
```

### positional

Array of argument names to accept as positional arguments.

```typescript
{ positional: ['source', 'dest'] }
```

**Positional argument order:**
- Arguments are matched in the order specified
- Optional arguments are skipped if not provided
- Position matters: `['source', 'dest']` means first arg is source, second is dest
- Extra arguments are an error (`Too many arguments`), as are positionals given to a command that declares none. Use a variadic (`...rest`) to accept any number

**Variadic arguments:**
- Prefix with `...` to capture multiple values: `['...files']`
- Variadic args must be arrays in the schema: `z.array(z.string())`
- Only one variadic argument is allowed per command
- Variadic can be at any position

```typescript
// Capture all args between fixed positions
{ positional: ['command', '...args', 'output'] }
// command = first arg
// args = all middle args
// output = last arg
```

### fields

Per-argument configuration that supplements or overrides `.meta()`:

```typescript
{
  fields: {
    verbose: { flags: 'v' },
    dryRun: { alias: 'dry' },
    format: {
      deprecated: 'Use --output instead',
      hidden: true,
    },
  },
}
```

This is equivalent to using `.meta()` on the schema property but allows configuration to be kept separate from the schema definition. Fields accept the same properties as Zod `.meta()`: `flags`, `alias`, `negative`, `description`, `examples`, `deprecated`, `hidden`, `group`, `count`, `variadic`, `fromFile`, `conflicts`, `implies`, `requires`, `requiredIf`, `requiredUnless`, `sensitive`, `hint`, `valueName` — plus `complete`, which only works here since functions don't survive `.meta()`.

### autoAlias

Automatically generate kebab-case aliases for camelCase argument names. Enabled by default.

```typescript
// Default (autoAlias: true): --dry-run automatically maps to dryRun
.arguments(z.object({ dryRun: z.boolean() }))

// Disable auto-aliases
.arguments(z.object({ dryRun: z.boolean() }), { autoAlias: false })
```

### exactlyOne / atLeastOne

Groups of options of which exactly one, or at least one, must be given. See [Option groups](#option-groups).

```typescript
.arguments(schema, { exactlyOne: ['file', 'url'], atLeastOne: ['email', 'slack'] })
```

### stdin

Read from stdin and inject the data into a specified argument field. Only reads when stdin is piped (not a TTY) and the field wasn't already provided via CLI flags. The read mode is inferred from the schema: `string` fields read all stdin as text, `string[]` fields read line-by-line.

```typescript
// Read all stdin as text into 'data' field
.arguments(z.object({ data: z.string() }), { stdin: 'data' })

// Read stdin line-by-line into an array field (inferred from array schema)
.arguments(
  z.object({ lines: z.array(z.string()) }),
  { stdin: 'lines' }
)

// Stream stdin lazily as AsyncIterable (for large inputs)
import { zodAsyncStream } from 'padrone/zod';
.arguments(
  z.object({ lines: zodAsyncStream() }),
  { stdin: 'lines' }
)

// Typed stream with JSON codec (each line JSON.parse'd and validated)
import { zodAsyncStream, jsonCodec } from 'padrone/zod';
const itemSchema = z.object({ name: z.string(), age: z.number() });
.arguments(
  z.object({ records: zodAsyncStream(jsonCodec(itemSchema)) }),
  { stdin: 'records' }
)
```

### interactive

Declare which fields should be interactively prompted when their values are missing after CLI/env/config resolution. Only takes effect in `cli()` and `eval()` when the runtime has `interactive: true`.

```typescript
// Prompt all missing required fields
{ interactive: true }

// Prompt specific fields
{ interactive: ['name', 'template'] }
```

When `interactive` is set, `parse()` and `cli()` return Promises (the command becomes async).

Prompt types are auto-detected from the schema:

| Schema Type | Prompt |
|---|---|
| `z.boolean()` | Confirm (yes/no) |
| `z.enum([...])` | Select (single choice) |
| `z.array(z.enum([...]))` | Multi-select |
| `z.string()` | Text input |
| Any other type | Text input |

The prompt message is derived from the field's `.describe()` text, or from `fields` meta `description`, falling back to the field name.

### optionalInteractive

Additional fields offered after required interactive prompts. Users are shown a multi-select to choose which of these fields to configure.

```typescript
// Offer all missing optional fields
{ optionalInteractive: true }

// Offer specific fields
{ optionalInteractive: ['verbose', 'format'] }
```

**Example combining both:**

```typescript
.arguments(
  z.object({
    name: z.string().describe('Project name'),
    template: z.enum(['react', 'vue', 'svelte']).describe('Starter template'),
    typescript: z.boolean().default(false).describe('Use TypeScript'),
    eslint: z.boolean().default(false).describe('Add ESLint'),
  }),
  {
    positional: ['name'],
    interactive: ['name', 'template'],
    optionalInteractive: ['typescript', 'eslint'],
  }
)
```

When running without arguments, this will:
1. Prompt for `name` and `template` (required interactive fields)
2. Show a multi-select: "Would you also like to configure: TypeScript, ESLint"
3. Prompt individually for any selected optional fields

See the [Interactive Prompting guide](/padrone/guides/interactive-prompting/) for full details.

---

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
          apiKey: z.string(),
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

The env schema validates `process.env` and transforms env var names into argument names. Only provided env values are used — undefined values are skipped, and a set but invalid value is reported as a validation error. `padroneEnv` can be applied at the program level (inherited by all commands) or at the command level.

**Resolution priority:**
1. CLI argument (highest)
2. Stdin
3. Environment variable
4. Config file
5. Interactive prompt (if runtime supports it)
6. Default value (lowest)

---

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
          files: 'app.config.json',
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

Multiple config file paths can be provided in the `files` array — the first existing file is used:

```typescript
.extend(padroneConfig({ files: ['app.config.json', '.apprc'] }))
```

If no schema is provided, the config file values are matched against the command's argument schema directly.

---

## Flags

Short argument flags allow single-character shortcuts:

```typescript
z.object({
  verbose: z.boolean().optional().meta({ flags: 'v' }),
  port: z.number().default(3000).meta({ flags: 'p' }),
  output: z.string().optional().meta({ flags: 'o' }),
})
```

**Usage:**
```bash
app -v -p 8080 -o output.json
# Equivalent to:
app --verbose --port 8080 --output output.json
```

**Combined short flags:**
```bash
app -vp 8080
# -v (boolean) + -p 8080
```

---

## Aliases

Multi-character long aliases provide alternative names for arguments:

```typescript
z.object({
  dryRun: z.boolean().optional().meta({ alias: 'dry' }),
})
```

```bash
app --dry
# Equivalent to:
app --dry-run  # (auto-alias from camelCase)
app --dryRun   # (original name)
```

:::note
By default, camelCase argument names automatically get kebab-case aliases (e.g., `dryRun` → `--dry-run`). This can be disabled with `autoAlias: false` in the arguments meta.
:::

---

## Custom Negation

By default, boolean arguments can be negated with the `--no-` prefix (e.g., `--no-verbose`). The `negative` meta option lets you define custom keyword(s) that set a boolean to `false`, while disabling the default `--no-` prefix:

```typescript
z.object({
  local: z.boolean().default(true).meta({ negative: 'remote' }),
})
```

```bash
app --remote
# Equivalent to: local = false
# --no-local is NOT recognized (disabled by custom negation)

app --local
# local = true (still works normally)
```

**Multiple negative keywords:**
```typescript
z.object({
  local: z.boolean().default(true).meta({ negative: ['remote', 'cloud'] }),
})
```

```bash
app --remote   # local = false
app --cloud    # local = false
```

**Disable `--no-` prefix only:**

Set `negative` to an empty string or empty array to disable the `--no-` prefix without adding any alternative keywords:

```typescript
z.object({
  verbose: z.boolean().default(true).meta({ negative: '' }),
})
```

```bash
app --verbose      # verbose = true
app --no-verbose   # Error: unknown option
```

Custom negation can also be set via `fields` meta:

```typescript
.arguments(z.object({ local: z.boolean().default(true) }), {
  fields: { local: { negative: 'remote' } },
})
```

The `stringify()` method uses the first negative keyword when serializing `false` values:

```typescript
program.stringify('cmd', { local: false })
// → "cmd --remote"  (instead of "cmd --no-local")
```

---

## Deprecation

Mark arguments as deprecated to warn users:

```typescript
.arguments(
  z.object({
    // Simple deprecation
    old: z.string().optional().meta({ deprecated: true }),
    legacy: z.string().optional(),
  }),
  {
    // With a migration message (Zod's own `.meta()` type only allows a boolean here)
    fields: { legacy: { deprecated: 'Use --new-arg instead' } },
  },
)
```

Deprecated arguments still work. They are marked in help, and using one from `cli()` or the REPL prints a warning to stderr, e.g. `Warning: option "--legacy" is deprecated: Use --new-arg instead`. Deprecated commands (`.configure({ deprecated: 'Use "app build"' })`) warn the same way.

---

## Hidden Arguments

Hide arguments from help output while keeping them functional:

```typescript
z.object({
  // Visible in help
  port: z.number().default(3000),

  // Hidden from help
  debug: z.boolean().optional().meta({ hidden: true }),
  internalFlag: z.string().optional().meta({ hidden: true }),
})
```

Hidden arguments:
- Don't appear in `--help` output
- Still work when specified
- Useful for internal/experimental features

---

## Examples in Help

Provide example values for help text:

```typescript
z.object({
  format: z.enum(['json', 'csv', 'xml'])
    .describe('Output format')
    .meta({ examples: ['json', 'csv'] }),

  date: z.string()
    .describe('Date filter')
    .meta({ examples: ['2024-01-01', 'today', 'last-week'] }),
})
```

Examples appear in the generated help text to guide users.

---

## Groups

Organize arguments into labeled sections in help output:

```typescript
z.object({
  port: z.number().default(3000).meta({ group: 'Server' }),
  host: z.string().default('localhost').meta({ group: 'Server' }),
  verbose: z.boolean().optional().meta({ group: 'Debug' }),
  logLevel: z.enum(['info', 'debug', 'warn']).optional().meta({ group: 'Debug' }),
})
```

Arguments with the same group name are displayed together under a labeled section in help output.

---

## Counting Flags

`count: true` on a number option counts how often a flag is given instead of taking a value:

```typescript
z.object({
  verbose: z.number().default(0).meta({ flags: 'v', count: true }),
})
```

`-vvv` and `-v -v --verbose` give `3`. `--verbose=5` sets the count directly and `--no-verbose` resets it to `0`. A counting flag never takes the next argument as its value. Help marks it `(repeatable)`.

---

## Variadic Options

By default an array option takes one value per flag (`--tag a --tag b`). With `variadic: true` it takes every following value up to the next option, `--`, or the end of input:

```typescript
z.object({
  tags: z.string().array().optional().meta({ flags: 't', variadic: true }),
  files: z.string().array().default([]),
}) // with { positional: ['...files'] }
```

`--tags a b c --force` gives `tags: ['a', 'b', 'c']`. Positionals after a variadic option need `--` (`--tags a b -- x.txt`) or can come first (`x.txt --tags a b`). `--tags=a` takes a single value, and repeated flags keep accumulating. Help marks it `(takes multiple values)`.

---

## Values from Files

`fromFile: true` on a string (or string array) option or positional lets its value be read from a file, like `gh -F body=@file` or `curl -d @file`:

```typescript
.arguments(z.object({ title: z.string(), body: z.string() }), {
  positional: ['title'],
  fields: { body: { fromFile: true } },
})
```

- `--body @notes.md` reads `notes.md` (UTF-8, as is; relative to the working directory). A file that can't be read is a validation error, e.g. `body: Cannot read "notes.md": file not found`.
- `--body -` (or `@-`) reads stdin, through the runtime's `stdin`. Only one value per run can read stdin, and not when the command's `stdin` field would read it too.
- `--body @@me` passes `@me`: a leading `@@` escapes the `@`. Other values are taken as given.
- For array options, each value is read on its own: `--tag @a.txt --tag b`.
- Only values typed on the command line (`cli()`, `eval()`, the REPL) are read. Values from env variables and config files, and args from serve, MCP and `tool()` calls, are taken literally, so a remote client can't read the server's files.

Help marks the option `(@file or - for stdin)`. Reading stdin is async, so a command with a `fromFile` field in its `fields` meta is typed as async; set with `.meta({ fromFile: true })` on the schema, mark the command `.async()`.

---

## Conflicting and Implied Options

`conflicts` rejects options used together, and `implies` fills in other options when one is used:

```typescript
z.object({
  json: z.boolean().optional().meta({ conflicts: ['table'], implies: { color: false } }),
  table: z.boolean().optional(),
  color: z.boolean().optional(),
})
```

- `--json --table` fails with `Option "--json" cannot be used with "--table"`. Declaring the conflict on either side is enough.
- `--json` sets `color` to `false` unless `--color` is given explicitly. An option set to `false` (e.g. `--no-json`) implies nothing.
- Only options the user provided count: from the command line, stdin, env or config — not schema defaults or implied values.

Help shows `(conflicts with --table)` and `(implies --no-color)`.

### Option groups

`exactlyOne` and `atLeastOne` in the arguments meta name a group of options (by field name). Pass an array of arrays for several groups:

```typescript
.arguments(z.object({ file: z.string().optional(), url: z.string().optional(), stdin: z.boolean().optional() }), {
  exactlyOne: ['file', 'url', 'stdin'],
})

.arguments(schema, { exactlyOne: [['json', 'yaml'], ['out', 'stdout']] })
```

- No option given fails with `Exactly one of "--file", "--url", "--stdin" is required`, two with `Only one of "--file", "--url" can be used`.
- `atLeastOne` only requires one of them: `At least one of "--email", "--slack" is required`.
- Like `conflicts`, only options the user provided count (command line, stdin, env, config), not schema defaults.
- `.globalArgs(schema, { exactlyOne })` applies the group in every command of the subtree, unless a command defines one of its fields itself.

### Dependent options

`requires`, `requiredIf` and `requiredUnless` make an option required depending on the others:

```typescript
z.object({
  user: z.string().optional().meta({ requires: 'password' }),
  password: z.string().optional(),
  token: z.string().optional().meta({ requiredUnless: ['user', 'key'] }),
  key: z.string().optional(),
  format: z.enum(['file', 'url', 'stdout']).default('stdout'),
  output: z.string().optional().meta({ requiredIf: [{ format: 'file' }, { format: 'url', ci: true }] }),
  ci: z.boolean().optional(),
})
```

- `--user me` alone fails with `Option "--user" requires "--password"`.
- Without `--user` or `--key`: `Option "--token" is required unless one of "--user", "--key" is used`.
- `--format file` without `--output`: `Option "--output" is required when "--format" is "file"`. Every value of an object must match; with an array, any object.
- They're checked after `implies` and coercion: implied values count, and `requiredIf` compares typed values (`{ port: 80 }` matches `--port 80`). Schema defaults don't count.
- Each issue's path is the missing option. With `interactive` covering it, the missing option is prompted instead.
- They work in `.globalArgs()` fields too. Help shows `(requires --password)`, `(required if --format=file or --format=url and --ci)` and `(required unless --user or --key)`.

## Sensitive Values

`sensitive: true` marks a secret such as a token or password:

```typescript
z.object({
  token: z.string().meta({ sensitive: true, description: 'API token' }),
})
```

- Interactive prompts ask for it without echo (`type: 'password'`) and never prefill it.
- Help, generated docs and man pages don't show its default or examples.
- MCP, serve and `tool()` input schemas mark it `writeOnly` without `default` or `examples`.
- Padrone's own error messages never include option values.
- Extensions that log or record args can call `redactArgs(command, args)` (from `'padrone'`): a copy with sensitive fields, nested and global ones included, replaced by `'[redacted]'`.

## Completion Values

With `padroneCompletion()` applied, the generated shell scripts ask the program for candidates on each tab press, so completion follows the command being typed: its subcommands, its own options and inherited global options, and values for the option or positional under the cursor. Enum values are offered automatically; `complete` supplies values computed at completion time:

```typescript
import { padroneCompletion } from 'padrone/completion';

createPadrone('git')
  .extend(padroneCompletion())
  .command('checkout', (c) =>
    c.arguments(z.object({ branch: z.string() }), {
      positional: ['branch'],
      fields: { branch: { complete: async ({ prefix, args, command }) => listBranches() } },
    }),
  );
```

The callback receives the word typed so far (`prefix`), the options typed before it (`args`, parsed but not validated) and the command path. Return candidates unfiltered or filtered, it's up to you: only those starting with the prefix are shown. Errors are swallowed so a failing lookup never breaks the shell.

Candidates can carry a description, which zsh, fish and PowerShell show next to the value (bash shows values only). Subcommands and options are described with their descriptions, and literal unions (`z.union([z.literal('eu').describe('Europe'), ...])`) with each literal's:

```typescript
complete: () => [{ value: 'main', description: 'Default branch' }, 'develop'],
```

### Value hints

When no candidate matches, the shell falls back to file names for a value without enum values or `complete` (a value with candidates gets no fallback). `hint` says what to complete instead:

```typescript
z.object({
  config: z.string().meta({ hint: { ext: ['json', 'yaml'] } }), // *.json, *.yaml and directories
  out: z.string().meta({ hint: 'dir', valueName: 'DIR' }), // directories
  editor: z.string().meta({ hint: 'command' }), // program names
  url: z.string().meta({ hint: 'url' }), // nothing ('none' too)
  input: z.string().meta({ hint: 'file' }), // files, even with enum values or complete
});
```

Boolean flags never complete a value. The static scripts (without `padroneCompletion()`) follow `hint` for options too.

`valueName` is the value placeholder in help: `--out <DIR>` instead of `--out <string>`, and `<DIR>` instead of the field name for a positional. Markdown, HTML and JSON help, generated docs and man pages use it too.

### The `__complete2` protocol

Scripts are generated with `git completion <shell>`. On each tab press they call `git __complete2 <words>` (the words after the program name, the last being the word under the cursor), which you can run by hand to debug. It prints one candidate per line, `value<TAB>description` or just `value`, then a directive for when nothing matches: `:files`, `:dirs`, `:ext:json,yaml`, `:commands` or `:nofiles`.

```
$ git __complete2 checkout ''
main	Default branch
develop
:nofiles
```

`git __complete <words>` prints values only, one per line, as scripts generated by earlier versions expect. Regenerate those scripts to get descriptions and hints; the `eval "$(git completion bash)"` line that `completion --setup` installs does so on each shell start.

