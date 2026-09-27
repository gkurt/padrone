---
packages:
  padrone: minor
---

## Logger, task list, signal and timing additions

- `padroneLogger({ redact })` censors paths in logged objects, pino-style (`['user.password', '*.token']`, or `{ paths, censor }`).
- `padroneLogger({ destination })` writes log lines to a file path, a function or a `{ write }` stream instead of stderr.
- `logger.child({ requestId })` adds bindings to every line it writes, in text (`requestId=…`) and JSON formats.
- Log colors follow whether stderr is a terminal (the new `runtime.terminal.stderrIsTTY`), not stdout; with `stdout: true`, lines sent to stdout follow stdout.
- Tasks take `retry: n` (or `{ tries, delay }`) and a `rollback` handler run once a task has failed for good; `t.retry` tells which attempt is running.
- `tasks(list, { rendererOptions: { collapseSubtasks: true } })` hides the subtasks of finished tasks. Without a TTY or in CI, task lists now print start and finish lines (`createSimpleTaskList`, also usable as `taskRenderer`).
- `ctx.context.progress.isActive` and `isPaused` report the indicator's state.
- `padroneSignalHandling({ forceExitMs, onForceExit })` (or `builtins: { signal: { … } }`) sets the double Ctrl+C window and runs a cleanup hook before a force exit.
- `padroneTiming({ format })` customizes the timing line, which now reads `Failed after …` when the command fails.
- `padroneTiming()` registered on a command prints after the error message, like on the root: a failed command's shutdown handlers now run after the root error handlers.
- `runtime.open()` on Windows quotes targets with spaces and escapes cmd metacharacters.
- Interactive prompts are no longer disabled when `CI=false` or `CI=0`.
