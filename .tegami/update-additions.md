---
packages:
  padrone: minor
---

## Version, update check and upgrade improvements

- Without `.configure({ version })`, `--version`, `upgrade` and the update check read the version from the `package.json` of the package the program's script belongs to, instead of the working directory's project or `npm_package_version`.
- `upgrade --check --exit-code` exits with 1 when a newer version exists, like `npm outdated`.
- `upgrade` asks the registry first: when already up to date it says so without a `padroneConfirm()` prompt, and asks only when there is something to install.
- `padroneUpdateCheck()` never delays the exit: the notice comes from the version cached by an earlier run, and a stale cache is refreshed in a detached background process.
- The update check cache moved to `update-check.json` in `program.dirs.cache`; the old `~/.config/<name>-update-check.json` is moved there.
- The update notice suggests `<program> upgrade` when `padroneUpgrade()` is registered, and uses its package name and registry.
- `version --check` (also `--version --check`) asks the registry and adds an "Update available" notice, like `gh version`; under JSON output it returns `{ name, version, latest, updateAvailable }`. Remote callers get the version without a check.
