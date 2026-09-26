import { readStreamAsText } from '../util/stream.ts';
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

  const question: Record<string, unknown> = {
    type: config.type,
    name: config.name,
    message: config.message,
  };

  if (config.default !== undefined) {
    question.initial = config.default;
  }

  if (config.choices) {
    question.choices = config.choices.map((c) => ({
      name: String(c.value),
      message: c.label,
    }));
  }

  const response = (await Enquirer.prompt(question as any)) as Record<string, unknown>;
  return response[config.name];
}

export function createTerminalReplSession(config: ReplSessionConfig) {
  // History accumulates across per-call interfaces, giving us
  // up/down arrow navigation without a persistent stdin listener
  // that would conflict with Enquirer or other stdin consumers.
  let history: string[] = config.history ? [...config.history] : [];
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
        historySize: Math.max(history.length, 1000),
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
 * Returns 'disabled' in CI environments or non-TTY contexts, 'supported' otherwise.
 */
function detectInteractiveMode(): InteractiveMode {
  if (typeof process === 'undefined') return 'disabled';
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) return 'disabled';
  if (!process.stdout?.isTTY) return 'disabled';
  return 'supported';
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
      if (typeof process === 'undefined') return '';
      return readStreamAsText(process.stdin);
    },
    async *lines() {
      if (typeof process === 'undefined') return;
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
    get isTTY() {
      return process.stdout?.isTTY === true;
    },
  };
}

export function createDefaultRuntime(): ResolvedPadroneRuntime {
  return {
    output: (...args) => console.log(...args),
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
  };
}

/**
 * Returns the stdin abstraction: custom runtime stdin > default process.stdin.
 * Returns `undefined` when no custom stdin is provided and process.stdin is not piped.
 */
export function resolveStdin(partial?: PadroneRuntime): NonNullable<PadroneRuntime['stdin']> | undefined {
  if (partial?.stdin) return partial.stdin;
  const defaultStdin = createDefaultStdin();
  // Only use default stdin if it's actually piped (isTTY === false).
  // This avoids accidentally blocking on stdin in tests/CI.
  if (defaultStdin.isTTY) return undefined;
  return defaultStdin;
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
  };
}
