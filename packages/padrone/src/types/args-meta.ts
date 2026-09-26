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

export interface PadroneFieldMeta {
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
  /** Options (by field name) that can't be used together with this one. Only options the user provided are checked. */
  conflicts?: readonly string[] | string;
  /**
   * Values for other options (by field name) to use when this option is provided and not `false`.
   * Options given explicitly keep their value. @example `{ color: false }`
   */
  implies?: Record<string, unknown>;
  /**
   * Values shell completion offers for this option or positional (needs `padroneCompletion()`),
   * e.g. branch names read at completion time. Enum values are offered without it.
   */
  complete?: (ctx: PadroneCompleteContext) => readonly string[] | Promise<readonly string[]>;
}

/** Passed to a field's `complete` callback. */
export type PadroneCompleteContext = {
  /** The part of the word typed so far. Candidates needn't be filtered by it; the shell does that. */
  prefix: string;
  /** The options typed before the word, parsed but not validated. */
  args: Record<string, unknown>;
  /** The command being completed, as a space-separated path (`''` for the program itself). */
  command: string;
};

type PositionalArgs<TObj> =
  TObj extends Record<string, any>
    ? {
        [K in keyof TObj]: NonNullable<TObj[K]> extends Array<any> ? `...${K & string}` | (K & string) : K & string;
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
 * Simply specify the field name — the read mode is inferred from the schema:
 * - `string` field → reads all stdin as text
 * - `string[]` field → reads stdin line-by-line
 */
export type StdinConfig<TObj = Record<string, any>> = keyof TObj & string;

/**
 * Metadata for `.globalArgs()`: per-field config, auto-aliasing, and prompting for missing globals
 * in every command of the subtree. Global args are never positional.
 */
export type PadroneGlobalArgsMeta<TObj = Record<string, any>> = Pick<
  PadroneArgsSchemaMeta<TObj>,
  'fields' | 'autoAlias' | 'interactive' | 'optionalInteractive'
>;

export interface PadroneArgsSchemaMeta<TObj = Record<string, any>> {
  /**
   * Array of argument names that should be treated as positional arguments.
   * Order in array determines position. Use '...name' prefix for variadic args.
   * @example ['source', '...files', 'dest'] - 'files' captures multiple values
   */
  positional?: readonly PositionalArgs<TObj>[];
  /**
   * Per-argument metadata.
   */
  fields?: { [K in keyof TObj]?: PadroneFieldMeta };
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
   * Precedence: CLI flags > stdin > env vars > config file > schema defaults.
   *
   * @example
   * ```ts
   * // Read all stdin as text into 'data' field
   * .arguments(z.object({ data: z.string() }), { stdin: 'data' })
   *
   * // Read stdin lines into 'lines' field (inferred from array schema)
   * .arguments(z.object({ lines: z.string().array() }), { stdin: 'lines' })
   * ```
   */
  stdin?: StdinConfig<TObj>;
  /**
   * Fields to interactively prompt for when their values are missing after CLI/env/config resolution.
   * - `true`: prompt for all required fields that are missing.
   * - `string[]`: prompt for these specific fields if missing.
   *
   * Interactive prompting only occurs in `cli()` when the runtime has `interactive: true`.
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
