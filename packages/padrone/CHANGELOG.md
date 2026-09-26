## padrone@2.1.0

### `cli()` keeps argv tokens whole and exits non-zero on errors

- Each `process.argv` entry is now exactly one token, so shell quoting is kept: `app g "Dancing Script" -c "Hello World"` no longer splits the values apart. Quotes, backslashes, `=` and non-ASCII text inside a value come through as typed, and an explicit empty entry (`-c ""`) is the value `""` instead of `true`. `eval()` and the REPL still tokenize their string input, and a quoted `""` there is now `""` too.
- A `cli()` run that ends with an error (routing, validation, or a thrown action) now sets the process exit code to the error's `exitCode`, or `1` (130 after SIGINT). It uses `process.exitCode`, not `process.exit()`, so output still flushes. Successful runs, `--help` and `--version` exit `0`.
- New `runtime.setExitCode(code)` to capture or ignore that exit code in custom runtimes.
- Interceptor `ctx.input` is now `string | string[] | undefined` (the `PadroneInput` type): `cli()` passes the argv array.

### Fix build failure when generating type declarations for the `padrone/zod` entry

The `padrone/zod` entry used a named re-export which tripped a `rolldown-plugin-dts` chunk-merge bug during the multi-entry build, breaking `npm publish`. Switched to a wildcard re-export so declaration generation succeeds.

## padrone@2.0.0

### Externalize optional integrations to dedicated subpath entry points

Optional integrations are now exported from dedicated subpath entry points so bundlers that don't tree-shake re-exports keep their dependencies out of the main bundle. Update imports as follows:

- `padroneInk`, `isReactElement`, `InkOptions` → `'padrone/ink'`
- `padroneMcp`, `WithMcp`, `PadroneMcpPreferences` → `'padrone/mcp'`
- `padroneServe`, `WithServe` → `'padrone/serve'`
- `padroneTracing`, `WithTracing`, `PadroneTracer`, `PadroneTracingConfig`, `OtelSpan`, `OtelTracer`, `OtelTracerProvider` → `'padrone/tracing'`
- `padroneCompletion`, `WithCompletion` → `'padrone/completion'`
- `padroneMan`, `WithMan` → `'padrone/man'`

# padrone

## 1.9.0

### Minor Changes

- [`8114f98`](https://github.com/KurtGokhan/padrone/commit/8114f98ce3ae46cb6cdfa152d39e78e35d6ebe7d) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-coerce CLI string values for union types (e.g. `z.union([z.boolean(), z.string()])`) — `--flag true` now correctly passes boolean `true` instead of the string `"true"`

## 1.8.2

### Patch Changes

- [`42b87eb`](https://github.com/KurtGokhan/padrone/commit/42b87eb008a1265bdc353a86d470debcfe42afb8) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-output extension now automatically prints errors hapened in execution phase. Interceptor context now has a `phase` field to understand in which phase an error happened during error/shutdown phases.

## 1.8.1

### Patch Changes

- [`e7c180c`](https://github.com/KurtGokhan/padrone/commit/e7c180c949709240838a7c95c4e74cd90d657352) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `route` phase to interceptors which will run when a command is routed to. This means it will run between parse and execute

- [`9d91f3f`](https://github.com/KurtGokhan/padrone/commit/9d91f3fee7bb07b501d61bbe202892be88fe7792) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - shutdown/error in interceptors can now run for command level interceptors

- [`e4ae6f5`](https://github.com/KurtGokhan/padrone/commit/e4ae6f58efb7e54452bf116e90f3ba9a24a3d7fb) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - fix progress not getting destroyed after an error

## 1.8.0

### Minor Changes

- [`7b58742`](https://github.com/KurtGokhan/padrone/commit/7b5874220f829fbbbc770a850093ce45430a8094) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `negative` meta option for boolean arguments. Custom keyword(s) set the option to `false` and disable the default `--no-` prefix. Supports string, array, and empty values to only disable the prefix.

- [`07b49ae`](https://github.com/KurtGokhan/padrone/commit/07b49aec2bdef4192c514b2ef3dc1a6ef65efce7) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `DefineCommandContext` interface and `defineCommand().requires()` for typed interceptor context in modular commands. Commands defined with `defineCommand()` now have optional `logger`, `tracing`, and `progress` context by default. Use `defineCommand().requires<T>().define(fn)` for additional context requirements with compile-time validation at `.command()` registration.

- [`e8bc2df`](https://github.com/KurtGokhan/padrone/commit/e8bc2dfd6f74f828f5cafb7dc2c0835974e24fc4) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Mark `padroneEnv` and `padroneConfig` as async at the type level. Extensions now return `WithAsync<T>` so `eval()` and `cli()` correctly return `Promise` when used.

- [`46cf13f`](https://github.com/KurtGokhan/padrone/commit/46cf13f96d2f376eb7ab7c6557c9ef45085535e5) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Auto-merge interceptor context in `next()`. Passing `next({ context: { user } })` now shallow-merges into existing context instead of replacing it. Default `TContext` changed from `unknown` to `object` so `ctx.context` is spreadable without type assertions.

### Patch Changes

- [`735ffb4`](https://github.com/KurtGokhan/padrone/commit/735ffb4a7d165c35feb050c4d6c6a5e136f1b173) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Detect ambiguous positional arguments provided both positionally and as named options. For example, `cmd val --pos1=val` with `positional: ['pos1', 'pos2']` now reports a validation error instead of silently overwriting.

## 1.7.1

### Patch Changes

- [`e15d537`](https://github.com/KurtGokhan/padrone/commit/e15d537bf492eaac80ec9f26ff01cfc398e4fd3b) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Fix `DefineCommand` with default context being incompatible with parent programs that have a specific context type.

## 1.7.0

### Minor Changes

- [`3eecb40`](https://github.com/KurtGokhan/padrone/commit/3eecb40ad4f678bf745b70fb1f791ceff4dfb541) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add format-aware output primitives (table, tree, list, key-value) to auto-output. Actions can use `ctx.context.output.table()`, `.tree()`, `.list()`, `.kv()` for styled output that adapts to the runtime format (ANSI, text, JSON, markdown, HTML). Declarative formatting via `padroneAutoOutput({ output: 'table' })` per-command. Extract shared Styler/Layout infrastructure from help formatter into reusable `styling.ts` module.

- [`0a27a69`](https://github.com/KurtGokhan/padrone/commit/0a27a6960622be5f053a9a49731de8d6adf65646) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add printf-style format specifiers (`%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O`, `%%`) to the logger extension, following WHATWG Console Standard conventions.

## 1.6.0

### Minor Changes

- [`75066f9`](https://github.com/KurtGokhan/padrone/commit/75066f9e12c33a1f64c502e248fce4d4e455d0da) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve "Did you mean?" suggestions for typos in commands and options. Return multiple matches (up to 3), add prefix/substring matching for inputs longer than 3 characters, and include `--` prefix in option suggestions. Suggestions are now included in soft-mode validation errors too.

- [`93ab85c`](https://github.com/KurtGokhan/padrone/commit/93ab85c88441e9062b2402f7d97f3d337293f2e7) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add typed context support. Define context with `.context<T>()` or `.context(transform)`, provide it via `cli()`, `eval()`, `run()`, and access it in action handlers as `ctx.context` and in all plugin phase contexts. Subcommands inherit context from parents. `.mount()` accepts an optional `{ context }` transform. New `InferContext` type helper.

- [`3b7fed0`](https://github.com/KurtGokhan/padrone/commit/3b7fed06d15cc2acad04df7d919ce0f6c9b66207) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add typed context injection for interceptors. Interceptors can declare provided context via `.provides<T>()` and required context via `.requires<T>()` on `defineInterceptor()`. Action handlers see the full merged context type. `.intercept()` rejects interceptors whose required context is not satisfied at compile time.

- [`067b9f7`](https://github.com/KurtGokhan/padrone/commit/067b9f7d695a838f0c39204c563029f8a2527675) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add extension system with `.extend()` for build-time composition. Rename plugins to interceptors (`.use()` → `.intercept()`, `PadronePlugin` → `PadroneInterceptor`). Move built-in commands to composable extensions. Default builtins (help, version, repl, color, config, interactive) are applied automatically via `createPadrone()`. Advanced features (completion, man, mcp, serve, update-check) are opt-in extensions. Individual builtins can be disabled via `createPadrone('name', { builtins: { help: false } })`.

- [`4e7f88b`](https://github.com/KurtGokhan/padrone/commit/4e7f88bdc68b7c97f36e3546142b6ebf5f87f76e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Respect terminal width in help output. Default and choices metadata now appear inline with descriptions when space allows, and long descriptions wrap aligned to the description column.

- [`aa0b568`](https://github.com/KurtGokhan/padrone/commit/aa0b568f35c2fcb97a78abf077561a914606de6f) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add support for Ink apps. The `ink` interceptor renders an Ink app as part of a command's execution, and waits for it to unmount before proceeding.

- [`91fd814`](https://github.com/KurtGokhan/padrone/commit/91fd8146c0fff0eb8c4e5f46191d1a6bf8203ecf) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `padroneLogger()` and `padroneTiming()` extensions for structured logging and command execution timing.

- [`99c8cfa`](https://github.com/KurtGokhan/padrone/commit/99c8cfa298194d9632b9c784858c1695e7782acf) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `program.info` for read-only access to program metadata (name, version, description, commands, etc.). Add XDG config directory support via `xdg` option on `padroneConfig()`.

- [`88c45af`](https://github.com/KurtGokhan/padrone/commit/88c45afeef123d4a3e5d5e4d359e080ddf60a154) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add elapsed time (`time: true`) and ETA (`eta: true`) to progress indicators. ETA is calculated from numeric progress updates and counts down between updates. Move progress messages into a `message` field (string or `{ validation, progress, success, error }` object) with runtime-level defaults via context.

- [`8691694`](https://github.com/KurtGokhan/padrone/commit/86916947b189109e6647684d30dc06992a3909b5) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve runtime agnosticism. Add `terminal` and `exit` fields to `PadroneRuntime`. Replace `Buffer` usage with `Uint8Array`/`TextEncoder`. Route scattered `process.*` reads through runtime abstraction. Replace all `require()` calls with dynamic `import()`. Use `runtime.onSignal` in serve/MCP instead of direct `process.on`.

- [`4343f78`](https://github.com/KurtGokhan/padrone/commit/4343f7857b6685c8e1774b4d933846cd786fe828) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add signal handling support for graceful shutdown. Actions and plugins receive an `AbortSignal` via `ctx.signal` that aborts on SIGINT/SIGTERM/SIGHUP. Command results include `signal` and `exitCode` fields when interrupted. Double Ctrl+C within 2 seconds force-quits. Export new `SignalError` class and `PadroneSignal` type.

- [`7464026`](https://github.com/KurtGokhan/padrone/commit/746402615e11262a0ff7257f41a4840c3a54143e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Reject unknown options for commands without `.arguments()`. Previously, commands without a schema accepted all options silently. Now they infer an empty object and error on unknown options.

- [`be62401`](https://github.com/KurtGokhan/padrone/commit/be624016ee6e4852ab043b15b4d525431319a168) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add experimental `padroneTracing()` extension for OpenTelemetry tracing. Logger automatically bridges log calls to span events when tracing is active.

### Patch Changes

- [`dbac7ec`](https://github.com/KurtGokhan/padrone/commit/dbac7ec56a9f0c320550eef2f6b188a3741d1d4e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `runtime` to interceptor contexts. Interceptors can now access and override the runtime via `ctx.runtime` instead of calling `getCommandRuntime()`. Support `next()` overrides for passing modified context to downstream interceptors.

- [`0dfae77`](https://github.com/KurtGokhan/padrone/commit/0dfae774d264d4cab092b90bb779dd3da46abaef) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Collect repeated non-array options into an array for the validator. Enables schemas like `z.union([z.string(), z.array(z.string())])` to receive all values when an option is passed multiple times.

## 1.5.0

### Minor Changes

- [`ef5e829`](https://github.com/KurtGokhan/padrone/commit/ef5e82931c06bbce70b6cdf3e34c179a48d04c66) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `asyncStream` for streaming stdin as `AsyncIterable`. New `padrone/zod` entrypoint exports `zodAsyncStream` and `jsonCodec` for typed streams with per-item validation. Extract shared `JSON_SCHEMA_OPTS` constant across all `jsonSchema.input()` calls.

- [`bbb05d9`](https://github.com/KurtGokhan/padrone/commit/bbb05d9dcf4b360d7f5ae85bdd4fa6e45b68b64d) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `examples` configuration to options and commands for command-line usage examples.

- [`7ff2738`](https://github.com/KurtGokhan/padrone/commit/7ff2738c146c419f4f03315ec8182af5be31d1b0) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Collapse global commands in help output to a single summary line by default. Add `--all` flag to show full global commands section. Bare `--detail` flag now defaults to `full`. Rename "Built-in" section to "Global".

- [`369ebba`](https://github.com/KurtGokhan/padrone/commit/369ebbab4dc14c1d8acfd2af01a9322f5d964e23) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `group` configuration to options and commands for organized help output.

  Options can be grouped via `fields: { myField: { group: 'Group Name' } }` in argument metadata. Commands can be grouped via `configure({ group: 'Group Name' })`. Grouped items are rendered under labeled `${group}:` sections in help output, while ungrouped items remain under the default `Options:` / `Commands:` headers.

- [`3d7b282`](https://github.com/KurtGokhan/padrone/commit/3d7b28202890925e05357c9796218349b4a8410e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add per-field validation during interactive prompts.

  When a user provides an invalid value for an interactive field, the prompt now immediately validates it against the schema and re-prompts with a warning message instead of deferring all errors until after all prompts complete. This applies to both required and optional interactive fields.

- [`1843f1f`](https://github.com/KurtGokhan/padrone/commit/1843f1f3a00714d11570c245361ab73c4049aa91) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Lazily initialize commands defined with callbacks. Builder functions passed to `.command()` are now deferred until the command is routed to, avoiding upfront construction of unused commands. Features that need the full command tree (help, MCP, serve, docs, completion, REPL) resolve all commands eagerly. Added `getCommand()` and `isPadroneProgram()` helpers to replace direct `commandSymbol` usage.

- [`45ba002`](https://github.com/KurtGokhan/padrone/commit/45ba002db474e34808b64b15ebce59b289f9115b) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add built-in Model Context Protocol (MCP) server. Expose CLI commands as AI tools via `mcp` command or `.mcp()` method. Supports Streamable HTTP and stdio transports per the 2025-11-25 MCP spec.

- [`ab53491`](https://github.com/KurtGokhan/padrone/commit/ab534915e3bcb5cd1c3f563f4fde740d1b91fa50) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - **BREAKING:** `eval()`, `cli()`, and `run()` no longer throw errors. Instead, they return a discriminated union with an `error` field:

  - Success: `{ command, args, argsResult, result, drain() }`
  - Error: `{ error, command?, args?, argsResult?, drain() }`

  Added `drain()` method to all command results. It flattens the result into a single `Promise<{ value } | { error }>` that never throws — resolving Promises, collecting iterables into arrays, and catching errors:

  ```ts
  const { value, error } = await program.cli().drain();
  ```

  New exported types: `PadroneDrainResult<T>`, `Drained<T>`.

- [`dffc5cd`](https://github.com/KurtGokhan/padrone/commit/dffc5cd36250f94cc82edae850aa34ae9916d43a) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add progress indicator system for commands with auto-managed spinners and manual control.

  **Auto-managed progress** via `.progress()` builder method:

  - `true` or `string` for simple messages, or a full config object with per-state messages
  - Starts before validation, auto-succeeds/fails after execution
  - Validation-phase message transitions to execution-phase message
  - `spinner` option: preset name (`dots`, `line`, `arc`, `bounce`), custom `{ frames, interval }`, or `false` to disable animation
  - `success`/`error` fields accept static strings, `null` to suppress, callbacks `(result) => string | null`, or `{ message, indicator }` objects for per-call icon customization

  **Manual progress** via `ctx.progress` in action handlers:

  - Works even without `.progress()` config — lazily creates a real indicator on first use
  - Auto-stopped when execution finishes (no leaked spinners)
  - No-op when the runtime has no progress factory

  **Built-in terminal spinner** (`createTerminalSpinner`):

  - ANSI-based spinner with pause/resume for clean output interleaving
  - Customizable success/error indicator icons via `PadroneProgressOptions`
  - Empty string indicators hide the icon prefix entirely
  - Graceful fallback in non-TTY/CI environments

  **New types**: `PadroneProgress`, `PadroneProgressConfig`, `PadroneProgressMessage`, `PadroneProgressOptions`, `PadroneSpinnerConfig`, `PadroneSpinnerPreset`

- [`6851b48`](https://github.com/KurtGokhan/padrone/commit/6851b4878ab0fc8d48f40e93c2f8924236a40165) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add REST server (`program.serve()`) and `mutation` command config.

  - New `serve()` program method: exposes commands as HTTP endpoints with automatic OpenAPI docs (Scalar).
  - New `serve` built-in CLI command: `myapp serve --port 3000`.
  - Built-in endpoints: `/_health`, `/_help`, `/_schema`, `/_docs` (Scalar), `/_openapi`.
  - New `mutation` option in `.configure()`: mutation commands are POST-only in serve, set `destructiveHint` in MCP, and default `needsApproval` to true in `tool()`.
  - MCP: rename `endpoint` to `basePath` for consistency with serve.
  - Shared utilities extracted from MCP (`collectEndpoints`, `buildInputSchema`, `serializeArgsToFlags`).

### Patch Changes

- [`7e8f14d`](https://github.com/KurtGokhan/padrone/commit/7e8f14ddb628620f94a7c9f2e88f9417577f2b04) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Expand boolean auto-coercion to accept `yes`/`no`/`on`/`off` (case-insensitive).

- [`a1c7072`](https://github.com/KurtGokhan/padrone/commit/a1c70724829f8cd4fb1632098f352498c87cbf2e) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Improve help output formatting: options now display flags first, then names, type, and description in aligned columns. Metadata (deprecated, default, choices, examples, env, config) is shown on separate indented lines.

- [`befc82e`](https://github.com/KurtGokhan/padrone/commit/befc82e39b4a1663c3ace74305dd48f9aded1a09) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Add `.catch()` and `.finally()` methods to thenable sync results from `eval()`, `parse()`, and `cli()`

- [`81f3bbc`](https://github.com/KurtGokhan/padrone/commit/81f3bbce54940953ff32d76c620eabd6cec7322f) Thanks [@KurtGokhan](https://github.com/KurtGokhan)! - Use `node:child_process` in wrap handler instead of `Bun.spawn` for Node.js compatibility.

## 1.4.0

### Minor Changes

- 365ad1f: Fix positional arguments and make results always thenable

  - Show choices and default values in help output for positional arguments
  - Fix type detection for optional array enum positionals (`z.array(z.enum([...])).optional()`)
  - Coerce single values to arrays when schema expects an array type
  - Make `cli()`, `eval()`, and `parse()` results always thenable (supports `.then()` and `await`)

### Patch Changes

- 79f51ae: Fix false async warning when action is async but validation is sync

## 1.3.0

### Minor Changes

- 6f6bfe5: Auto-generate kebab-case aliases for camelCase option names

  Options like `dryRun` automatically accept `--dry-run` on the CLI. This is enabled by default and can be disabled per-command with `autoAlias: false`. Auto-aliases are shown as the primary name in help text when available.

  ```ts
  // --dry-run automatically resolves to dryRun
  .arguments(z.object({ dryRun: z.boolean() }))

  // Disable auto-aliases
  .arguments(z.object({ dryRun: z.boolean() }), { autoAlias: false })
  ```

- 07cbf35: Split option `alias` into `flags` (single-char, stackable) and `alias` (multi-char long names)

  **Breaking:** `PadroneFieldMeta.alias` for single-character shortcuts is now `flags`.

  - `flags`: single-char short flags used with single dash (`-v`, `-o file`). Stackable: `-abc` = `-a -b -c`.
  - `alias`: multi-char alternative long names used with double dash (`--dry-run` for `--dryRun`).

  ### Migration

  ```diff
  - { fields: { verbose: { alias: 'v' } } }
  + { fields: { verbose: { flags: 'v' } } }
  ```

  ```diff
  - z.string().meta({ alias: ['v'] })
  + z.string().meta({ flags: ['v'] })
  ```

  Multi-char aliases remain as `alias`:

  ```ts
  {
    fields: {
      dryRun: {
        alias: "dry-run";
      }
    }
  }
  ```

- 186c2be: Improve help output formatting

  - Use bracket convention for option types: `<type>` for required, `[type]` for optional, nothing for booleans
  - Show kebab-case alias as primary name when available (e.g. `--dry-run` instead of `--dryRun`)
  - Move choices and default values after the description
  - Show array item types (e.g. `[string[]]` instead of `[array] (repeatable)`)
  - Hide empty default values (empty strings and arrays)
  - Cap description alignment at 32 characters
  - Show `(stdin)` marker on arguments that accept stdin input
  - Show `--no-` negation hint only when relevant (boolean options defaulting to true)
  - Remove `[no-]` prefix from individual boolean options

## 1.2.0

### Minor Changes

- 66336e5: auto-output is now enabled by default: command return values are automatically written to output in eval, cli, and repl modes. The runtime `output` function now accepts `unknown` values instead of only strings, letting runtimes handle formatting natively. Use `autoOutput: false` in preferences or `configure({ autoOutput: false })` on individual commands to opt out.
- 02a171c: Add runtime adapter for I/O abstraction, enabling CLI framework usage outside of terminals (web UIs, chat interfaces, testing). New `.runtime()` builder method configures output, error, argv, env, format, config file loading, and file discovery. All fields are optional with Node.js/Bun defaults. Successive `.runtime()` calls merge with previous configuration.
- 93155ef: Add `padrone/codegen` entry point with a generic code generation toolkit including CodeBuilder (fluent TypeScript source builder), template engine, schemaToCode (Standard Schema to Zod source), FileEmitter (multi-file output), built-in generators (command files, command trees, barrel files), and parsers (help text, fish completions, zsh completions, multi-source merge). Also add `padrone init` CLI command that scaffolds a new Padrone project using the codegen utilities, and reorganize CLI files into `src/cli/` subfolder.
- 68508a7: Add command override/extension support. Re-registering a command with the same name now merges instead of duplicating: configuration is shallow-merged, the previous handler is passed as a `base` parameter to `.action()`, arguments can be overridden, and subcommands are recursively merged by name. Aliases are preserved from the original when the override doesn't specify new ones. All fully strongly typed.

  Also fixes: REPL `.` command now works at any scope (including root) to execute the current command, `.help` always shows `.` and `.scope` entries, `cli()` and `repl()` return types now include all possible command results, and nested commands with default `''` subcommands route correctly.

- 7e83ebb: Improve command routing, help display, and `--` separator support.
- 583394b: Add `padrone/completion` subpath export and `padrone completions` CLI command. Shell completion generation is now lazy-loaded via dynamic import, and `setupCompletions()` writes eval snippets to shell config files with idempotent marker-based replacement. User programs get `--setup` on the built-in `completion` command (e.g. `myapp completion bash --setup`). The `.completion()` method is now async.
- 457f1f7: Add `padrone/docs` entry point with a `generateDocs()` utility that walks the command tree and generates structured documentation in four formats: markdown (with index page, frontmatter support for VitePress/Starlight), HTML (semantic with CSS classes), man pages (groff-formatted), and JSON. Each page includes command name, description, usage syntax, options with types/defaults/choices/aliases/env vars/config keys/examples, positional arguments, and subcommands table. Also add `padrone docs` CLI command that imports a Padrone program from any entry file and generates documentation to an output directory.
- 038d0aa: Add `padrone doctor <entry>` CLI command that lints and validates a Padrone program definition. Catches duplicate aliases, shadowed option/command names (help, version), commands without actions, schemas without descriptions, conflicting positional configs, and unused plugins.
- 262e2e6: Add `eval()` method and separate from `cli()`. `program.eval(input)` parses, validates, and executes a command string with soft error handling (returns result with issues instead of throwing). `program.cli()` is now exclusively the process entry point that reads from `process.argv` and throws on validation errors. The REPL and AI SDK tool integration now use `eval()` internally.
- fb86d5b: Add fuzzy matching for "Did you mean?" suggestions on unknown commands and options.
- 020cc21: Add interactive field prompting. Commands can now declare `interactive` and `optionalInteractive` in the arguments meta to prompt users for missing field values during `cli()`. Interactive prompts are auto-detected from the schema (boolean → confirm, enum → select, array enum → multiselect). The runtime controls whether interactivity is enabled via `runtime({ interactive: true })`, with a built-in Enquirer-powered terminal prompt as the default. Custom prompt implementations can be provided for non-terminal runtimes.
- cba6615: Add lifecycle hooks to the plugin system: `start`, `error`, and `shutdown` phases. `start` wraps the entire pipeline (before parse), `error` handles pipeline failures with the ability to suppress or transform errors, and `shutdown` always runs after completion for cleanup. All three use the same onion/middleware pattern as existing phases. Available in `eval()` and `cli()` only. Sync preservation is maintained.
- 727c6af: Add `padrone link` and `padrone unlink` CLI commands for linking programs during development. Creates shell shims in `~/.padrone/bin/` that invoke the entry file with the detected runtime. Auto-detects entry from `package.json` bin field and runtime from lockfiles. Use `--setup` to automatically add `~/.padrone/bin` to PATH in shell config. Shell utilities (`detectShell`, `getRcFile`, `writeToRcFile`) extracted to `shell-utils.ts` for reuse.
- fdca76f: Add `.mount(name, program)` method for composing Padrone programs together. Mounts an existing program as a subcommand, recursively re-pathing all nested commands and preserving arguments, handlers, plugins, and schemas. Supports aliases via array syntax. Mounted program's root-level `version` is dropped. Type-level paths are recursively updated for correct inference with `eval()`, `find()`, `run()`, etc.
- 4706462: Add plugin system with middleware pattern for intercepting command execution phases. Plugins use an onion model with `next()` to wrap parse, validate, and execute phases. Registered via `.use()` on both programs and subcommand builders. Program-level plugins apply as outermost wrappers; subcommand plugins compose as inner layers. Parse phase runs root plugins only. Supports explicit ordering via `order` parameter, shared mutable `state` across phases, sync preservation, and short-circuiting.
- 1a44f9d: Add REPL command history, tab completion, and output styling. The built-in terminal REPL now supports up/down arrow history navigation and tab completion for command names, subcommands, options, and aliases. New `repl()` preferences: `history` (initial entries), `completion` (toggle tab completion), `spacing` (separators before/after command output — supports blank lines, repeated characters, multi-line arrays, and independent before/after config), and `outputPrefix` (prefix each output line, e.g. `'│ '`). The default prompt is bold in ANSI-capable terminals.
- a73bf6a: Add REPL mode. `program.repl()` starts an interactive Read-Eval-Print Loop that returns an `AsyncIterable<PadroneCommandResult>`, yielding a result for each successfully executed command. Errors are caught and printed without crashing the session. Built-in REPL commands (`exit`, `quit`, `clear`) are provided but yield to user-defined commands of the same name. The runtime gains a new `readLine` field for abstracting line input, with a default Node.js/Bun `readline` implementation.
- 5437416: Add scoped/contextual REPLs, `--repl` CLI flag, and dot-prefixed built-in commands. All REPL built-ins now use dot-prefix notation (`.exit`, `.quit`, `.clear`, `.scope`, `.help`, `.history`) to avoid collisions with user commands. `.scope <subcommand>` scopes the REPL session to a command subtree, `.scope ..`/`..` goes back up, `.` executes the current scoped command. `.help` shows REPL-specific commands and keybindings. `.history` shows session command history. Default greeting displays program name and version; configurable `hint` text shown below. Double Ctrl+C to exit (first press shows hint). The prompt updates to reflect scope (e.g. `myapp/db ❯`). `options.scope` allows starting pre-scoped and is strongly typed to valid command paths. The `--repl` flag in `cli()` starts a REPL (optionally scoped to a command).
- b021824: Removed parse options. Custom runtimes can be used for the same behavior.
- 3ad9c6f: Add stdin piping support. Commands can declare a `stdin` field in their arguments meta to read piped input and inject it into a schema field. Supports `text` mode (read all as string) and `lines` mode (read as string array). Precedence: CLI flags > stdin > env vars > config file > schema defaults. Stdin is only read when piped (not a TTY) and the target field wasn't already provided via CLI. Runtime abstraction (`PadroneRuntime.stdin`) enables custom stdin sources for testing and non-terminal environments. Test harness gains `.stdin(data)` builder method. Help output shows `[stdin > field]` in usage line.
- a64f576: Add `padrone/test` entry point with testing utilities. The `testCli(program)` function provides a fluent builder for setting up CLI test scenarios with mock I/O capture. Supports mocking environment variables (`.env()`), interactive prompt answers (`.prompt()`), config files (`.config()`), and REPL sessions (`.repl()`). Works with any test framework.
- 6269637: add async validation support
- 6d15076: Add built-in opt-in update checking via `.updateCheck()`. When enabled, the program checks the npm registry (or a custom URL) for newer versions in the background and displays a notification after command output. Checks are cached to avoid hitting the registry on every invocation. Respects CI environments, non-TTY contexts, `--no-update-check` flag, and a configurable env var to disable.

### Patch Changes

- 54de1b9: show built-in commands and flags (help, version, completion, --repl) in root help output
- 6fa2ac9: improve help output formatting: show actual positional argument names in usage line, use `[options]` instead of `[arguments]` for flags, and rename flags section from "Arguments" to "Options"
- bf6fe49: Add AI coding agent skill with API reference, examples, and installation instructions for Claude Code and other Agent Skills-compatible tools.

## 1.0.0

Initial stable release of Padrone - a TypeScript CLI framework with Zod schema support.

### Features

- Type-safe argument parsing with Zod schemas
- Interactive prompts with validation
- AI integration support via Vercel AI SDK
- Standard Schema compatibility
- Terminal UI components
- Command builder pattern
