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

Monorepo with bun workspaces: `packages/*`, `examples/*`, `docs/`.

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

**Interceptor system**: Onion model with 7 phases: start → parse → route → validate → execute → (error) → shutdown. `collectInterceptors()` in `exec.ts` walks the parent chain (root outermost, subcommand innermost). Start/parse use root interceptors only. Route/validate/execute use the full collected chain (root + command). Error/shutdown run in two layers: command-level interceptors first (for validate/execute failures), then root-level interceptors (for all failures including parse). All interceptor phase contexts include `caller` (the invocation method: 'cli', 'eval', 'run', etc.) and `signal` (AbortSignal for cancellation). `defineInterceptor(meta, factory)` is the recommended API — the factory is called fresh per execution, enabling cross-phase state sharing via closures. Supports `.provides<T>()` and `.requires<T>()` for typed context (type-level only). Interceptors with the same `id` are deduplicated (last wins). Signal handling is implemented as a start-phase interceptor (`padroneSignalHandling`) that creates an AbortController and propagates it via `next({ signal })`. Error help display (routing/validation errors in CLI mode: the error plus a `--help` hint on stderr, or the full help with `builtins: { help: { showHelpOnError: true } }`) is handled by the help extension's error phase, not hardcoded in exec.ts. Deprecation warnings for deprecated commands/options are printed from the parse phase for `cli` and `repl` callers.

**Extension system**: Build-time composition via `.extend(extension)`. A `PadroneExtension` is a function that receives the builder and returns a modified builder, enabling reusable command/config bundles. Unlike interceptors (which hook into runtime phases), extensions operate at definition time to compose commands, arguments, and configuration. Built-in extensions are included by default via `createPadrone()`: help (-1000), version (-1000), repl (-1000), color (-1001), suggestions (-500), signal (-2000), autoOutput (-1100), stdin (-1001), interactive (-999). Numbers are interceptor `order` values (lower = outermost). User-facing builtins (help, version, repl) can be individually disabled via `{ builtins: { help: false } }`. Advanced opt-in extensions imported from `'padrone'`: logger, timing, progress, update-check, env, config. Optional integrations with heavier transitive surfaces live in their own subpath entry points so the main bundle stays lean: `padrone/ink`, `padrone/mcp`, `padrone/serve`, `padrone/tracing`, `padrone/completion`, `padrone/man`.

**Schema-aware parsing**: Tokenization follows routing and each option's schema type. `parseCliInputToParts(input, resolver)` (`src/core/parse.ts`) asks a `ParseResolver` (built by `createParseResolver` in `src/core/validate.ts`) for each option's `OptionArity`: `flag` (booleans; never take the next token unless it's a boolean word), `value` (always take a value, even one starting with `-`), `optional` (boolean|value unions; take the next token only if it doesn't look like an option or subcommand), `array` (like `value`, plus `[a,b]` syntax). Lookup order: the current command's schema, then `meta.options` declared by interceptors on the command chain (how built-ins like help/config/logger declare `--help`, `-c`, `--log-level`). Repeated non-array options keep the last value. Extra positionals are validation errors. Option paths through `__proto__`/`constructor`/`prototype` are stored flat so they can't pollute prototypes.

**Flags vs aliases vs negatives**: `flags` = single-char short flags (`-v`), stackable. `alias` = multi-char alternative long names (`--dry-run`). `autoAlias` (default: true) auto-generates kebab-case aliases for camelCase option names. `negative` = custom negation keyword(s) for booleans (`negative: 'remote'` makes `--remote` set the arg to `false` and disables `--no-` prefix). Set to `''` or `[]` to only disable the prefix.

**Execution paths**: `eval()`/`cli()` runs all 7 interceptor phases; `parse()` runs parse + validate; `run()` runs execute only (no validation).

**Context**: User-defined, strongly-typed object that flows through the command tree. Defined via `.context<T>()` (type-only) or `.context(transform)` (with runtime callback). Subcommands inherit the parent context type but can transform it. `mount()` accepts an optional `{ context }` option for context transforms. Context is provided at invocation via `cli()`, `eval()`, `run()`. Resolved by walking the command parent chain and applying transforms from root to target. Available in action handlers via `ctx.context` and in all interceptor phase contexts.

**Mutation commands**: `.configure({ mutation: true })` marks a command as performing side effects. Affects serve (POST-only, experimental), MCP (`annotations.destructiveHint`, experimental), and tool() (`needsApproval` default).

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
