---
packages:
  padrone: minor
---

## `cli()` keeps argv tokens whole and exits non-zero on errors

- Each `process.argv` entry is now exactly one token, so shell quoting is kept: `app g "Dancing Script" -c "Hello World"` no longer splits the values apart. Quotes, backslashes, `=` and non-ASCII text inside a value come through as typed, and an explicit empty entry (`-c ""`) is the value `""` instead of `true`. `eval()` and the REPL still tokenize their string input, and a quoted `""` there is now `""` too.
- A `cli()` run that ends with an error (routing, validation, or a thrown action) now sets the process exit code to the error's `exitCode`, or `1` (130 after SIGINT). It uses `process.exitCode`, not `process.exit()`, so output still flushes. Successful runs, `--help` and `--version` exit `0`.
- New `runtime.setExitCode(code)` to capture or ignore that exit code in custom runtimes.
- Interceptor `ctx.input` is now `string | string[] | undefined` (the `PadroneInput` type): `cli()` passes the argv array.
