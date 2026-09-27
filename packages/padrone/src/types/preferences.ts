import type { PadroneRuntime } from '../core/runtime.ts';
import type { PadroneActionContext } from './command.ts';

/**
 * Options for `repl()` to customize the REPL session.
 */
/** A single spacing value: blank line (`true`), separator string, or an array of these for multiple lines. */
export type PadroneReplSpacing = boolean | string | (boolean | string)[];

export type PadroneReplPreferences<TScope extends string = string> = {
  /** The prompt string displayed before each input, or a function returning it. Defaults to `"<programName>> "`. */
  prompt?: string | (() => string);
  /**
   * A greeting message displayed when the REPL starts.
   * When not provided, defaults to `"Welcome to <name> v<version>"` (or just `"Welcome to <name>"` if no version).
   * Set to `false` to suppress the default greeting entirely.
   */
  greeting?: string | false;
  /**
   * A hint message displayed below the greeting in dimmed text.
   * When not provided, defaults to `'Type ".help" for more information, ".exit" to quit.'`.
   * Set to `false` to suppress the hint.
   */
  hint?: string | false;
  /** Initial history entries (most recent last). Arrow keys navigate history in the terminal. */
  history?: string[];
  /** Set to `false` to disable tab completion. Defaults to `true`. */
  completion?: boolean;
  /**
   * Add spacing/separators around each command's output.
   * A spacing value can be:
   * - `true` — blank line
   * - A string — separator line (single char like `'─'` repeats to terminal width, multi-char prints as-is)
   * - An array of the above — multiple lines in order (e.g. `[true, '─']` for blank line then separator)
   *
   * Shorthand applies to both before and after. Use `{ before?, after? }` for independent control.
   */
  spacing?: PadroneReplSpacing | { before?: PadroneReplSpacing; after?: PadroneReplSpacing };
  /** Prefix each line of command output/error with this string (e.g. `'│ '`, `'  '`, `'▎ '`). */
  outputPrefix?: string;
  /**
   * Start the REPL scoped to a command subtree. The scope path is a space-separated command path
   * (e.g. `'db'` or `'db migrate'`). Commands are resolved relative to the scoped command.
   * Users can change scope at runtime with `.scope <subcommand>` and `.scope ..`/`..`.
   */
  scope?: TScope;
  /** Override runtime functions for the session (input via `readLine`, `output`, `error`, …), like `eval()`'s `runtime`. */
  runtime?: Partial<PadroneRuntime>;
};

/**
 * Options that can be passed to `eval()` to control execution behavior.
 */
export type PadroneEvalPreferences = {
  /**
   * Controls interactive prompting for this execution.
   * Overrides the runtime's `interactive` setting, but is itself overridden by `--interactive` / `-i` flags.
   *
   * - `undefined`: inherit from runtime (default).
   * - `true`: force prompting for all configured interactive fields, even if values are already provided.
   * - `false`: suppress all interactive prompts.
   */
  interactive?: boolean;

  /**
   * Override the runtime for this execution.
   * Partial — only the provided fields replace the command's resolved runtime.
   * Useful for capturing output, injecting test doubles, or running in non-terminal contexts (e.g. AI tool calls).
   */
  runtime?: PadroneRuntime;

  /**
   * User-defined context object passed to command action handlers via `ctx.context`.
   * The context flows through the command tree and can be transformed by subcommands via `.context(transform)`.
   */
  context?: unknown;

  /**
   * Cancels the execution when aborted. Actions and interceptors see it through `ctx.signal`,
   * together with process signals (SIGINT, SIGTERM, SIGHUP) handled by the signal extension.
   */
  signal?: AbortSignal;

  /** @internal Which API entry point triggered this execution. */
  caller?: PadroneActionContext['caller'];
};

/**
 * Options that can be passed to `cli()` to control execution behavior.
 */
export type PadroneCliPreferences = PadroneEvalPreferences;
