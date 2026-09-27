---
packages:
  padrone: patch
---

## Fourth extension sweep: logging, progress and lifecycle

- `upgrade --check` no longer asks for confirmation under `padroneConfirm()`, and `upgrade --check --dry-run` reports the check.
- `padroneUpgrade()` detects yarn global installs on Windows.
- JSON log lines keep their own `time` and `level`, and a message argument wins over a `msg` field.
- Shutdown interceptors (signal cleanup, timing, progress) still run when an error interceptor throws; the thrown error becomes the result's error.
- `padroneTiming()` rounds before choosing the unit, so it no longer prints `1000ms` or `60.00s`.
- `padroneUpdateCheck()` treats `CI=false` and `CI=0` as not CI, and only checks when the program has a `version`, instead of comparing against the working directory's `package.json` or `npm_package_version`.
- Progress spinners, bars and task lists don't animate in CI or with `TERM=dumb`; they print final lines only.
- Output written while `progress.pause()` is in effect no longer redraws the indicator before `resume()`.
