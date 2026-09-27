---
title: Testing
description: Test your CLI applications with the built-in testCli utility
---

Padrone ships a `testCli()` utility that captures all I/O and provides a clean interface for assertions. It works with any test framework — bun:test, vitest, jest, node:test, etc.

## Setup

Import from `padrone/test`:

```typescript
import { testCli } from 'padrone/test';
```

## Basic Usage

```typescript
import { describe, test, expect } from 'bun:test';
import { testCli } from 'padrone/test';
import { program } from './cli';

test('greet command', async () => {
  const result = await testCli(program).run('greet World');

  expect(result.args).toEqual({ name: 'World' });
  expect(result.result).toBe('Hello, World!');
});
```

## The Test Builder

`testCli()` returns a fluent builder with these methods:

| Method | Description |
|--------|-------------|
| `.args(input)` | Set the CLI input string |
| `.env(vars)` | Set environment variables |
| `.prompt(answers)` | Provide mock answers for interactive prompts |
| `.config(files)` | Provide mock config file contents |
| `.stdin(data)` | Provide mock stdin data (piped input) |
| `.context(value)` | The context commands receive (`ctx.context`), as passed to `cli()` |
| `.run(input?)` | Execute the command and return the result |
| `.repl(inputs)` | Run a REPL session with a sequence of inputs |

All builder methods are chainable and `.run()` / `.repl()` return a Promise.

## Test Result

`run()` returns a `TestCliResult`:

| Property | Type | Description |
|----------|------|-------------|
| `command` | `PadroneCommand` | The matched command |
| `args` | `unknown` | Validated arguments (`undefined` if validation failed) |
| `result` | `unknown` | Action handler return value |
| `issues` | `Array \| undefined` | Validation issues, if any |
| `stdout` | `unknown[]` | All values passed to `runtime.output()` |
| `stderr` | `string[]` | All strings passed to `runtime.error()` |
| `error` | `unknown` | The thrown error, if the command threw |

## Testing Subcommands

Pass the full command path as the input string:

```typescript
test('deploy to staging', async () => {
  const result = await testCli(program).run('deploy --env staging');

  expect(result.command.name).toBe('deploy');
  expect(result.args).toEqual({ env: 'staging' });
});

test('nested command', async () => {
  const result = await testCli(program).run('db migrate up --steps 3');

  expect(result.command.name).toBe('up');
  expect(result.args).toEqual({ steps: 3 });
});
```

## Testing with Environment Variables

```typescript
test('reads API key from env', async () => {
  const result = await testCli(program)
    .env({ API_KEY: 'secret-123' })
    .run('deploy --env production');

  expect(result.args).toMatchObject({ apiKey: 'secret-123' });
});
```

## Testing Interactive Prompts

Provide mock answers keyed by field name:

```typescript
test('prompts for missing fields', async () => {
  const result = await testCli(program)
    .args('init')
    .prompt({ name: 'myapp', template: 'react' })
    .run();

  expect(result.args).toEqual({ name: 'myapp', template: 'react' });
});
```

## Testing Config Files

To test config file loading, use `padroneConfig()` with a custom `loadConfig` function that returns mock data:

```typescript
import { padroneConfig } from 'padrone';

const program = createPadrone('myapp')
  .extend(padroneConfig({
    files: 'app.config.json',
    loadConfig: () => ({ port: 9090, host: 'example.com' }),
  }))
  .command('serve', (c) =>
    c
      .arguments(z.object({ port: z.number(), host: z.string() }))
      .action((args) => args)
  );

test('loads config file values', async () => {
  const result = await testCli(program).run('serve');

  expect(result.args).toMatchObject({ port: 9090 });
});
```

## Testing Stdin

```typescript
test('reads piped input', async () => {
  const result = await testCli(program)
    .stdin('line1\nline2\nline3')
    .run('process');

  expect(result.result).toEqual(['line1', 'line2', 'line3']);
});
```

## Testing Validation Errors

```typescript
test('rejects invalid port', async () => {
  const result = await testCli(program).run('serve --port abc');

  expect(result.issues).toBeDefined();
  expect(result.issues![0].message).toContain('Expected number');
});
```

## Testing Action Errors

```typescript
test('fails on production without --force', async () => {
  const result = await testCli(program).run('deploy --env production');

  expect(result.error).toBeDefined();
  expect(result.stderr).toContain('Production deploys require --force');
});
```

## Testing Output

Captured output is stored as arrays — `stdout` for normal output, `stderr` for errors:

```typescript
test('prints progress', async () => {
  const result = await testCli(program).run('build');

  expect(result.stdout).toContain('Building...');
  expect(result.stdout).toContain('Done!');
  expect(result.stderr).toHaveLength(0);
});
```

## Testing REPL Sessions

Use `.repl()` to simulate a sequence of REPL inputs:

```typescript
test('REPL session', async () => {
  const { results, stdout, stderr } = await testCli(program)
    .repl(['greet World', 'add --a=2 --b=3']);

  expect(results).toHaveLength(2);
  expect(results[0].result).toBe('Hello, World!');
  expect(results[1].result).toBe(5);
});
```

The `TestReplResult` contains:

| Property | Type | Description |
|----------|------|-------------|
| `results` | `Array` | One entry per executed command |
| `stdout` | `unknown[]` | All output from the session |
| `stderr` | `string[]` | All errors from the session |

## Shorthand

You can pass the input directly to `.run()` instead of using `.args()`:

```typescript
// These are equivalent:
await testCli(program).args('serve --port 8080').run();
await testCli(program).run('serve --port 8080');
```

## Testing with Context

Provide context via the `run()` preferences:

```typescript
test('uses context', async () => {
  const db = createMockDb();
  const result = await testCli(program).run('users list', {
    context: { db },
  });

  expect(result.result).toEqual(['alice', 'bob']);
});
```

## Combining Builders

Chain multiple builders for complex scenarios:

```typescript
test('full integration', async () => {
  const result = await testCli(program)
    .args('deploy --env staging')
    .env({ API_KEY: 'test-key', CI: 'true' })
    .run();

  expect(result.result).toEqual({ deployed: true, region: 'us-east-1' });
});
```
