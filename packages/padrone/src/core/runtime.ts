import type { ColorConfig, ColorTheme } from '../output/colorizer.ts';
import type { HelpFormat } from '../output/formatter.ts';

/** Process signals that Padrone can handle for graceful shutdown. */
export type PadroneSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** Value accepted by `PadroneProgress.update()`. */
export type PadroneProgressUpdate = string | number | { message?: string; progress?: number; indeterminate?: boolean; time?: boolean };

/**
 * A progress indicator instance (spinner, progress bar, etc).
 * Created by the runtime's `progress` factory and used to show loading state during command execution.
 */
export type PadroneProgress = {
  /**
   * Update the indicator.
   * - `string` — update the displayed message.
   * - `number` — set progress ratio (0–1). Values outside this range are clamped.
   * - `{ message?, progress?, indeterminate? }` — update message, progress, or both.
   *
   * Set `indeterminate: true` to force the bar into indeterminate mode (shows animation, no percentage).
   * This makes the bar visible even in `show: 'auto'` mode without providing a number.
   * Omitting `progress` (or passing a string) leaves the bar in its current state.
   * Setting `progress` when bar mode is not enabled is a no-op for the bar portion.
   *
   * Set `time: true` to start the elapsed timer on demand (useful when `time` was not set in options).
   * Set `time: false` to hide the elapsed timer.
   */
  update: (value: PadroneProgressUpdate) => void;
  /** Mark as succeeded and stop. Pass `null` to stop without rendering a final message. */
  succeed: (message?: string | null, options?: { indicator?: string }) => void;
  /** Mark as failed and stop. Pass `null` to stop without rendering a final message. */
  fail: (message?: string | null, options?: { indicator?: string }) => void;
  /** Control ETA (estimated time remaining) display at runtime. */
  eta: {
    /** Enable ETA tracking. Starts collecting samples from subsequent `update()` calls. */
    start: () => void;
    /** Disable ETA display. */
    stop: () => void;
    /** Clear collected samples and restart estimation. Useful between operation phases. */
    reset: () => void;
  };
  /** Stop without success/fail status. */
  stop: () => void;
  /** Temporarily hide the indicator so other output can be written cleanly. */
  pause: () => void;
  /** Redraw the indicator after a `pause()`. */
  resume: () => void;
};

/** Controls when a progress element (spinner or bar) is visible. */
export type PadroneProgressShow = 'auto' | 'always' | 'never';

/** Built-in spinner presets. */
export type PadroneSpinnerPreset = 'dots' | 'line' | 'arc' | 'bounce';

/**
 * Spinner configuration for progress indicators.
 * - A preset name (e.g., `'dots'`) to use built-in frames.
 * - `true` — default spinner with `show: 'always'` (visible even alongside a bar).
 * - An object with custom `frames`, `interval`, and/or `show`.
 * - `false` to disable the spinner (`show: 'never'`).
 *
 * Default `show` is `'auto'`: visible when the bar is not shown.
 */
export type PadroneSpinnerConfig = PadroneSpinnerPreset | boolean | { frames?: string[]; interval?: number; show?: PadroneProgressShow };

/**
 * Options passed to the runtime's `progress` factory.
 */
/** Common fill/empty character pairs for progress bars. */
export type PadroneBarChar = '█' | '░' | '▓' | '▒' | '─' | '━' | '■' | '□' | '#' | '-' | '=' | '·' | '▰' | '▱' | (string & {});

/**
 * Built-in indeterminate bar animation presets.
 * - `'bounce'` — a filled segment slides back and forth (default).
 * - `'slide'` — a filled segment slides left-to-right and wraps around.
 * - `'pulse'` — the entire bar fades in and out using gradient characters (`░▒▓█▓▒░`).
 */
export type PadroneBarAnimation = 'bounce' | 'slide' | 'pulse';

/**
 * Progress bar configuration.
 */
export type PadroneBarConfig = {
  /** Total width of the bar in characters. Defaults to `20`. */
  width?: number;
  /** Character used for the filled portion of the bar. Defaults to `'█'`. */
  filled?: PadroneBarChar;
  /** Character used for the empty portion of the bar. Defaults to `'░'`. */
  empty?: PadroneBarChar;
  /** Indeterminate animation style. Defaults to `'bounce'`. */
  animation?: PadroneBarAnimation;
  /**
   * When the bar is visible. Defaults to `'always'` when bar is enabled, `'auto'` when bar is not explicitly configured.
   * - `'always'` — bar is always shown (indeterminate until a number is provided).
   * - `'auto'` — bar is shown only after `update()` is called with a number.
   * - `'never'` — bar is never shown.
   */
  show?: PadroneProgressShow;
};

export type PadroneProgressOptions = {
  spinner?: PadroneSpinnerConfig;
  /** Enable a progress bar. `true` for defaults (`show: 'always'`), or a `PadroneBarConfig` object. `false` to disable entirely. When omitted, bar defaults to `show: 'auto'` (appears when a number is provided). */
  bar?: boolean | PadroneBarConfig;
  /** Show elapsed time since the indicator started. Defaults to `false`. */
  time?: boolean;
  /** Show estimated time remaining based on progress rate. Requires numeric `update()` calls. Defaults to `false`. */
  eta?: boolean;
  /** Character/string shown before the success message. Defaults to `'✔'`. */
  successIndicator?: string;
  /** Character/string shown before the error message. Defaults to `'✖'`. */
  errorIndicator?: string;
};

/**
 * Controls interactive prompting capability and default behavior at the runtime level.
 * - `'supported'` — capable; caller decides.
 * - `'unsupported'` — hard veto; nothing can override.
 * - `'forced'` — capable and forces prompts by default.
 * - `'disabled'` — capable but suppresses prompts by default.
 */
export type InteractiveMode = 'supported' | 'unsupported' | 'forced' | 'disabled';

/**
 * Configuration passed to the runtime's `prompt` function for interactive field prompting.
 * The prompt type and choices are auto-detected from the field's JSON schema.
 */
export type InteractivePromptConfig = {
  /** The field name being prompted. */
  name: string;
  /** Human-readable message/label for the prompt, derived from the field's description or name. */
  message: string;
  /** The prompt type, auto-detected from the JSON schema. */
  type: 'input' | 'confirm' | 'select' | 'multiselect' | 'password';
  /** Available choices for select/multiselect prompts. */
  choices?: { label: string; value: unknown }[];
  /** Default value from the schema. */
  default?: unknown;
};

/**
 * Defines the execution context for a Padrone program.
 * Abstracts all environment-dependent I/O so the CLI framework
 * can run outside of a terminal (e.g., web UIs, chat interfaces, testing).
 *
 * All fields are optional — unspecified fields fall back to the Node.js/Bun defaults.
 */
export type PadroneRuntime = {
  /** Write normal output (replaces console.log). Receives the raw value — runtime handles formatting. */
  output?: (...args: unknown[]) => void;
  /** Write error output (replaces console.error). */
  error?: (text: string) => void;
  /** Return the raw CLI arguments (replaces process.argv.slice(2)). */
  argv?: () => string[];
  /** Return environment variables (replaces process.env). */
  env?: () => Record<string, string | undefined>;
  /** Default help output format. */
  format?: HelpFormat | 'auto';
  /** Color theme for ANSI/console help output. A theme name or partial color config. */
  theme?: ColorTheme | ColorConfig;
  /**
   * Standard input abstraction. Provides methods to read piped data from stdin.
   * When not provided, defaults to reading from `process.stdin`.
   *
   * Used by commands that declare a `stdin` field in their arguments meta.
   * The framework reads stdin automatically during the validate phase and
   * injects the data into the specified argument field.
   */
  stdin?: {
    /** Whether stdin is a TTY (interactive terminal) vs a pipe/file. */
    isTTY?: boolean;
    /** Read all of stdin as a string. */
    text: () => Promise<string>;
    /** Async iterable of lines for streaming. */
    lines: () => AsyncIterable<string>;
  };
  /**
   * Controls interactive prompting capability and default behavior.
   * - `'supported'` — runtime can handle prompts; caller (flag/pref) decides whether to prompt. This is the default when `prompt` is provided.
   * - `'unsupported'` — runtime cannot handle prompts; hard veto that nothing can override.
   * - `'forced'` — runtime supports prompts and forces them by default (prompts even for provided values).
   * - `'disabled'` — runtime supports prompts but suppresses them by default.
   *
   * `'unsupported'` is the only immutable state. For the others, the `--interactive`/`-i` flag
   * and `cli()` preferences can override the default behavior.
   */
  interactive?: InteractiveMode;
  /**
   * Prompt the user for input. Called during `cli()` for fields marked as interactive.
   * When `interactive` is `true` and this is not provided, defaults to an Enquirer-based terminal prompt.
   */
  prompt?: (config: InteractivePromptConfig) => Promise<unknown>;
  /**
   * Read a line of input from the user. Used by `repl()` for custom runtimes
   * (web UIs, chat interfaces, testing).
   * Returns the input string, `null` on EOF (e.g. Ctrl+D, closed connection),
   * or `REPL_SIGINT` when the user presses Ctrl+C.
   *
   * When not provided, `repl()` uses a built-in Node.js readline session
   * with command history (up/down arrows) and tab completion.
   */
  readLine?: (prompt: string) => Promise<string | typeof REPL_SIGINT | null>;

  /**
   * Register a callback for process signals. Returns an unsubscribe function.
   * The default runtime wires this to `process.on('SIGINT' | 'SIGTERM' | 'SIGHUP')`.
   * Non-Node runtimes (web UIs, tests) can map their own cancellation semantics.
   *
   * When not provided, signal handling is disabled for this runtime.
   */
  onSignal?: (callback: (signal: PadroneSignal) => void) => () => void;

  /**
   * Terminal/output capabilities. Used for ANSI detection, text wrapping, and TTY checks.
   * The default runtime auto-detects from `process.stdout`. Non-terminal runtimes
   * (web UIs, tests) should provide explicit values.
   */
  terminal?: {
    /** Number of columns in the terminal. Used for text wrapping. */
    columns?: number;
    /** Number of rows in the terminal. Used to decide whether long help goes through a pager. */
    rows?: number;
    /** Whether stdout is a TTY. Affects ANSI color output and interactive features. */
    isTTY?: boolean;
  };

  /**
   * Force-exit the process. The default runtime wires this to `process.exit()`.
   * Non-Node runtimes can throw an error or no-op.
   */
  exit?: (code: number) => never;

  /**
   * Set the exit code the process ends with, without exiting, so output streams still flush.
   * `cli()` calls it when a run ends with an error (the error's `exitCode`, or 1) or a signal (e.g. 130 for SIGINT).
   * The default runtime sets `process.exitCode`; custom runtimes can capture it or no-op.
   */
  setExitCode?: (code: number) => void;
};

/**
 * Internal resolved runtime where all fields are guaranteed to be present.
 * The `prompt`, `interactive`, and `readLine` fields remain optional since not all runtimes provide them.
 */
export type ResolvedPadroneRuntime = Required<
  Omit<PadroneRuntime, 'prompt' | 'interactive' | 'readLine' | 'stdin' | 'theme' | 'onSignal' | 'terminal' | 'exit' | 'setExitCode'>
> &
  Pick<PadroneRuntime, 'prompt' | 'interactive' | 'readLine' | 'stdin' | 'theme' | 'onSignal' | 'terminal' | 'exit' | 'setExitCode'>;

/**
 * Sentinel value returned by the terminal REPL session when Ctrl+C is pressed.
 * Distinguished from empty string (user pressed enter) and null (EOF/Ctrl+D).
 */
export const REPL_SIGINT = Symbol('REPL_SIGINT');

/**
 * Internal session config for the REPL's persistent readline interface.
 */
export type ReplSessionConfig = {
  completer?: (line: string) => [string[], string];
  history?: string[];
};
