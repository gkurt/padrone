---
packages:
  padrone: patch
---

## Fourth extension sweep: input and prompts

- `suggestions: { run: 'prompt' }` and help's `pickSubcommand` no longer ask with `--no-interactive`.
- "Did you mean" hints no longer suggest hidden options.
- An alias run with fewer words than its `$N` placeholders take fails (`Alias "pr" needs 1 argument`) instead of passing `$1` on literally.
- Interactive prompting skips object fields (and arrays of objects), which a text answer can't fill, instead of re-prompting forever.
- An empty answer to an optional field's prompt leaves it unset, so its default applies, instead of failing validation (e.g. for numbers) and re-prompting.
