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

A blank answer to a required field is asked again ("A value for "name" is required"), or takes the field's default when the prompt has one.

Fields marked `sensitive: true` (nested keys like `db.password` too) are asked with a `password` prompt (no echo) and never prefilled with their current or default value. Under forced prompting (`-i`), a blank answer to such a prompt keeps the value already given.

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

When set to `true`, all optional fields (not in `required`) that are still missing will be offered. An empty answer to an optional field's text prompt leaves it unset (so its default applies).

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

Numbers are coerced from the answer, and arrays of strings or numbers take comma-separated values (`a, b`). Object fields are prompted key by key (`db.host`, then `db.port`): their required keys that are still missing, or all their keys when none is required (a blank answer leaves an optional key unset). Arrays of objects are never prompted, since a text answer can't fill them; validation reports them when missing.

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

Neither asks with `--no-interactive`. `padroneConfirm()` asks before `mutation: true` commands; where it can't ask (CI, piped stdin or stdout, `--no-interactive`) the command fails unless `--yes` is given or `<PROGRAM>_YES=1` is set (`padroneConfirm({ env: 'MY_VAR' })` renames it). `padroneConfirm({ nonInteractive: 'yes' })` runs the command there instead, and `'no'` aborts it as if answered no. A command's own `.configure({ confirm })` decides whether it asks and what: `false` never asks (even for a mutation), `true` asks the default question, and a string or a function of the validated args is the question:

```typescript
program
  .extend(padroneConfirm())
  .command('drop', (c) =>
    c
      .arguments(z.object({ table: z.string() }), { positional: ['table'] })
      .configure({ mutation: true, confirm: (args) => `Drop table ${args.table}?` })
      .action(({ table }) => dropTable(table)),
  );
```

Cancelling the question (Ctrl+C, Esc) aborts like answering no. For free-form text, `ctx.runtime.editor(template)` opens the user's editor and resolves with what they saved.

## Prompts in Actions

For questions that aren't command arguments (a setup wizard, a choice that depends on an API response), actions get `ctx.prompt`, a small prompt kit like `@clack/prompts`:

```typescript
program.command('init', (c) =>
  c.action(async (_, ctx) => {
    const name = await ctx.prompt.text({ message: 'Project name?', default: 'my-app', validate: (v) => (v ? undefined : 'Required') });
    const token = await ctx.prompt.password('API token');
    const framework = await ctx.prompt.select({
      message: 'Framework',
      choices: ['react', { value: 'vue', label: 'Vue', hint: 'recommended' }],
    });
    const features = await ctx.prompt.multiselect({ message: 'Features', choices: ['lint', 'test'], required: true });
    const install = await ctx.prompt.confirm({ message: 'Install dependencies?', default: true });
    return { name, token, framework, features, install };
  }),
);
```

`group()` asks several questions in order; each step gets the answers before it as `results`, and returning `undefined` skips a question. Questions inside a step are named after its key:

```typescript
const answers = await ctx.prompt.group({
  name: () => ctx.prompt.text('Project name?'),
  lang: () => ctx.prompt.select({ message: 'Language', choices: ['ts', 'js'] }),
  strict: ({ results }) => (results.lang === 'ts' ? ctx.prompt.confirm('Strict mode?') : undefined),
});
```

TypeScript can't infer the answer of a step that reads `results` (it's `unknown`); pass the answers' type (`ctx.prompt.group<{ name: string; strict?: boolean }>(...)`) to type it.

- **Cancellation** (Ctrl+C, Esc) throws a `PromptCancelledError` (exit code 130; `isPromptCancel(err)` checks it). An empty answer is `''`, never a cancellation. `cli()` prints `Cancelled` if the action doesn't catch it.
- **No terminal to ask in** (CI, piped stdin, `--no-interactive`, `interactive: 'unsupported'`) or a **remote caller** (`serve`, `mcp`, `tool`): prompts return their `default` without asking, or throw a `PromptUnavailableError` without one, so nothing hangs waiting for input. `ctx.prompt.available` tells whether they'd ask.
- **Names**: each question reaches `runtime.prompt` as `config.name`: its `name` option, else its group step's key, else its message. That's the key scripted answers use.

Interceptors get the same kit from `createPrompt(ctx)` (any phase context). Everything asks through `runtime.prompt`, so a custom runtime answers these prompts too.

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

    // Return the user's response, or PROMPT_CANCEL when they cancel
    return await myCustomPromptUI(config);
  },
});
```

Select answers may be a choice's value or its string form (the Enquirer backend answers with names). Resolve with `PROMPT_CANCEL` (exported from `'padrone'`) or throw a `PromptCancelledError` when the user cancels; Padrone turns both into a `PromptCancelledError`.

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

With `testCli()` from `padrone/test`, `.prompt(answers)` answers fields and `ctx.prompt` questions by name; `PROMPT_CANCEL` as an answer cancels that prompt:

```typescript
import { PROMPT_CANCEL } from 'padrone';
import { testCli } from 'padrone/test';

await testCli(program).prompt({ name: 'demo', lang: 'ts', strict: true }).run('init');
await testCli(program).prompt({ name: PROMPT_CANCEL }).run('init'); // result.error is a PromptCancelledError
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
