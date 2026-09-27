---
title: REPL Mode
description: Start an interactive Read-Eval-Print Loop for your CLI
---

Padrone includes a built-in REPL (Read-Eval-Print Loop) that lets users interactively run commands in a persistent session. The REPL supports command history, tab completion, scoped sessions, and customizable output formatting.

## Starting a REPL

Call `.repl()` on your program to start an interactive session. It returns an `AsyncIterable` that yields a result for each executed command:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('myapp')
  .configure({ version: '1.0.0' })
  .command('greet', (c) =>
    c
      .arguments(z.object({ name: z.string() }), { positional: ['name'] })
      .action((args) => `Hello, ${args.name}!`)
  )
  .command('add', (c) =>
    c
      .arguments(z.object({ a: z.number(), b: z.number() }))
      .action((args) => args.a + args.b)
  );

for await (const result of program.repl()) {
  // Each successfully executed command yields a result
  console.log(result.command.name, result.result);
}
```

Errors during execution are caught and printed to the terminal without crashing the session.

## REPL from the CLI

Users can enter the REPL from the command line using the `--repl` flag (in `cli()` and `eval()`; for serve, MCP and `tool()` calls it's an unknown option):

```bash
# Start REPL
myapp --repl

# Start REPL scoped to a subcommand
myapp --repl db
```

## Built-in Commands

All REPL built-in commands use a dot prefix to avoid collisions with user-defined commands:

| Command | Description |
|---------|-------------|
| `.help` | Show REPL commands and keybindings |
| `.exit` | Exit the REPL |
| `.quit` | Exit the REPL (alias) |
| `.clear` | Clear the screen |
| `.history` | Show command history (with the saved history, when `historyFile` is set) |
| `.scope <cmd>` | Scope the session to a subcommand subtree |
| `.scope ..` or `..` | Go up one scope level |
| `.` | Execute the current scoped command |

## Scoped REPLs

Scoped REPLs let you focus on a subcommand tree. When scoped, commands are interpreted relative to the scope and the prompt updates to reflect it:

```typescript
const program = createPadrone('myapp')
  .command('db', (c) =>
    c
      .command('migrate', (c) =>
        c
          .command('up', (c) => c.action(() => 'migrated up'))
          .command('down', (c) => c.action(() => 'migrated down'))
      )
      .command('seed', (c) => c.action(() => 'seeded'))
  );

// Start scoped to 'db'
for await (const result of program.repl({ scope: 'db' })) {
  // User types 'migrate up' instead of 'db migrate up'
}
```

The prompt reflects the current scope:

```
myapp ❯ .scope db
myapp/db ❯ migrate up
# Runs: db migrate up
myapp/db ❯ .scope migrate
myapp/db/migrate ❯ up
# Runs: db migrate up
myapp/db/migrate ❯ ..
myapp/db ❯ .
# Runs: db (executes the scoped command itself)
myapp/db ❯ ..
myapp ❯ .scope db migrate
myapp/db/migrate ❯
```

The `scope` option is strongly typed to valid command paths in your program.

A mistyped `.scope` target gets a suggestion (`Unknown command: dbb` / `Did you mean "db"?`), and inside a scope `help <command>` shows help for the scope's commands (`help migrate` in `db` is `help db migrate`), with the same suggestions for a typo.

## Tab Completion

The REPL provides tab completion for:
- Command names and subcommands
- Option names (e.g., `--port`, `--host`), including global options and the help flags
- Aliases

Tab completion is enabled by default. Disable it with `completion: false`.

## History

The REPL supports up/down arrow key navigation through command history. You can provide initial history entries and view the session history with `.history`:

```typescript
for await (const result of program.repl({
  history: ['greet World', 'add --a 1 --b 2'],
})) {
  // Up arrow cycles through history
}
```

`historyFile` keeps history between sessions: `true` stores it in `repl_history` under the program's state directory (`program.dirs.state`, e.g. `~/.local/state/myapp` on Linux), or pass a path. Entries are saved as they're entered, one per line, and `.history` lists the saved ones too. `historySize` caps how many are kept (default 1000):

```typescript
program.repl({ historyFile: true, historySize: 500 });
```

## Customizing the REPL

### Prompt

```typescript
program.repl({
  prompt: 'app> ',
  // Or dynamic:
  prompt: () => `${getCurrentBranch()}> `,
});
```

The default prompt is the program name (bold in ANSI-capable terminals) and the scope path, followed by `❯`: `myapp/db ❯ `.

### Greeting and Hint

```typescript
program.repl({
  greeting: 'Welcome! Type a command to get started.',
  hint: 'Press Tab for completions, Ctrl+C twice to exit.',
});
```

Set `greeting: false` or `hint: false` to suppress them. The default greeting shows the program name and version. The default hint shows `.help` and `.exit` instructions.

### Output Spacing

Control separators before and after command output:

```typescript
program.repl({
  // Blank line before and after each command output
  spacing: true,

  // Repeated character
  spacing: '-',  // Prints a line of dashes

  // Several lines: a blank line, then a line of dashes
  spacing: [true, '-'],

  // Independent before/after
  spacing: {
    before: true,
    after: '-',
  },
});
```

### Output Prefix

Prefix each line of command output:

```typescript
program.repl({
  outputPrefix: '| ',
});
```

This adds `| ` before each line of output, creating a visual distinction.

## Exit Behavior

- Type `.exit` or `.quit` to exit gracefully
- Press Ctrl+C once to see an exit hint
- Press Ctrl+C twice to force exit

## All REPL Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prompt` | `string \| (() => string)` | `"<name> ❯ "` | REPL prompt |
| `greeting` | `string \| false` | Program name + version | Welcome message |
| `hint` | `string \| false` | Help/exit instructions | Hint shown below greeting |
| `history` | `string[]` | `[]` | Initial history entries |
| `historyFile` | `boolean \| string` | none | File that keeps history between sessions (`true`: `repl_history` in `program.dirs.state`) |
| `historySize` | `number` | `1000` | Most history entries kept |
| `completion` | `boolean` | `true` | Enable tab completion |
| `spacing` | `PadroneReplSpacing \| { before?, after? }` | none | Output separators |
| `outputPrefix` | `string` | none | Prefix for output lines |
| `scope` | `string` | none | Start scoped to a command path |
| `runtime` | `Partial<PadroneRuntime>` | none | Runtime overrides for the session (`readLine`, `output`, `error`, …) |
| `context` | `TContext` | none | Context each command receives; the `repl` command and `--repl` pass on the one given to `cli()` |
