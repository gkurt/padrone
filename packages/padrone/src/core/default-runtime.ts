import { type PadronePageOptions, pageWithRuntime } from '../feature/pager.ts';
import { openInEditor, openWithSystem, type PadroneEditorOptions } from '../feature/system.ts';
import { safeJsonStringify } from '../util/json.ts';
import { readStreamAsText } from '../util/stream.ts';
import { isCI } from '../util/utils.ts';
import { isPlainObject } from './args.ts';
import { PromptCancelledError } from './errors.ts';
import type {
  InteractiveMode,
  InteractivePromptConfig,
  PadroneRuntime,
  PadroneSignal,
  ReplSessionConfig,
  ResolvedPadroneRuntime,
} from './runtime.ts';
import { REPL_SIGINT } from './runtime.ts';

/**
 * Default terminal prompt implementation powered by Enquirer.
 * Lazily imported to avoid loading Enquirer when not needed.
 */
async function defaultTerminalPrompt(config: InteractivePromptConfig): Promise<unknown> {
  const Enquirer = (await import('enquirer')).default;
  return runEnquirerPrompt((question) => Enquirer.prompt(question as any), config);
}

/**
 * Asks one question with Enquirer's `prompt`. Choices are named by their values' string forms (so is a select's default),
 * and Enquirer's cancellation (Ctrl+C / Esc reject with `''`) becomes a `PromptCancelledError`.
 */
export async function runEnquirerPrompt(
  prompt: (question: Record<string, unknown>) => Promise<unknown>,
  config: InteractivePromptConfig,
): Promise<unknown> {
  // Enquirer stores answers by dotted path, so `config.name` (`db.host`) isn't used as the key
  const question: Record<string, unknown> = { type: config.type, name: 'value', message: config.message };
  const initial = config.default;
  if (initial !== undefined) question.initial = config.choices ? (Array.isArray(initial) ? initial.map(String) : String(initial)) : initial;
  if (config.choices) question.choices = config.choices.map((c) => ({ name: String(c.value), message: c.label }));

  try {
    return ((await prompt(question)) as Record<string, unknown>).value;
  } catch (err) {
    if (err === '' || err === undefined) throw new PromptCancelledError();
    throw err;
  }
}

export function createTerminalReplSession(config: ReplSessionConfig) {
  // History accumulates across per-call interfaces, giving us
  // up/down arrow navigation without a persistent stdin listener
  // that would conflict with Enquirer or other stdin consumers.
  // Readline keeps the most recent entry first
  let history: string[] = config.history ? [...config.history].reverse() : [];
  let currentCompleter = config.completer;

  return {
    /** Update the tab completer (e.g. when REPL scope changes). Takes effect on the next question. */
    set completer(fn: ((line: string) => [string[], string]) | undefined) {
      currentCompleter = fn;
    },
    async question(prompt: string): Promise<string | typeof REPL_SIGINT | null> {
      const { createInterface } = await import('node:readline');
      const opts: Record<string, unknown> = {
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        history: [...history],
        historySize: config.historySize ?? 1000,
      };
      if (currentCompleter) {
        opts.completer = currentCompleter;
      }
      const rl = createInterface(opts as any);

      return new Promise((resolve) => {
        let resolved = false;
        const settle = (value: string | typeof REPL_SIGINT | null) => {
          if (resolved) return;
          resolved = true;
          rl.close();
          resolve(value);
        };

        rl.question(prompt, (answer) => {
          // Grab updated history (includes the new entry) before closing.
          if (Array.isArray((rl as any).history)) history = [...(rl as any).history];
          settle(answer);
        });
        // Ctrl+C: cancel current line, print newline, resolve SIGINT sentinel.
        rl.once('SIGINT', () => {
          process.stdout.write('\n');
          settle(REPL_SIGINT);
        });
        // EOF (Ctrl+D) fires close without the question callback.
        rl.once('close', () => {
          // Write newline so zsh doesn't show '%' (partial-line indicator).
          process.stdout.write('\n');
          settle(null);
        });
      });
    },
    close() {
      // No persistent interface to clean up.
    },
  };
}

/**
 * Auto-detect interactive mode when not explicitly set.
 * Returns 'disabled' in CI environments or when stdin or stdout isn't a terminal (prompts read stdin), 'supported' otherwise.
 */
function detectInteractiveMode(): InteractiveMode {
  if (typeof process === 'undefined') return 'disabled';
  if (isCI(process.env)) return 'disabled';
  if (!process.stdout?.isTTY || !process.stdin?.isTTY) return 'disabled';
  return 'supported';
}

/** Stdin was read to the end (e.g. by an earlier `eval()` in the process): reading it again gives nothing, not an error. */
function stdinConsumed(): boolean {
  return process.stdin.readableEnded || process.stdin.destroyed;
}

/**
 * Creates a default stdin reader from `process.stdin`.
 * Only created when a command actually declares a `stdin` meta field.
 */
function createDefaultStdin(): NonNullable<PadroneRuntime['stdin']> {
  return {
    get isTTY() {
      // process.stdin.isTTY is `true` when interactive terminal, `undefined` when piped/redirected.
      // Node.js never sets it to `false` — it's either `true` or absent.
      if (typeof process === 'undefined') return true;
      return process.stdin?.isTTY === true;
    },
    async text() {
      if (typeof process === 'undefined' || stdinConsumed()) return '';
      return readStreamAsText(process.stdin);
    },
    async *lines() {
      if (typeof process === 'undefined' || stdinConsumed()) return;
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin });
      try {
        for await (const line of rl) {
          yield line;
        }
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Default signal listener that wires to `process.on(signal)`.
 * Returns an unsubscribe function that removes all listeners.
 */
function defaultOnSignal(callback: (signal: PadroneSignal) => void): () => void {
  if (typeof process === 'undefined') return () => {};
  const signals: PadroneSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map<PadroneSignal, () => void>();
  for (const sig of signals) {
    const handler = () => callback(sig);
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    for (const [sig, handler] of handlers) {
      process.removeListener(sig, handler);
    }
  };
}

/**
 * Creates the default Node.js/Bun runtime.
 */
function defaultExit(code: number): never {
  if (typeof process !== 'undefined') process.exit(code);
  throw new Error(`Exit with code ${code}`);
}

function defaultSetExitCode(code: number): void {
  if (typeof process !== 'undefined') process.exitCode = code;
}

function getTerminalInfo(): PadroneRuntime['terminal'] {
  if (typeof process === 'undefined') return undefined;
  return {
    get columns() {
      return process.stdout?.columns;
    },
    get rows() {
      return process.stdout?.rows;
    },
    get isTTY() {
      return process.stdout?.isTTY === true;
    },
    get stderrIsTTY() {
      return process.stderr?.isTTY === true;
    },
  };
}

/**
 * Prints values like `console.log`, except that plain objects and arrays print as JSON when stdout isn't a terminal,
 * so piping a command's result into `jq` or a file gets data rather than an inspected view.
 */
function defaultOutput(...args: unknown[]): void {
  const piped = typeof process !== 'undefined' && process.stdout?.isTTY !== true;
  console.log(...(piped ? args.map((arg) => (Array.isArray(arg) || isPlainObject(arg) ? (safeJsonStringify(arg, 2) ?? arg) : arg)) : args));
}

export function createDefaultRuntime(): ResolvedPadroneRuntime {
  return {
    output: defaultOutput,
    error: (text) => console.error(text),
    argv: () => (typeof process !== 'undefined' ? process.argv.slice(2) : []),
    env: () => (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {}),
    format: 'auto',
    prompt: defaultTerminalPrompt,
    interactive: detectInteractiveMode(),
    onSignal: defaultOnSignal,
    terminal: getTerminalInfo(),
    exit: defaultExit,
    setExitCode: defaultSetExitCode,
    editor: defaultEditor,
    open: openWithSystem,
    page: defaultPage,
  };
}

/** Uses the environment of the runtime it's called on (`ctx.runtime.editor(...)`). */
function defaultEditor(this: Partial<ResolvedPadroneRuntime> | undefined, text: string, options?: PadroneEditorOptions): Promise<string> {
  const env = typeof this?.env === 'function' ? this.env() : (process.env as Record<string, string | undefined>);
  return openInEditor(text, env, options);
}

/** Pages with the runtime it's called on (`ctx.runtime.page(...)`), so its `output`, `env` and `terminal` apply. */
function defaultPage(this: Partial<ResolvedPadroneRuntime> | undefined, text: string, options?: PadronePageOptions): Promise<void> {
  const runtime =
    typeof this?.output === 'function' && typeof this.env === 'function' ? (this as ResolvedPadroneRuntime) : createDefaultRuntime();
  return pageWithRuntime(runtime, text, options);
}

/**
 * Returns the stdin abstraction: custom runtime stdin > default process.stdin.
 * Returns `undefined` when it's a terminal (`isTTY`), so reading it never waits for typing.
 */
export function resolveStdin(partial?: PadroneRuntime): NonNullable<PadroneRuntime['stdin']> | undefined {
  const stdin = partial?.stdin ?? createDefaultStdin();
  return stdin.isTTY ? undefined : stdin;
}

/**
 * Like `resolveStdin`, but always returns a stdin source even when it's a TTY.
 * Used for async streams which support interactive (non-piped) input.
 */
export function resolveStdinAlways(partial?: PadroneRuntime): NonNullable<PadroneRuntime['stdin']> {
  if (partial?.stdin) return partial.stdin;
  return createDefaultStdin();
}

/**
 * Merges a partial runtime with the default runtime.
 */
export function resolveRuntime(partial?: PadroneRuntime): ResolvedPadroneRuntime {
  const defaults = createDefaultRuntime();
  if (!partial) return defaults;
  return {
    output: partial.output ?? defaults.output,
    error: partial.error ?? defaults.error,
    argv: partial.argv ?? defaults.argv,
    env: partial.env ?? defaults.env,
    format: partial.format ?? defaults.format,
    interactive: partial.interactive ?? defaults.interactive,
    prompt: partial.prompt ?? defaults.prompt,
    readLine: partial.readLine ?? defaults.readLine,
    stdin: partial.stdin,
    theme: partial.theme,
    onSignal: partial.onSignal ?? defaults.onSignal,
    terminal: partial.terminal ?? defaults.terminal,
    exit: partial.exit ?? defaults.exit,
    setExitCode: partial.setExitCode ?? defaults.setExitCode,
    editor: partial.editor ?? defaults.editor,
    open: partial.open ?? defaults.open,
    page: partial.page ?? defaults.page,
  };
}
