import type { Terminal } from 'ghostty-web';
import { type PadroneRuntime, type PadroneSignal, REPL_SIGINT } from 'padrone';
import type { Completer, LineEditor } from './line-editor.ts';
import { createEditor, createPager, createPrompt, ERASE_PREVIOUS_LINE } from './prompts.ts';

export type BrowserRuntimeOptions = {
  term: Terminal;
  editor: LineEditor;
  argv: string[];
  env: Record<string, string>;
  /** Piped input (`echo hi | pizza chef chat`). Without it, stdin is the keyboard. */
  stdin?: string;
  /** Collects stdout when it's piped or redirected. Without it, stdout is the terminal. */
  stdout?: string[];
  onSignal: (callback: (signal: PadroneSignal) => void) => () => void;
  exit: (code: number) => never;
  setExitCode: (code: number) => void;
  /** Tab completion and history for lines read by the program (its REPL). */
  complete?: Completer;
  history: string[];
};

function inspect(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Everything a Padrone program needs from its environment, mapped onto the web terminal:
 * output streams, argv, env, prompts, stdin, signals (Ctrl+C), terminal size, editor, pager and `open`.
 */
export function createBrowserRuntime(options: BrowserRuntimeOptions): PadroneRuntime {
  const { term, editor, stdout } = options;
  const piped = options.stdin !== undefined;

  return {
    output: (...args) => {
      const text = `${args.map(inspect).join(' ')}\n`;
      if (stdout) stdout.push(text);
      else term.write(text);
    },
    error: (text) => term.write(`${text}\n`),
    argv: () => options.argv,
    env: () => options.env,
    format: 'auto',
    terminal: {
      get columns() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      isTTY: !stdout,
      // `error` always writes to the terminal, even when stdout is piped
      stderrIsTTY: true,
    },
    interactive: 'supported',
    prompt: createPrompt(term, editor),
    readLine: (prompt) => editor.readLine(prompt, { complete: options.complete, history: options.history }),
    stdin: piped
      ? {
          isTTY: false,
          text: async () => options.stdin!,
          async *lines() {
            yield* options.stdin!.replace(/\n$/, '').split('\n');
          },
        }
      : {
          isTTY: true,
          text: async () => '',
          // Typed lines until Ctrl+D (or Ctrl+C)
          async *lines() {
            while (true) {
              const line = await editor.readLine('\x1b[2m›\x1b[0m ');
              if (line === null || line === REPL_SIGINT) {
                if (line === null) term.write(ERASE_PREVIOUS_LINE);
                return;
              }
              yield line;
            }
          },
        },
    onSignal: options.onSignal,
    exit: options.exit,
    setExitCode: options.setExitCode,
    editor: createEditor(term, editor),
    page: createPager(term, editor),
    open: async (target) => {
      window.open(target, '_blank', 'noopener');
    },
  };
}

/**
 * Padrone's progress renderers draw on `process.stderr`. In the browser there is no process:
 * a minimal stand-in sends that output to the terminal.
 */
export function installProcessShim(term: Terminal) {
  const stream = {
    isTTY: true,
    get columns() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(chunk: unknown) {
      term.write(String(chunk));
      return true;
    },
  };
  const g = globalThis as unknown as { process?: Record<string, unknown> };
  const proc = (g.process ??= {});
  proc.env ??= {};
  proc.argv ??= [];
  proc.platform ??= 'browser';
  proc.stdout = stream;
  proc.stderr = stream;
  proc.stdin ??= { isTTY: true };
  proc.cwd ??= () => '/home/guest';
  proc.on ??= () => proc;
  proc.off ??= () => proc;
  proc.removeListener ??= () => proc;
}
