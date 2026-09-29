---
title: Quick Start
description: Build your first CLI application with Padrone in minutes
---

This guide walks you through creating a simple CLI application with Padrone.

## Scaffold with `padrone init`

The fastest way to start is to scaffold a new project:

```bash
npx padrone init my-cli
cd my-cli && bun i && bun dev
```

This generates a ready-to-run project with a starter program. See [CLI Tools](../cli-tools/#padrone-init) for all options.

## Manual Installation

Alternatively, add Padrone to an existing project:

```bash
# Using npm
npm install padrone zod

# Using bun
bun add padrone zod

# Using pnpm
pnpm add padrone zod
```

## Create Your First CLI

Create a new file `cli.ts`:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('greet')
  .configure({
    version: '1.0.0',
    description: 'A friendly greeting CLI',
  })
  .arguments(
    z.object({
      name: z.string().describe('Name to greet'),
      excited: z.boolean().optional().describe('Add excitement'),
    }),
    { positional: ['name'] }
  )
  .action((args) => {
    const greeting = `Hello, ${args.name}`;
    console.log(args.excited ? `${greeting}!` : greeting);
  });

program.cli();
```

## Run Your CLI

```bash
# Run with a positional argument
bun cli.ts World
# Output: Hello, World

# Run with the --excited flag
bun cli.ts World --excited
# Output: Hello, World!

# Show help
bun cli.ts --help
```

## Add Commands

Most CLIs have multiple commands. Let's add some:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('todo')
  .configure({
    version: '1.0.0',
    description: 'A simple todo CLI',
  })
  .command('add', (c) =>
    c
      .arguments(
        z.object({
          task: z.string().describe('Task description'),
          priority: z.enum(['low', 'medium', 'high']).default('medium'),
        }),
        { positional: ['task'] }
      )
      .action((args) => {
        console.log(`Added: ${args.task} [${args.priority}]`);
      })
  )
  .command('list', (c) =>
    c
      .arguments(
        z.object({
          all: z.boolean().optional().describe('Show completed tasks'),
        })
      )
      .action((args) => {
        console.log('Listing tasks...', { showAll: args.all });
      })
  );

program.cli();
```

```bash
# Add a task
bun cli.ts add "Buy groceries" --priority high

# List tasks
bun cli.ts list --all
```

## Use Short Flags

Add short flags for frequently used arguments:

```typescript
z.object({
  verbose: z.boolean().optional().describe('Verbose output').meta({ flags: 'v' }),
  output: z.string().optional().describe('Output file').meta({ flags: 'o' }),
})
```

Now users can use `-v` instead of `--verbose` and `-o` instead of `--output`. Short flags are single-character and stackable: `-vo out.json` = `-v -o out.json`.

## Programmatic Usage

You can also run commands programmatically with full type safety:

```typescript
// Run a command directly (args checked against the schema, defaults applied)
program.run('add', { task: 'Buy milk', priority: 'high' });

// Evaluate a command string (soft error handling)
const result = program.eval('add "Buy eggs" --priority low');

// Generate a typed API (each command returns its result, or throws)
const api = program.api();
api.add({ task: 'Buy eggs', priority: 'low' });

// Parse without executing
const parsed = program.parse('add "Clean room" --priority medium');
console.log(parsed.command); // 'add'
console.log(parsed.args); // { task: 'Clean room', priority: 'medium' }
```

## Make It Interactive

Add interactive prompting so users are guided through missing arguments:

```typescript
const program = createPadrone('todo')
  .configure({ version: '1.0.0' })
  .runtime({ interactive: true })
  .command('add', (c) =>
    c
      .arguments(
        z.object({
          task: z.string().describe('Task description'),
          priority: z.enum(['low', 'medium', 'high']).default('medium').describe('Priority level'),
        }),
        {
          positional: ['task'],
          interactive: ['task'],
          optionalInteractive: ['priority'],
        }
      )
      .action((args) => {
        console.log(`Added: ${args.task} [${args.priority}]`);
      })
  );

await program.cli();
```

Now running `todo add` with no arguments will prompt for the task description (text input), then offer to configure priority (select menu with low/medium/high). Prompt types are auto-detected from your Zod schema.

## Next Steps

- Learn about [Commands & Arguments](../commands-arguments/) in depth
- Set up [Interactive Prompting](../interactive-prompting/) for your CLI
- Start an interactive [REPL session](../repl/)
- Add [Progress Indicators](../progress-indicators/) to long-running commands
- Add [Interceptors & Extensions](../plugins/) to extend command behavior
- [Compose programs](../composition/) together with mount and override
- Integrate with [AI tools](../ai-integration/) (MCP *(experimental)*, REST server *(experimental)*, and Vercel AI SDK)
- Handle errors with [Error Handling](../error-handling/)
- Test your CLI with [testCli()](../testing/)
- Scaffold and lint with [CLI Tools](../cli-tools/)
- Explore the [API Reference](../../reference/api/)
