---
packages:
  padrone: patch
---

## Progress indicator fixes

- `padroneProgress()` no longer crashes with `run()`; the indicator starts right before the action.
- A final message is printed once: calling `succeed()`, `fail()` or `stop()` yourself is no longer followed by a second auto-managed message.
- When stderr is not a TTY, the final message uses the latest `update()` message instead of the initial one.
- Elapsed time and ETA keep counting when the spinner and bar are disabled.
- A spinner keeps its configured speed when shown next to a bar.
- Very narrow bars (`width` under 3) no longer throw.
- `pause()` no longer writes escape codes to stdout, which corrupted piped output.
- ETA estimation restarts when progress moves backwards.
- An indicator is stopped when a `success`/`error` message callback throws.
