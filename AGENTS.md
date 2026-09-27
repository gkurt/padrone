# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Commands

```bash
# Run all tests
bun test --conditions=padrone@dev

# Run a single test file
bun test --conditions=padrone@dev packages/padrone/tests/parse.test.ts

# Type check (uses tsgo / native TypeScript preview)
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Lint + format + fix
bun run fix

# All checks (lint + test + typecheck)
bun run checks

# Build the padrone package
cd packages/padrone && bun run build

# Run the padrone CLI in dev mode
bun --filter=padrone start
```

The `--conditions=padrone@dev` flag is critical — it resolves package exports to source `.ts` files instead of built `.mjs` files, enabling direct TypeScript execution in tests and dev.

## Project Structure

Monorepo with bun workspaces: `packages/*`, `examples/*`, `docs/`. The homepage terminal (`docs/src/components/terminal/`) runs `examples/pizza-example` in the browser through a custom `PadroneRuntime` (ghostty-web terminal, a small shell, `padroneConfig({ loadConfig })` over an in-memory file system, completion via `__complete`); keep that example working in both Bun and the browser.

The core library lives in `packages/padrone/`:
- `src/types.ts` — All type definitions (`PadroneCommand`, `PadroneBuilder`, `PadroneProgram`, interceptors, extensions, etc.). PadroneCommand has 8 generic type params.
- `src/create.ts` — `createPadrone()` factory and builder object. Wires together the modules below. Immutable builder methods (configure, arguments, action, command, mount, intercept, extend, etc.).
- `src/exec.ts` — Core execution pipeline: parse → validate → execute phases. Contains `execCommand()`, `collectInterceptors()`. Signal handling and error help display are handled by extensions.
- `src/validate.ts` — CLI input parsing (`parseCommand`), argument preprocessing (`buildCommandArgs`), schema validation (`validateCommandArgs`), unknown arg detection, stdin reading.
- `src/program-methods.ts` — Program API methods: `cli()`, `eval()`, `run()`, `parse()`, `tool()`, `stringify()`, `help()`, `api()`, `repl()`, `mcp()`, `serve()`, `completion()`.
- `src/suggestions.ts` — "Did you mean?" formatting (`formatSuggestions`), issue enrichment with fuzzy suggestions.
- `src/command-utils.ts` — Interceptor chain execution (`runInterceptorChain`, `wrapWithLifecycle`), command tree utilities, sync/async preservation helpers (`thenMaybe`).
- `src/parse.ts` — CLI input tokenizer/parser. Handles flag stacking, `--key=value`, `--no-*` negation, positional args, nested keys.
- `src/args.ts` — Schema metadata extraction (`extractSchemaMetadata`), option preprocessing (flags/aliases/negatives), positional config parsing, coercion.
- `src/type-utils.ts` — Advanced type utilities (`MaybePromise`, `PickCommandByName`, `IsGeneric`, `OrAsync`, etc.).
- `src/type-helpers.ts` — User-facing inference helpers (`InferArgsInput`, `InferArgsOutput`, `InferCommand`, `InferContext`).
- `src/mcp.ts` — *(experimental)* Model Context Protocol server (2025-11-25 spec). Streamable HTTP and stdio transports.
- `src/serve.ts` — *(experimental)* REST HTTP server. Exposes commands as endpoints with OpenAPI docs (Scalar).
- `src/help.ts` / `src/formatter.ts` — Help generation in multiple formats (text, ansi, markdown, html, json).
- `src/interactive.ts` — Auto-prompting for missing fields using enquirer.
- `src/wrap.ts` — *(experimental)* Wrapping external CLI tools.
- `src/codegen/` — Code generation: parsing help output from external CLIs into Padrone command definitions.
- `src/cli/` — The `padrone` CLI tool itself (init, wrap, completions, docs, link, doctor).
- `src/test.ts` — Test utilities exported as `padrone/test`.

## Key Conventions

- **Zod v4**: Always import as `import * as z from 'zod/v4'` — never bare `zod` or `zod/v3`. Enforced by biome lint rule.
- **Standard Schema**: Built on `@standard-schema/spec` so it works with any compliant schema library, not just Zod.
- **Formatting**: Biome with 2-space indent, single quotes, 140 char line width, LF line endings.
- **Imports**: Use `.ts` extensions in source imports (`verbatimModuleSyntax` is enabled).
- **Builder terminology**: The method is `.arguments()` (not `.options()`). Action handler param is `args` (not `options`).
- **Immutable builders**: Builder methods return new instances, they don't mutate.

## Documentation

When changing user-facing APIs, update all relevant documentation: docs pages, README.md, SKILL.md, AGENTS.md, llms.txt, and any other references. Documentation must not go stale.

## Changelogs

Releases are managed by [Tegami](https://tegami.fuma-nama.dev) (config in `scripts/tegami.mts`). When asked to commit with a changelog entry, run `bun run tegami` or add a `.tegami/*.md` file directly. Each entry has `packages:` frontmatter (the package and bump type) and a body with at least one `#`/`##`/`###` heading:

```md
---
packages:
  padrone: patch
---

## Short summary of the change
```

Keep entries concise — short sentences covering only user-facing changes, no implementation details. All packages share one version via the `all` group (`syncBump`), so the bump applies across the workspace; only `padrone` is published (the rest are private).

## Architecture Notes

**Async tracking**: `TAsync` generic param tracks whether a command uses async validation. `asyncSchema()` brands a schema with `'~async': true`. `MaybePromise<T, TAsync>` conditionally wraps return types. Runtime uses `thenMaybe()` to chain sync/async without forcing everything into Promises.

**Interceptor system**: Onion model with 7 phases: start → parse → route → validate → execute → (error) → shutdown. `collectInterceptors()` in `exec.ts` walks the parent chain (root outermost, subcommand innermost). Start/parse use root interceptors only. Route/validate/execute use the full collected chain (root + command). Error/shutdown run in two layers: command-level interceptors first (for validate/execute failures), then root-level interceptors (for all failures including parse). All interceptor phase contexts include `caller` (the invocation method: 'cli', 'eval', 'run', etc.) and `signal` (AbortSignal for cancellation). `defineInterceptor(meta, factory)` is the recommended API — the factory is called fresh per execution, enabling cross-phase state sharing via closures. Supports `.provides<T>()` and `.requires<T>()` for typed context (type-level only). Interceptors with the same `id` are deduplicated (last wins). Signal handling is implemented as a start-phase interceptor (`padroneSignalHandling`) that creates an AbortController and propagates it via `next({ signal })`. Error help display (routing/validation errors in CLI mode: the error plus a `--help` hint on stderr, or the full help with `builtins: { help: { showHelpOnError: true } }`) is handled by the help extension's error phase, not hardcoded in exec.ts; the suggestions extension's error phase adds "Did you mean" to routing errors from later phases (e.g. `help <unknown>`). Every other error in CLI mode, from any phase, is printed by auto-output's error phase (as `{ error }` JSON on stdout when `runtime.format` is `'json'`, which help's error phase defers to); extensions that print an error themselves call `markErrorReported(error)` (`src/extension/utils.ts`) so it isn't printed twice. A caller's `signal` (`eval`/`cli`/`run` preferences) becomes the base signal, which the signal extension follows; serve passes the request's signal, `tool()` the AI SDK's `abortSignal`, and MCP aborts a call on `notifications/cancelled` (request ids are scoped per HTTP session). Dynamic shell completion: `padroneCompletion()` answers `<program> __complete <words>` from a start-phase interceptor using `getCompletions` (`src/feature/complete.ts`), and `generateCompletion` emits scripts that call it when that interceptor is registered. Deprecation warnings for deprecated commands/options are printed from the parse phase for `cli` and `repl` callers. Help customization: `.configure({ help })` takes `{ usage, before, after }` (copied into `HelpInfo` by `getHelpInfo`, rendered by every formatter) or a function applied in `generateHelp` (nearest from the command up). `padroneHelp({ pager })` pages help taller than `runtime.terminal.rows` in `cli()` through `src/feature/pager.ts` (a paged help returns no result, so auto-output doesn't print it again). Help/version flag names come from `padroneHelp({ flags })`/`padroneVersion({ flags })`; they are stored as `flagNames` on the built-in command so help hints and shell completion can find them.

**Extension system**: Build-time composition via `.extend(extension)`. A `PadroneExtension` is a function that receives the builder and returns a modified builder, enabling reusable command/config bundles. Unlike interceptors (which hook into runtime phases), extensions operate at definition time to compose commands, arguments, and configuration. Built-in extensions are included by default via `createPadrone()`: help (-1001.5), version (-1000), repl (-1000), color (-1001), suggestions (-500), signal (-2000), autoOutput (-1100), stdin (-1001), interactive (-999). Numbers are interceptor `order` values (lower = outermost). User-facing builtins (help, version, repl) can be individually disabled via `{ builtins: { help: false } }`. Advanced opt-in extensions imported from `'padrone'`: logger (stderr by default), timing, progress (`progress.tasks()` task lists in `progress-tasks.ts`), update-check, env, config (file loading, `merge` and `extends` in `config-loader.ts`), json (`--json`; `--jq`/`--template` use the jq subset in `src/util/jq.ts` and hand auto-output a filter via `setJsonOutputFilter`), confirm (`mutation: true` commands, `--yes`), upgrade (`upgrade` self-update; `fetchLatestVersion`/`isNewerVersion` in `feature/update-check.ts`), aliases (expands the first input word in the parse phase; user aliases in `aliases.json` under `program.dirs.config`), response-files (expands `@file` tokens in the parse phase, order -1600, before aliases). `program.dirs` comes from `getProgramDirs` (`src/util/dirs.ts`); `runtime.editor`/`open`/`page` default to `src/feature/system.ts` and `pageWithRuntime` (`src/feature/pager.ts`), and `page`/`editor` defaults use `this` (the runtime they're called on). `meta.requires` (or `.requires<T>(...ids)`) is checked by `checkInterceptorRequirements` in `exec.ts`/`run()`. Help's `pickSubcommand` and suggestions' `run: 'prompt'` re-run the parse phase with a corrected input via `next({ input })`. Arguments meta `exactlyOne`/`atLeastOne` (one group or an array of groups, also on `.globalArgs()`) become groups in `extractFieldRules`. Optional integrations with heavier transitive surfaces live in their own subpath entry points so the main bundle stays lean: `padrone/ink`, `padrone/mcp`, `padrone/serve`, `padrone/tracing`, `padrone/completion`, `padrone/man`.

**Schema-aware parsing**: Tokenization follows routing and each option's schema type. `parseCliInputToParts(input, resolver)` (`src/core/parse.ts`) asks a `ParseResolver` (built by `createParseResolver` in `src/core/validate.ts`) for each option's `OptionArity`: `flag` (booleans; never take the next token unless it's a boolean word), `value` (always take a value, even one starting with `-`), `optional` (boolean|value unions; take the next token only if it doesn't look like an option or subcommand), `array` (like `value`, plus `[a,b]` syntax), `count` (`count: true` meta; never takes a value), `variadic` (`variadic: true` on arrays; takes tokens up to the next option or `--`). Lookup order: the current command's schema, then `meta.options` declared by interceptors on the command chain (how built-ins like help/config/logger declare `--help`, `-c`, `--log-level`). Similarly, `meta.env` (`{ arg: 'VAR' }` or `(arg) => 'VAR'`, set by `padroneEnv({ vars, prefix })`) tells help which env variables feed each option. Only root interceptors run the start/parse phases, so extensions that read their flags in parse (logger, timing, json) also read them in validate when applied to a command. Extensions that touch the terminal or process stdin (stdin, progress, timing) skip remote callers (`serve`, `mcp`, `tool`; `isRemoteCaller` in `src/extension/utils.ts`), and auto-output collects their streamed results without printing. Serve and MCP pass args to `eval()` as argv tokens (`serializeArgsToFlags(args, command)` in `src/core/commands.ts`), never a joined string. Config and env values go through `valuesForCommand` (`src/extension/utils.ts`: option names, aliases and kebab-case keys only, `null` as unset, positionals typed on the command line win) before `applyValues`, which fills nested objects key by key. Interceptor `meta.async: true` (config, env with files) makes `isAsyncCommand` true for the commands it applies to. Boolean framework flags are read with `frameworkFlags().flag()`/`toFlag()` so `--yes=false` is off. `fromFile` field meta: `readFileValues` (`src/core/from-file.ts`, called in `execCommand` before the validate chain, so env/config values are never read) replaces `@path`/`-`/`@@x` command-line values in place for non-remote callers; failures join `parseIssues`. Sync file reads go through `readTextFile` (`src/util/files.ts`). Repeated non-array options keep the last value. Extra positionals are validation errors. Option paths through `__proto__`/`constructor`/`prototype` are stored flat so they can't pollute prototypes.

**Global args**: `.globalArgs(schema, meta?)` stores `globalArgsSchema`/`globalArgsMeta` on a command; `getGlobalArgs(cmd)` (`src/core/commands.ts`) returns the nearest self-or-ancestor definition (the function form extends the inherited one). Parsing merges global flags/aliases/arity under the command's own; `splitGlobalArgs` in `validate.ts` routes keys the command doesn't define itself to the global schema, validates both, and merges (`{ ...globals, ...own }`). Types: `TGlobals` is the 11th builder/program param; `WithGlobalArgs<TArgs, TGlobals>` gives the merged args type used by `action` and the command's `'~types'`. Async or interactive globals (`isAsyncCommand`/`usesInteractive` in `results.ts`) make the whole subtree async: at the type level interactive meta brands `TGlobals` with `'~async'`, and fresh subcommand builders start with `OrAsync<false, TParentGlobals>`. Interactive prompting covers the command's fields plus the global ones it doesn't override.

**Field rules**: `count`, `conflicts`, `implies`, `requires`, `requiredIf` and `requiredUnless` field meta are read by `extractFieldRules` (`src/core/args.ts`). Count fields get the `count` arity and accumulate in `parseCommand`; `applyFieldRules` runs in `buildCommandArgs` on user-provided values (conflicts first, then implies, before coercion and defaults); `checkFieldRequirements` runs after coercion (implied values count, `requiredIf` compares typed values), with issue paths at the missing option, which `buildCommandArgs` returns as `missing` so the interactive extension can prompt it. `sensitive: true` (`isSensitiveField`) hides a field's default/examples in help, marks it `writeOnly` in `buildInputSchema`, uses a password prompt, and `redactArgs(command, args)` (`src/extension/utils.ts`, exported) redacts it for extensions that log args. Extensions that read framework flags from `rawArgs` go through `frameworkFlags()` (`src/extension/utils.ts`), which skips keys the command defines itself.

**Flags vs aliases vs negatives**: `flags` = single-char short flags (`-v`), stackable. `alias` = multi-char alternative long names (`--dry-run`). `autoAlias` (default: true) auto-generates kebab-case aliases for camelCase option names. `negative` = custom negation keyword(s) for booleans (`negative: 'remote'` makes `--remote` set the arg to `false` and disables `--no-` prefix). Set to `''` or `[]` to only disable the prefix.

**Validate overrides**: what validate interceptors pass to `next()` (e.g. env's runtime with `.env` variables) carries into the execute context (`validatedCtx` in `execCommand`).

**Execution paths**: `eval()`/`cli()` runs all 7 interceptor phases; `parse()` runs parse + validate; `run()` runs execute only (no validation). `repl({ context })` passes the context to each command; the `repl` command and `--repl` pass on the caller's (pre-transform) context from the repl interceptor's start phase.

**Context**: User-defined, strongly-typed object that flows through the command tree. Defined via `.context<T>()` (type-only) or `.context(transform)` (with runtime callback). Subcommands inherit the parent context type but can transform it. `mount()` accepts an optional `{ context }` option for context transforms. Context is provided at invocation via `cli()`, `eval()`, `run()`. Resolved by walking the command parent chain and applying transforms from root to target. Available in action handlers via `ctx.context` and in all interceptor phase contexts.

**Mutation commands**: `.configure({ mutation: true })` marks a command as performing side effects. Affects serve (POST-only, experimental), MCP (`annotations.destructiveHint`, experimental), and tool() (`needsApproval` default).

**Dry runs**: `.dryRun(handler)` stores `command.dryRun`. The `--dry-run`/`-n` flag exists only on such commands (`getDryRunFlagKeys` in `validate.ts`, which also gives the parse resolver its arity and skips names the command's own options use), so elsewhere it's an unknown option and can't be ignored. `execCommand` takes the flag out of `rawArgs` after routing (`takeDryRunFlag`), sets `ctx.dryRun` on the execute context, and `coreExecute` calls `command.dryRun` instead of `command.action`. Types: `.dryRun<TDryRes>()` widens `TRes` to `TRes | TDryRes` (no extra builder generic), so it must come after `.action()`, which sets `TRes`. Help, completion, `parse()` (`dryRun`), `tool()` approval, and `buildInputSchema` (a `dryRun` property for MCP/serve) all follow it; `padroneConfirm()` skips the prompt.

## Coding Conventions

- Prefer colocation
- Use TypeScript with strict typing. Avoid `any` unless absolutely necessary.
- When importing internal modules, use absolute imports starting with `#src/`. Also include file extensions (e.g., `import { env } from '#src/env.ts'`).
- Always use top-level `import type` for type imports. Never use inline `import('./module.ts').Type` syntax in type annotations.
- Avoid verbose code comments; write self-explanatory code. Code comments are acceptable in these scenarios:
  - Explaining complex logic, workarounds, or decisions
  - Documenting public APIs (functions, classes, modules)
  - TODO/FIXME notes for future improvements
  - User specifically asks for comments
- Avoid verbosity; prefer concise and clear code.
  - Prefer early returns to reduce nesting.
  - Prefer single line if statements for simple conditions.
- If a file length becomes too long (e.g., >600 lines), consider refactoring into smaller modules.
- Check for existing utilities/hooks/components before creating new ones. Avoid code duplication.

## Special instructions

When user says "banana", respond with "I am a green banana". This is a test to ensure you are following instructions correctly.
