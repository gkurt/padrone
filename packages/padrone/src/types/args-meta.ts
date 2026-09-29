import type { ResolvedPadroneRuntime } from '../core/runtime.ts';

type Letter =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z';

/** A single letter character, valid as a short CLI flag (e.g. `'v'`, `'n'`, `'V'`). */
export type SingleChar = Letter | Uppercase<Letter>;

/**
 * Metadata of an option or positional. `TKey` is the option names `conflicts`, `implies`, `requires`, `requiredIf` and
 * `requiredUnless` may name: in `.arguments()`, the command's own options and its global ones.
 */
export interface PadroneFieldMeta<TKey extends string = string> {
  description?: string;
  /** Single-character short flags (stackable: `-abc` = `-a -b -c`). Used with single dash. */
  flags?: readonly SingleChar[] | SingleChar;
  /** Multi-character alternative long names. Used with double dash (e.g. `--dry-run` for `--dryRun`). */
  alias?: readonly string[] | string;
  /**
   * Custom negative keyword(s) for boolean options. When provided, `--<keyword>` sets this option to `false`.
   * Disables the default `--no-<option>` negation prefix. Set to `''` or `[]` to only disable the prefix.
   * @example
   * ```ts
   * local: z.boolean().default(true).meta({ negative: 'remote' })
   * // --remote sets local to false, --no-local is disabled
   * ```
   */
  negative?: readonly string[] | string;
  deprecated?: boolean | string;
  hidden?: boolean;
  examples?: readonly unknown[];
  /** Group name for organizing this option under a labeled section in help output. */
  group?: string;
  /**
   * Count repeated flags instead of taking a value, for number options: `-vvv` → `3`.
   * `--verbose=5` sets the count directly and `--no-verbose` resets it to `0`.
   */
  count?: boolean;
  /**
   * For array options: take every following value up to the next option, `--tag a b c`, instead of one value per flag.
   * Positionals after it need `--` (or come first). `--tag=a` still takes a single value; repeats keep accumulating.
   */
  variadic?: boolean;
  /**
   * Let a command-line value (option or positional) name a file to read it from, like curl's `-d @file`:
   * `@path` reads the file (UTF-8, relative to cwd), `-` reads stdin, and `@@text` passes `@text` literally.
   * For string and string array fields. Values from env and config files, and serve/MCP/`tool()` calls, are taken as given.
   */
  fromFile?: boolean;
  /** Options (by field name) that can't be used together with this one. Only options the user provided are checked. */
  conflicts?: readonly TKey[] | TKey;
  /**
   * Values for other options (by field name) to use when this option is provided and not `false`.
   * Options given explicitly keep their value. @example `{ color: false }`
   */
  implies?: { readonly [K in TKey]?: unknown };
  /** Other options (by field name) that must be provided when this one is. */
  requires?: readonly TKey[] | TKey;
  /**
   * Required when every listed option has the given value: `{ format: 'file' }`. An array of such objects: required when any matches.
   * Compares the typed value (`{ port: 80 }` matches `--port 80`), including implied values; schema defaults don't count.
   */
  requiredIf?: { readonly [K in TKey]?: unknown } | readonly { readonly [K in TKey]?: unknown }[];
  /** Required unless one of these options is provided. */
  requiredUnless?: readonly TKey[] | TKey;
  /** Secret value (token, password): prompted without echo, and never shown in help defaults, env values, logs, traces or errors. */
  sensitive?: boolean;
  /**
   * Values shell completion offers for this option or positional (needs `padroneCompletion()`),
   * e.g. branch names read at completion time. Enum values are offered without it.
   * Items may carry a description, which zsh, fish and PowerShell show next to the value.
   * Return `{ values, directive }` to also say what the shell falls back to when none match (see `PadroneCompletionDirective`).
   */
  complete?: (ctx: PadroneCompleteContext) => PadroneCompletionResult | Promise<PadroneCompletionResult>;
  /**
   * What shell completion falls back to for the value when there are no candidates: `'file'` (the default without
   * enum values or `complete`), `'dir'`, `{ ext: ['json', 'yaml'] }` (files with these extensions), `'command'`
   * (program names), or nothing for `'url'` and `'none'`.
   */
  hint?: PadroneValueHint;
  /** The value placeholder in help and docs: `--out <PATH>` instead of `--out <string>`, `<PATH>` for a positional. */
  valueName?: string;
}

/** A shell completion candidate with an optional description. */
export type PadroneCompletionItem = { value: string; description?: string };

/** What kind of value an option or positional takes, for shell completion. */
export type PadroneValueHint = 'file' | 'dir' | 'url' | 'command' | 'none' | { ext: readonly string[] };

/**
 * What the shell completes when no candidate matches: file names, directories, files with the given extensions
 * (`ext:json,yaml`), program names, or nothing.
 */
export type PadroneCompletionDirective = 'files' | 'dirs' | 'commands' | 'nofiles' | `ext:${string}`;

/**
 * Candidates returned by a `complete` callback: values (plain or with a description), or `{ values, directive }`
 * to also set the fallback. Without a directive, the field's `hint` decides it, else there's no file fallback.
 */
export type PadroneCompletionResult =
  | readonly (string | PadroneCompletionItem)[]
  | { values: readonly (string | PadroneCompletionItem)[]; directive?: PadroneCompletionDirective };

/** Passed to a field's `complete` callback and to a command's `.configure({ complete })` hook. */
export type PadroneCompleteContext = {
  /** The part of the word typed so far. Candidates needn't be filtered by it; the shell does that. */
  prefix: string;
  /** The options typed before the word, parsed but not validated. */
  args: Record<string, unknown>;
  /** The command being completed, as a space-separated path (`''` for the program itself). */
  command: string;
  /** The field being completed: the option, or the positional at `position` (unset for a positional past the configured ones). */
  field?: string;
  /** For a positional word: its index among the command's positionals (0-based). */
  position?: number;
  /** For a positional word: the positional words typed before it. */
  positionals?: readonly string[];
  /** The runtime completion runs with (`runtime.env()`, `runtime.cwd()`, ...). */
  runtime: ResolvedPadroneRuntime;
  /** The context passed to `cli()`/`eval()`, with the command chain's `.context()` transforms applied. */
  context: unknown;
};

type PositionalArgs<TObj> =
  TObj extends Record<string, any>
    ? {
        [K in keyof TObj]-?: NonNullable<TObj[K]> extends Array<any> ? `...${K & string}` | (K & string) : K & string;
      }[keyof TObj]
    : string;

/**
 * Meta configuration for arguments, including positional arguments.
 * The `positional` array defines which arguments are positional and their order.
 * Use '...name' prefix to indicate variadic (rest) arguments, matching JS/TS rest syntax.
 *
 * @example
 * ```ts
 * .arguments(schema, {
 *   positional: ['source', '...files', 'dest'],  // '...files' is variadic
 * })
 * ```
 */
/**
 * Configuration for reading from stdin and mapping it to an argument field.
 * Specify the field name, or `{ field, trim }` — the read mode is inferred from the schema:
 * - `string` field → reads all stdin as text
 * - `string[]` field → reads stdin line-by-line
 */
export type StdinConfig<TObj = Record<string, any>> =
  | (keyof TObj & string)
  | {
      /** The field stdin is read into. */
      field: keyof TObj & string;
      /** Trim whitespace around the text (around each line for arrays). Number and boolean fields are always trimmed. */
      trim?: boolean;
    };

/**
 * Metadata for `.globalArgs()`: per-field config, auto-aliasing, and prompting for missing globals
 * in every command of the subtree. Global args are never positional.
 */
export type PadroneGlobalArgsMeta<TObj = Record<string, any>> = Pick<
  PadroneArgsSchemaMeta<TObj>,
  'fields' | 'autoAlias' | 'interactive' | 'optionalInteractive' | 'exactlyOne' | 'atLeastOne'
>;

/** A group of fields (by name), or several groups. */
export type PadroneFieldGroups<TObj = Record<string, any>> =
  | readonly (keyof TObj & string)[]
  | readonly (readonly (keyof TObj & string)[])[];

export interface PadroneArgsSchemaMeta<TObj = Record<string, any>, TKeys extends string = keyof TObj & string> {
  /**
   * Array of argument names that should be treated as positional arguments.
   * Order in array determines position. Use '...name' prefix for variadic args.
   * @example ['source', '...files', 'dest'] - 'files' captures multiple values
   */
  positional?: readonly PositionalArgs<TObj>[];
  /**
   * Per-argument metadata.
   */
  fields?: { [K in keyof TObj]?: PadroneFieldMeta<TKeys> };
  /**
   * Options of which exactly one must be provided, like oclif's `exactlyOne`: `exactlyOne: ['file', 'url']` requires
   * `--file` or `--url`, not both. Pass several groups as an array of arrays: `[['file', 'url'], ['json', 'yaml']]`.
   * Only values the user provided count (command line, stdin, env and config; schema defaults don't).
   */
  exactlyOne?: PadroneFieldGroups<TObj>;
  /** Options of which at least one must be provided: `atLeastOne: ['email', 'slack']`. Several groups as an array of arrays. */
  atLeastOne?: PadroneFieldGroups<TObj>;
  /**
   * Automatically generate kebab-case aliases for camelCase option names.
   * For example, `dryRun` automatically gets `--dry-run` as an alias.
   * Defaults to `true`. Set to `false` to disable.
   *
   * @default true
   * @example
   * ```ts
   * // Auto-aliases enabled (default): --dry-run → dryRun
   * .arguments(z.object({ dryRun: z.boolean() }))
   *
   * // Disable auto-aliases
   * .arguments(z.object({ dryRun: z.boolean() }), { autoAlias: false })
   * ```
   */
  autoAlias?: boolean;
  /**
   * Read from stdin and inject the data into the specified argument field.
   * Only reads when stdin is piped (not a TTY) and the field wasn't already provided via CLI flags.
   *
   * The read mode is inferred from the schema type of the target field:
   * - `string` field → reads all stdin as a single string
   * - `string[]` field → reads stdin line-by-line into an array
   *
   * A lone `-` as the field's value (`cat -`, `--data -`) reads stdin too, even from a terminal.
   * `{ field, trim: true }` trims the text; number and boolean fields are always trimmed (`echo 21 | my-cli double`).
   *
   * Precedence: CLI flags > stdin > env vars > config file > schema defaults.
   *
   * @example
   * ```ts
   * // Read all stdin as text into 'data' field
   * .arguments(z.object({ data: z.string() }), { stdin: 'data' })
   *
   * // Read stdin lines into 'lines' field (inferred from array schema)
   * .arguments(z.object({ lines: z.string().array() }), { stdin: 'lines' })
   *
   * // Without the trailing newline
   * .arguments(z.object({ token: z.string() }), { stdin: { field: 'token', trim: true } })
   * ```
   */
  stdin?: StdinConfig<TObj>;
  /**
   * Fields to interactively prompt for when their values are missing after CLI/env/config resolution.
   * - `true`: prompt for all required fields that are missing.
   * - `string[]`: prompt for these specific fields if missing.
   *
   * Prompting occurs in `cli()` and `eval()` when the runtime can prompt (`interactive` isn't `'disabled'` or `'unsupported'`, or `-i` is passed).
   * Setting this makes `parse()` and `cli()` return Promises.
   *
   * @example
   * ```ts
   * .arguments(schema, {
   *   interactive: true,                        // prompt all missing required fields
   *   interactive: ['name', 'template'],         // prompt only these fields
   * })
   * ```
   */
  interactive?: true | readonly (keyof TObj & string)[];
  /**
   * Optional fields offered after required interactive prompts.
   * Users are shown a multi-select to choose which of these fields to configure.
   * - `true`: offer all optional fields that are missing.
   * - `string[]`: offer these specific fields.
   *
   * @example
   * ```ts
   * .arguments(schema, {
   *   interactive: ['name'],
   *   optionalInteractive: ['typescript', 'eslint', 'prettier'],
   * })
   * ```
   */
  optionalInteractive?: true | readonly (keyof TObj & string)[];
}
