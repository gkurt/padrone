---
title: Error Handling
description: Handle and customize errors in your CLI applications
---

Padrone provides a structured error hierarchy so your CLI can distinguish user errors from bugs, show actionable suggestions, and set appropriate exit codes.

## Error Hierarchy

All Padrone errors extend `PadroneError`, which carries metadata for user-friendly formatting:

```
PadroneError (base)
├── RoutingError    — unknown command, unexpected arguments
├── ValidationError — schema validation failures
├── ConfigError     — config file loading/validation failures
└── ActionError     — errors thrown from action handlers
```

## Throwing Errors in Actions

Use `ActionError` to throw structured errors from your command handlers:

```typescript
import { createPadrone, ActionError } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('deploy')
  .arguments(z.object({
    env: z.enum(['staging', 'production']),
    force: z.boolean().optional(),
  }))
  .action(async (args) => {
    if (args.env === 'production' && !args.force) {
      throw new ActionError('Production deploys require --force', {
        exitCode: 1,
        suggestions: ['Use --force to deploy to production'],
      });
    }

    await deploy(args.env);
  });
```

## Error Properties

Every `PadroneError` carries:

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable error message |
| `exitCode` | `number` | Process exit code (default: `1`) |
| `suggestions` | `string[]` | Actionable hints shown to the user |
| `command` | `string \| undefined` | The command path that produced the error |
| `phase` | `string \| undefined` | Which phase failed: `'parse'`, `'validate'`, `'execute'`, or `'config'` |
| `cause` | `unknown` | Original error for chaining |

## Catching Errors

### With cli()

`cli()` never throws: it prints routing and validation errors with help, and returns the error on the result. When a run ends with an error, it sets the process exit code to the error's `exitCode` (`1` by default, `130` after SIGINT) through `runtime.setExitCode` — `process.exitCode` in the default runtime, so output still flushes. Inspect the result to customize what happens next:

```typescript
const { error } = await program.cli().drain();
if (error instanceof PadroneError && error.suggestions.length > 0) {
  console.error('\nSuggestions:');
  for (const s of error.suggestions) console.error(`  - ${s}`);
}
```

To take over the exit code yourself (or ignore it, e.g. in tests), pass `setExitCode` in the runtime:

```typescript
program.runtime({ setExitCode: (code) => console.error(`exit ${code}`) }).cli();
```

### With eval()

`eval()` uses soft error handling — validation failures are returned as `argsResult.issues` rather than thrown:

```typescript
const result = await program.eval('deploy --env invalid');

if (result.argsResult?.issues) {
  for (const issue of result.argsResult.issues) {
    console.error(`${issue.path?.join('.')}: ${issue.message}`);
  }
}

if (result.error) {
  // Action threw an error
  console.error(result.error);
}
```

## Validation Errors

`ValidationError` carries the structured issues from schema validation:

```typescript
import { ValidationError } from 'padrone';

try {
  await program.cli();
} catch (error) {
  if (error instanceof ValidationError) {
    for (const issue of error.issues) {
      console.error(`  ${issue.path?.join('.') ?? ''}: ${issue.message}`);
    }
  }
}
```

## Error Handling with Interceptors

Interceptors can intercept errors in the `error` phase to log, transform, or suppress them. The built-in help extension uses this same mechanism to display help text alongside routing/validation errors in CLI mode.

```typescript
import { defineInterceptor } from 'padrone';

const errorReporter = defineInterceptor({ name: 'error-reporter' }, () => ({
  error: (ctx, next) => {
    reportToSentry(ctx.error);
    return next(); // Pass through
  },
}));

const errorRecovery = defineInterceptor({ name: 'error-recovery' }, () => ({
  error: (ctx, next) => {
    if (ctx.error instanceof NetworkError) {
      // Suppress error and return fallback result
      return { error: undefined, result: cachedValue };
    }
    // Transform the error
    return { error: new ActionError('Something went wrong', { cause: ctx.error }) };
  },
}));
```

The error phase only runs during `eval()` and `cli()`. Error handlers run in two layers: command-level handlers first (for route/validate/execute failures), then root-level handlers (for all failures including parse). Command-level error handlers can suppress errors before they reach root-level handlers. See the [Interceptors & Extensions guide](/padrone/guides/plugins/#error-phase) for full details.

## Serialization

All Padrone errors have a `toJSON()` method for non-terminal contexts (APIs, web UIs):

```typescript
try {
  await program.cli();
} catch (error) {
  if (error instanceof PadroneError) {
    // { name, message, exitCode, suggestions, command, phase }
    res.status(500).json(error.toJSON());
  }
}
```

`ValidationError.toJSON()` also includes the `issues` array.

## Error Classes Reference

| Class | Phase | When |
|-------|-------|------|
| `RoutingError` | `parse` | Unknown command, unexpected arguments |
| `ValidationError` | `validate` | Schema validation failures |
| `ConfigError` | `config` | Config file not found, invalid format |
| `ActionError` | `execute` | Thrown from user action handlers |
| `PadroneError` | any | Base class for custom errors |
