---
title: Interactive Prompting
description: Automatically prompt users for missing CLI arguments with type-aware prompts
---

Padrone can automatically prompt users for missing argument values when running in an interactive terminal. Prompt types are auto-detected from your Zod schema — booleans become confirm prompts, enums become select menus, and everything else becomes text input.

## Enabling Interactivity

Interactive prompting requires two things:

1. **Runtime support** — a terminal (detected), or `interactive: 'supported'` on a custom runtime
2. **Field configuration** — declare which fields to prompt via `interactive` or `optionalInteractive` in the arguments meta

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('app')
  .command('init', (c) =>
    c
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
      .action((args) => {
        console.log(`Creating ${args.name} with ${args.template}`);
      })
  );

await program.cli();
```

## How It Works

Interactive prompting is a data acquisition step in the argument resolution pipeline. It runs **after** CLI args, environment variables, and config file values have been merged, but **before** schema validation:

```
CLI args → aliases → env vars → config file → interactive prompts → schema validation → action
```

This means:
- Fields already provided via CLI, env, or config are **never prompted**
- Prompted values go through the same Zod validation as any other input
- Default values from the schema apply if a field isn't prompted and wasn't provided

## `interactive` — Required Fields

The `interactive` option controls which fields are prompted when their values are missing.

### Prompt specific fields

```typescript
{ interactive: ['name', 'template'] }
```

Only `name` and `template` will be prompted if missing. Other missing fields rely on defaults or validation.

### Prompt all required fields

```typescript
{ interactive: true }
```

When set to `true`, all fields listed in the schema's `required` array that are missing will be prompted. Fields with defaults or `.optional()` are not prompted, unless `requires`, `requiredIf` or `requiredUnless` made them required for this run.

Fields marked `sensitive: true` are asked with a `password` prompt (no echo) and never prefilled with their current or default value.

## `optionalInteractive` — Optional Fields

After required interactive prompts are complete, `optionalInteractive` fields are offered in a multi-select prompt: "Would you also like to configure:" — users choose which ones to fill in.

### Offer specific fields

```typescript
{ optionalInteractive: ['typescript', 'eslint', 'prettier'] }
```

### Offer all optional fields

```typescript
{ optionalInteractive: true }
```

When set to `true`, all optional fields (not in `required`) that are still missing will be offered.

### Combined example

```typescript
.arguments(
  z.object({
    name: z.string().describe('Project name'),
    template: z.enum(['react', 'vue', 'svelte']).describe('Starter template'),
    typescript: z.boolean().default(false).describe('Use TypeScript'),
    eslint: z.boolean().default(false).describe('Add ESLint'),
    prettier: z.boolean().default(false).describe('Add Prettier'),
  }),
  {
    interactive: ['name', 'template'],
    optionalInteractive: ['typescript', 'eslint', 'prettier'],
  }
)
```

Running with no arguments:
1. Prompts for `name` (text input)
2. Prompts for `template` (select: react / vue / svelte)
3. Shows multi-select: "Would you also like to configure: Use TypeScript, Add ESLint, Add Prettier"
4. Prompts individually for each selected field (confirm prompts for booleans)

Running with `--name myproject --template react`:
- Skips all prompts — both required interactive fields are already provided
- Optional fields still offered if missing

## Prompt Type Auto-Detection

Padrone detects the appropriate prompt type from each field's JSON schema:

| Schema | Prompt Type | Example |
|--------|------------|---------|
| `z.boolean()` | Confirm (yes/no) | `Use TypeScript? (y/N)` |
| `z.enum(['a', 'b', 'c'])` | Select (single choice) | `❯ react / vue / svelte` |
| `z.array(z.enum([...]))` | Multi-select | `◯ tag1 / ◯ tag2 / ◯ tag3` |
| `z.string()` | Text input | `Project name: _` |
| Any other type | Text input | `Value: _` |

### Prompt messages

The prompt message is derived from (in order of priority):
1. `fields` meta `description` (from the arguments meta)
2. `.describe()` on the Zod schema property
3. The field name as fallback

```typescript
.arguments(
  z.object({
    name: z.string().describe('Schema description'),
  }),
  {
    interactive: ['name'],
    fields: {
      name: { description: 'Meta description' }, // This wins
    },
  }
)
```

## Other Prompts

A few built-ins also ask through `runtime.prompt`, in `cli()` and the REPL, when the runtime can prompt:

```typescript
createPadrone('my-cli', {
  builtins: {
    // `my-cli db` asks "Which "db" command?" instead of showing help
    help: { pickSubcommand: true },
    // `my-cli dpeloy` asks "Unknown command "dpeloy". Run "deploy" instead?"
    suggestions: { run: 'prompt' },
  },
});
```

`padroneConfirm()` asks before `mutation: true` commands; where it can't ask (CI, piped stdin or stdout, `--no-interactive`) the command fails unless `--yes` is given. For free-form text, `ctx.runtime.editor(template)` opens the user's editor and resolves with what they saved.

## Non-Interactive Runtimes

When `runtime.interactive` is `'disabled'` or `'unsupported'`, or `prompt` is not available, interactive prompting is silently skipped. Missing required fields will cause validation errors as usual. By default it's `'disabled'` in CI and when stdin or stdout isn't a terminal (`app init < answers.txt`), and `-i` turns prompts back on unless the runtime is `'unsupported'`.

This makes it safe to declare `interactive` in your arguments meta without breaking non-interactive environments like CI/CD pipelines, test runners, or web-based runtimes.

```bash
# Interactive terminal — prompts for missing fields
app init

# CI pipeline — skips prompts, validation fails if fields missing
CI=true app init

# Provide all fields explicitly — works everywhere
app init myproject --template react
```

## Custom Prompt Implementations

The default prompt implementation uses [Enquirer](https://github.com/enquirer/enquirer) for terminal prompts. For non-terminal runtimes (web UIs, chat interfaces, testing), provide a custom `prompt` function:

```typescript
program.runtime({
  interactive: 'supported',
  prompt: async (config) => {
    // config.name    — field name
    // config.message — human-readable prompt text
    // config.type    — 'input' | 'confirm' | 'select' | 'multiselect' | 'password'
    // config.choices — available choices for select/multiselect
    // config.default — default value from schema

    // Return the user's response
    return await myCustomPromptUI(config);
  },
});
```

### Testing with mock prompts

```typescript
import { createPadrone } from 'padrone';

const mockPrompt = async (config) => {
  const responses = { name: 'test-project', template: 'react' };
  return responses[config.name];
};

const program = createPadrone('app')
  .runtime({ interactive: 'supported', prompt: mockPrompt })
  .command('init', (c) =>
    c
      .arguments(schema, { interactive: true })
      .action((args) => args)
  );

const result = await program.eval('init');
// result.args === { name: 'test-project', template: 'react', ... }
```

## Async Implications

When `interactive` or `optionalInteractive` is set in the arguments meta, the command is automatically marked as async. This means:

- `cli()` returns `Promise<PadroneCommandResult>`
- `parse()` returns `Promise<PadroneParseResult>`
- You must `await` the result

This applies at the **type level** regardless of whether the runtime actually supports interactivity. TypeScript will enforce `await` even when the runtime is non-interactive, which is the safe default.

```typescript
// With interactive meta — must await
const result = await program.eval('init');

// Without interactive meta — synchronous
const result = program.eval('build --target prod');
```

## `parse()` and `run()` Behavior

Interactive prompting occurs in `cli()` and `eval()`. The other execution methods behave as follows:

- **`eval()`** — Parses, validates, and executes with soft error handling. Supports interactive prompting (controllable via `preferences.interactive`).
- **`parse()`** — Parses and validates without prompting. Missing fields cause validation issues.
- **`run()`** — Executes with provided arguments directly. No parsing, no prompting.
- **`api()`** — Same as `run()` — direct programmatic execution.

This keeps `parse()` side-effect-free and `run()` / `api()` deterministic for programmatic use.
