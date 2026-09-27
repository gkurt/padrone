---
title: Wrapping External CLI Tools (Experimental)
description: Learn how to wrap external CLI tools with Padrone for type-safe command execution
---

> **Experimental**: This API is experimental and may change in future releases.

## Overview

Padrone's `.wrap()` method allows you to create type-safe wrappers around external CLI tools. This is useful when you want to:

- Provide a typed interface to existing command-line tools
- Combine multiple tools into a unified CLI
- Add validation and preprocessing before calling external commands
- Build CLI orchestrators or automation tools

## Basic Usage

The simplest way to wrap an external command is to define command arguments with `.arguments()`, then call `.wrap()` with a config object:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('myapp')
  .command('hello', (c) =>
    c
      .arguments(
        z.object({
          name: z.string(),
        }),
        {
          positional: ['name'],
        }
      )
      .wrap({
        command: 'echo',
      })
  );

// Usage: myapp hello "World"
// Executes: echo World
```

## Schema Transformation

The `.wrap()` config can include an optional `schema` property that transforms from **command arguments** (input) to **external CLI arguments** (output).

### Automatic Conversion

After transformation, Padrone converts the output to CLI arguments:

1. **Boolean flags**: `{ verbose: true }` → `--verbose`
2. **String/Number values**: `{ port: 3000 }` → `--port 3000`
3. **Arrays**: `{ files: ['a.txt', 'b.txt'] }` → `--files a.txt --files b.txt`
4. **Keys are used as-is**: `{ v: true }` → `--v`

### Mapping with Transform Schema

Use Zod's `.transform()` in the wrap config's `schema` property to map friendly argument names to the exact flags the external command expects:

```typescript
program
  .command('list', (c) =>
    c
      .arguments(
        z.object({
          all: z.boolean().optional(),
          long: z.boolean().optional(),
          humanReadable: z.boolean().optional(),
        })
      )
      .wrap({
        command: 'ls',
        schema: z.object({
          all: z.boolean().optional(),
          long: z.boolean().optional(),
          humanReadable: z.boolean().optional(),
        }).transform((args) => ({
          a: args.all,
          l: args.long,
          h: args.humanReadable,
        })),
      })
  );

// Usage: myapp list --all --long
// After transform: { a: true, l: true }
// Executes: ls --a --l
```

### Function-Based Schema

For better type safety, use a function that receives the command schema:

```typescript
program
  .command('list', (c) =>
    c
      .arguments(
        z.object({
          all: z.boolean().optional(),
          long: z.boolean().optional(),
        })
      )
      .wrap({
        command: 'ls',
        schema: (cmdSchema) => cmdSchema.transform((args) => ({
          a: args.all,
          l: args.long,
        })),
      })
  );
```

## Positional Arguments

Use the `positional` config in `.wrap()` to define positional arguments for the external command:

```typescript
program
  .command('copy', (c) =>
    c
      .arguments(
        z.object({
          source: z.string(),
          dest: z.string(),
          recursive: z.boolean().optional(),
        }),
        {
          positional: ['source', 'dest'],
        }
      )
      .wrap(
        z.object({
          source: z.string(),
          dest: z.string(),
          recursive: z.boolean().optional(),
        }).transform((args) => ({
          source: args.source,
          dest: args.dest,
          r: args.recursive,
        })),
        {
          command: 'cp',
          positional: ['source', 'dest'],  // Defaults to command's positional
        }
      )
  );

// Usage: myapp copy /src /dest --recursive
// After transform: { source: '/src', dest: '/dest', r: true }
// Executes: cp --r /src /dest
```

### Variadic Arguments

Use the `...` prefix for variadic (rest) arguments:

```typescript
program
  .command('remove', (c) =>
    c
      .arguments(
        z.object({
          files: z.string().array(),
          force: z.boolean().optional(),
        }),
        {
          positional: ['...files'],
        }
      )
      .wrap(
        z.object({
          files: z.string().array(),
          force: z.boolean().optional(),
        }).transform((args) => ({
          files: args.files,
          f: args.force,
        })),
        {
          command: 'rm',
          positional: ['...files'],
        }
      )
  );

// Usage: myapp remove file1.txt file2.txt --force
// After transform: { files: ['file1.txt', 'file2.txt'], f: true }
// Executes: rm --f file1.txt file2.txt
```

## Fixed Arguments

Use the `args` parameter to prepend fixed arguments to every call:

```typescript
program
  .command('commit', (c) =>
    c
      .arguments(
        z.object({
          message: z.string(),
          amend: z.boolean().optional(),
        }),
        {
          positional: ['message'],
        }
      )
      .wrap(
        z.object({
          message: z.string(),
          amend: z.boolean().optional(),
        }).transform((args) => ({
          m: args.message,
          amend: args.amend,
        })),
        {
          command: 'git',
          args: ['commit'],
          positional: ['m'],
        }
      )
  );

// Usage: myapp commit "Initial commit" --amend
// After transform: { m: 'Initial commit', amend: true }
// Executes: git commit --amend "Initial commit"
```

## Separator and Flag Style

By default options come first as `--key value`, then the positionals. Two options change that:

```typescript
program
  .command('remove', (c) =>
    c
      .arguments(z.object({ files: z.string().array(), force: z.boolean().optional() }), { positional: ['...files'] })
      .wrap({
        command: 'rm',
        separator: '--', // positionals after `--`: `rm --force -- -weird-name`
        flagStyle: 'equals', // `--key=value` instead of `--key value`
      })
  );
```

- `separator: '--'` puts the positional values after a `--`, so a value starting with `-` can't be read as an option by the wrapped tool. Nothing is added when there are no positionals.
- `flagStyle: 'equals'` emits `--key=value` (arrays as `--key=a --key=b`); booleans stay bare flags.

## Capturing Output

By default, the wrapped command inherits stdio from the parent process (output goes directly to the terminal). Set `inheritStdio: false` to capture stdout and stderr:

```typescript
program
  .command('version', (c) =>
    c
      .arguments(z.object({}))
      .wrap(
        (cmdSchema) => cmdSchema,
        {
          command: 'node',
          args: ['--version'],
          inheritStdio: false,
        }
      )
  );

// Get the result
const result = await program.run('version', {});
const wrapResult = await result.result;

console.log('Exit code:', wrapResult.exitCode);
console.log('Output:', wrapResult.stdout);
console.log('Success:', wrapResult.success);
```

## Complete Example: Docker Wrapper

Here's a complete example wrapping common Docker commands:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const docker = createPadrone('docker-cli')
  .configure({
    title: 'Docker CLI Wrapper',
    description: 'Type-safe wrapper for Docker commands',
    version: '1.0.0',
  })
  .command('run', (c) =>
    c
      .configure({
        description: 'Run a container from an image',
      })
      .arguments(
        z.object({
          image: z.string().describe('Docker image name'),
          name: z.string().optional().describe('Container name'),
          detach: z.boolean().optional().describe('Run in background'),
          interactive: z.boolean().optional().describe('Keep STDIN open'),
          tty: z.boolean().optional().describe('Allocate a pseudo-TTY'),
          port: z.string().array().optional().describe('Port mappings'),
          volume: z.string().array().optional().describe('Volume mounts'),
          env: z.string().array().optional().describe('Environment variables'),
        }),
        {
          positional: ['image'],
        }
      )
      .wrap(
        z.object({
          image: z.string(),
          name: z.string().optional(),
          detach: z.boolean().optional(),
          interactive: z.boolean().optional(),
          tty: z.boolean().optional(),
          port: z.string().array().optional(),
          volume: z.string().array().optional(),
          env: z.string().array().optional(),
        }).transform((args) => ({
          image: args.image,
          name: args.name,
          d: args.detach,
          i: args.interactive,
          t: args.tty,
          p: args.port,
          v: args.volume,
          e: args.env,
        })),
        {
          command: 'docker',
          args: ['run'],
          positional: ['image'],
        }
      )
  )
  .command('ps', (c) =>
    c
      .configure({
        description: 'List containers',
      })
      .arguments(
        z.object({
          all: z.boolean().optional().describe('Show all containers'),
          quiet: z.boolean().optional().describe('Only show container IDs'),
        })
      )
      .wrap(
        z.object({
          all: z.boolean().optional(),
          quiet: z.boolean().optional(),
        }).transform((args) => ({
          a: args.all,
          q: args.quiet,
        })),
        {
          command: 'docker',
          args: ['ps'],
        }
      )
  )
  .command('stop', (c) =>
    c
      .configure({
        description: 'Stop running containers',
      })
      .arguments(
        z.object({
          containers: z.string().array().describe('Container IDs or names'),
        }),
        {
          positional: ['...containers'],
        }
      )
      .wrap(
        (cmdSchema) => cmdSchema,  // Identity transform
        {
          command: 'docker',
          args: ['stop'],
        }
      )
  );

// Type-safe usage
await docker.run('run', {
  image: 'nginx:latest',
  detach: true,
  port: ['80:80'],
  name: 'my-nginx',
});

await docker.run('ps', { all: true });

await docker.run('stop', { containers: ['my-nginx'] });
```

## Type Safety

The `.wrap()` method maintains full type safety throughout:

```typescript
const program = createPadrone('app')
  .command('deploy', (c) =>
    c
      .arguments(
        z.object({
          environment: z.enum(['dev', 'staging', 'prod']),
          version: z.string(),
          dryRun: z.boolean().default(false),
        })
      )
      .wrap({
        command: 'deploy-tool',
        optionMapping: {
          dryRun: '--dry-run',
        },
      })
  );

// ✅ TypeScript knows the correct types
await program.run('deploy', {
  environment: 'prod',
  version: '1.2.3',
  dryRun: true,
});

// ❌ TypeScript error: invalid environment
await program.run('deploy', {
  environment: 'production',  // Type error!
  version: '1.2.3',
});

// ❌ TypeScript error: missing required field
await program.run('deploy', {
  environment: 'prod',
  // version is missing!
});
```

## Error Handling

Wrapped commands can fail. Check the exit code or success flag:

```typescript
const result = await program.run('deploy', { environment: 'prod', version: '1.0.0' });
const wrapResult = await result.result;

if (!wrapResult.success) {
  console.error('Deployment failed with exit code:', wrapResult.exitCode);
  if (wrapResult.stderr) {
    console.error('Error output:', wrapResult.stderr);
  }
  process.exit(1);
}

console.log('Deployment successful!');
```

## Best Practices

1. **Use descriptive argument names**: Choose clear, self-documenting names for your arguments in the schema
2. **Map to CLI flags with transform**: Use `.transform()` to map friendly argument names to the exact flags the CLI expects
3. **Add descriptions**: Use `.describe()` on Zod schemas to document each argument
4. **Provide defaults**: Use `.default()` for common values
5. **Validate inputs**: Use Zod's validation features to ensure correct inputs before calling external commands
6. **Handle errors**: Always check the exit code when capturing output
7. **Use enums**: For fixed sets of values, use `z.enum()` or `z.union()`

## Limitations

- The wrapped command must be available in the system's PATH or specified as an absolute path
- Environment variables are not automatically passed to the wrapped command (you'll need to pass them explicitly if needed)
- Argument keys are used as-is with `--` prefix - use Zod's `.transform()` for custom mappings
