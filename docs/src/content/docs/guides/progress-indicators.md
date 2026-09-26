---
title: Progress Indicators
description: Show spinners, progress bars, and status messages during long-running commands
---

Padrone provides a built-in progress indicator system for commands that take time — async operations, network calls, file processing, etc. Progress indicators are auto-managed by default (start before validation, succeed/fail after execution) but can also be driven manually from within an action handler.

## Quick Example

```typescript
import { createPadrone, padroneProgress } from 'padrone';

const program = createPadrone('app')
  .command('deploy', (c) =>
    c
      .async()
      .extend(padroneProgress('Deploying...'))
      .action(async () => {
        await deploy();
        return { version: '2.0' };
      })
  );
```

Running `app deploy` shows a spinner with "Deploying..." that auto-succeeds when the action resolves.

## Auto-Managed Progress

Use `padroneProgress()` to configure automatic progress indicators. Register it with `.extend()` on a command. The indicator starts before validation and is automatically stopped on success or failure. With `run()`, which skips validation, it starts right before the action.

When stderr is not a TTY (piped output, CI), the built-in renderer doesn't animate and only prints the final success or error line, using the latest message.

### Simple Message

```typescript
c.extend(padroneProgress('Deploying...'))
```

### Full Configuration

```typescript
c.extend(padroneProgress({
  message: {
    validation: 'Validating inputs...',  // Shown during async validation
    progress: 'Deploying...',            // Shown during execution
    success: 'Deployed successfully!',   // Shown on success
    error: 'Deploy failed',             // Shown on failure
  },
  spinner: 'line',                       // Spinner preset
  bar: true,                             // Enable progress bar
  time: true,                            // Show elapsed time
  eta: true,                             // Show estimated time remaining
}))
```

The `message` field accepts a string (shorthand for the `progress` message) or an object with per-phase messages. The `validation` message is shown first (during schema validation), then replaced by the `progress` message when execution begins.

## Messages

### String Shorthand

A string sets the `progress` message — used during execution and as fallback for other phases:

```typescript
padroneProgress('Deploying...')
// Equivalent to:
padroneProgress({ message: 'Deploying...' })
// Equivalent to:
padroneProgress({ message: { progress: 'Deploying...' } })
```

### Per-Phase Messages

Use an object to configure messages for each phase:

```typescript
padroneProgress({
  message: {
    validation: 'Validating...',
    progress: 'Deploying...',
    success: 'Done!',
    error: 'Failed',
  },
})
```

### Dynamic Success/Error Messages

The `success` and `error` fields accept callbacks that receive the actual result or error:

```typescript
padroneProgress({
  message: {
    progress: 'Deploying...',
    success: (result) => `Deployed v${result.version}`,
    error: (err) => `Deploy failed: ${err.message}`,
  },
})
```

### Custom Indicator Icons

Callbacks can return an object with `message` and `indicator` to override the success/error icon per-call:

```typescript
padroneProgress({
  message: {
    progress: 'Running checks...',
    success: (result) => ({
      message: `All ${result.count} checks passed`,
      indicator: '🎉',
    }),
    error: () => ({
      message: 'Checks failed',
      indicator: '💥',
    }),
  },
})
```

Static values also support the object form:

```typescript
padroneProgress({
  message: {
    progress: 'Building...',
    success: { message: 'Build complete', indicator: '🏗️' },
  },
})
```

### Suppressing Messages

Pass `null` to suppress the success or error message entirely (the spinner just clears):

```typescript
padroneProgress({
  message: {
    progress: 'Working...',
    success: null,  // No success message
  },
})
```

Callbacks can also return `null`:

```typescript
success: (result) => result.silent ? null : `Done: ${result.count} items`
```

### Messages from Context

Messages can be provided at the runtime level via `progressConfig.message` in the context. Command-level message fields take precedence per-field, so you can set shared defaults and override specific phases per command:

```typescript
const program = createPadrone('app')
  .context<{ progressConfig: PadroneProgressDefaults }>()
  .command('sync', (c) =>
    c.extend(padroneProgress({
      message: { progress: 'Syncing...' },  // overrides context progress
    })).action(() => 'synced')
  );

program.cli({
  context: {
    progressConfig: {
      message: { success: 'Done!' },  // shared default for success
    },
  },
});
```

## Manual Progress via `ctx.context.progress`

When `padroneProgress()` is registered, the action context provides a typed `progress` property on `ctx.context`:

```typescript
c.extend(padroneProgress('Importing...'))
  .action((args, ctx) => {
    for (const item of items) {
      process(item);
      ctx.context.progress.update(`Importing ${item.name}...`);
    }
    return `Imported ${items.length} items`;
  })
```

`padroneProgress()` uses the [context-providing interceptor](/guides/interceptors#context-providing-interceptors) mechanism — it declares `.provides<{ progress: PadroneProgress }>()`, so `ctx.context.progress` is fully typed when the interceptor is registered on the command.

### `PadroneProgress` Methods

| Method | Description |
|--------|-------------|
| `update(value)` | Update message, progress, or both (see below) |
| `succeed(message?, options?)` | Mark as succeeded and stop |
| `fail(message?, options?)` | Mark as failed and stop |
| `stop()` | Stop without success/fail status |
| `eta.start()` / `eta.stop()` / `eta.reset()` | Control the ETA display at runtime |
| `pause()` | Temporarily hide (for clean output) |
| `resume()` | Redraw after `pause()` |

With the built-in renderer, once the indicator is stopped (by `succeed()`, `fail()` or `stop()`), further calls are ignored, so calling `succeed()` yourself in an action replaces the auto-managed final message instead of printing a second one. Custom renderers should do the same.

The `update()` method accepts several forms:

```typescript
// Update message only
ctx.context.progress.update('Step 2...');

// Set progress ratio (0–1) — shows the bar
ctx.context.progress.update(0.5);

// Update both at once
ctx.context.progress.update({ message: 'Downloading...', progress: 0.75 });

// Switch to indeterminate bar (no percentage, shows animation)
ctx.context.progress.update({ indeterminate: true });

// Back to determinate
ctx.context.progress.update(0.9);

// Start elapsed timer on demand (when time wasn't set in config)
ctx.context.progress.update({ time: true });

// Stop elapsed timer
ctx.context.progress.update({ time: false });
```

## Elapsed Time and ETA

Show elapsed time and estimated time remaining alongside the indicator:

```typescript
c.extend(padroneProgress({
  message: 'Syncing...',
  bar: true,
  time: true,   // Show elapsed time (⏱ 0:05)
  eta: true,    // Show ETA based on progress rate (ETA 0:30)
}))
```

This renders as: ` 40% ████████░░░░░░░░░░░░ ⏱ 0:10 | ETA 0:06 ⠹ Syncing...`

When both `time` and `eta` are shown, they are separated by ` | `.

### Elapsed Time

The `time` option shows a running `⏱ M:SS` (or `H:MM:SS`) counter. When set in the config, it starts automatically when the indicator is created. It can also be toggled on demand:

```typescript
// Start timer explicitly mid-action
ctx.context.progress.update({ time: true });

// Stop timer display
ctx.context.progress.update({ time: false });
```

### ETA

The `eta` option shows `ETA M:SS` — an estimated time remaining based on the rate of numeric progress updates. It requires at least two `update(number)` calls to calculate a rate.

The displayed ETA counts down every second between progress updates, then recalculates when the next numeric update arrives.

## Progress Bar

Enable a progress bar with the `bar` option:

```typescript
c.extend(padroneProgress({
  message: 'Downloading...',
  bar: true,
}))
```

The bar renders as: `  40% ████████░░░░░░░░░░░░ Downloading...`

When no progress number has been set, the bar shows an indeterminate animation. Once `update(number)` is called, it switches to a determinate bar with a percentage.

### Bar Configuration

Pass an object for full control:

```typescript
c.extend(padroneProgress({
  message: 'Downloading...',
  bar: {
    width: 30,           // Bar width in characters (default: 20)
    filled: '▓',         // Filled character (default: '█')
    empty: '░',          // Empty character (default: '░')
    animation: 'pulse',  // Indeterminate animation style (default: 'bounce')
  },
}))
```

### Indeterminate Animations

Three built-in animation presets for indeterminate state:

| Animation | Description |
|-----------|-------------|
| `bounce` | A filled segment slides back and forth (default) |
| `slide` | A filled segment slides left-to-right and wraps around |
| `pulse` | The entire bar fades through gradient characters (`░▒▓█▓▒░`) |

### Explicit Indeterminate Mode

You can switch a bar to indeterminate mode at any time via `update()`:

```typescript
ctx.context.progress.update({ indeterminate: true, message: 'Waiting for server...' });
// ... later, back to determinate:
ctx.context.progress.update(0.5);
```

## Spinner Configuration

### Presets

Padrone includes four built-in spinner presets:

| Preset | Frames |
|--------|--------|
| `dots` | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` |
| `line` | `- \ \| /` |
| `arc` | `◜ ◠ ◝ ◞ ◡ ◟` |
| `bounce` | `⠁ ⠂ ⠄ ⡀ ⢀ ⠠ ⠐ ⠈` |

```typescript
c.extend(padroneProgress({ message: 'Loading...', spinner: 'line' }))
```

### Custom Frames

```typescript
c.extend(padroneProgress({
  message: 'Loading...',
  spinner: { frames: ['🌑', '🌒', '🌓', '🌔', '🌕'], interval: 150 },
}))
```

### Disabling the Spinner

Set `spinner: false` to show static text without animation:

```typescript
c.extend(padroneProgress({ message: 'Processing...', spinner: false }))
```

### Showing Both Spinner and Bar

By default, the spinner hides when the bar is visible. Use `spinner: true` to always show the spinner alongside the bar:

```typescript
c.extend(padroneProgress({
  message: 'Installing...',
  bar: true,
  spinner: true,  // Always show spinner, even with bar
}))
```

This renders as: `  40% ████████░░░░░░░░░░░░ ⠋ Installing...`

## Custom Renderer

The default renderer outputs to stderr with ANSI escape codes. For non-terminal environments (web UIs, testing), pass a custom `renderer`:

```typescript
c.extend(padroneProgress({
  message: 'Working...',
  renderer: (message, options) => ({
    update(value) { /* ... */ },
    succeed(msg) { /* ... */ },
    fail(msg) { /* ... */ },
    stop() { /* ... */ },
    pause() { /* ... */ },
    resume() { /* ... */ },
    eta: { start() {}, stop() {}, reset() {} },
  }),
}))
```

The built-in terminal renderer is also exported as `createTerminalProgress` for cases where you want to wrap or extend the default behavior.

### Testing with Mock Progress

```typescript
import { type PadroneProgressRenderer } from 'padrone';

function createMockProgress() {
  const indicators = [];
  const factory: PadroneProgressRenderer = (message) => {
    const calls = [];
    const indicator = {
      update: (value) => calls.push(`update:${JSON.stringify(value)}`),
      succeed: (msg) => calls.push(`succeed:${msg}`),
      fail: (msg) => calls.push(`fail:${msg}`),
      stop: () => calls.push('stop'),
      pause: () => {},
      resume: () => {},
      eta: { start() {}, stop() {}, reset() {} },
    };
    indicators.push({ message, indicator, calls });
    return indicator;
  };
  return { factory, indicators };
}

const { factory, indicators } = createMockProgress();
const program = createPadrone('app')
  .command('cmd', (c) =>
    c.extend(padroneProgress({ message: 'Working...', renderer: factory }))
      .action(() => 'done')
  );

program.eval('cmd');
// indicators[0].calls → ['succeed:undefined']
```

## Output Coordination

When auto-progress is active, `runtime.output` and `runtime.error` are automatically wrapped to pause/resume the indicator. This prevents garbled output when writing to the terminal while a spinner or bar is animating.

Manual calls to `ctx.context.progress.pause()` and `ctx.context.progress.resume()` are available if you need explicit control.

## How It Works Under the Hood

`padroneProgress()` is an extension that registers a context-providing interceptor. It:

1. **Registers an interceptor** that wraps the validate and execute phases with progress indicator management
2. **Provides typed context** via `.provides<{ progress: PadroneProgress }>()` so `ctx.context.progress` is fully typed
3. **Creates the indicator** using the configured renderer (defaults to the built-in terminal renderer)
4. **Uses a shutdown handler** as a safety net — if the indicator is not cleaned up by validate/execute (e.g., an outer interceptor threw), the command-level shutdown phase stops it

This means progress indicators interact naturally with other interceptors. The indicator starts before validation interceptors run and is cleaned up after execution. Interceptor errors are caught and reflected in the progress indicator:

```typescript
program
  .intercept(defineInterceptor({ name: 'auth' }, () => ({
    execute: (ctx, next) => {
      // If this throws, the progress indicator shows the error
      checkAuth();
      return next();
    },
  })))
  .command('deploy', (c) =>
    c.extend(padroneProgress('Deploying...')).action(handler)
  );
```
