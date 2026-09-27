import type { Terminal } from 'ghostty-web';
import { type PadroneRuntime, type PadroneSignal, REPL_SIGINT } from 'padrone';
import type { Completion, LineEditor } from './line-editor.ts';
import { PromptCancelledError } from './prompts.ts';
import { createBrowserRuntime } from './runtime.ts';
import type { Vfs } from './vfs.ts';

/** A program the shell can run, e.g. a Padrone program bound to its context. */
export type ShellProgram = {
  description: string;
  run: (runtime: PadroneRuntime) => Promise<void>;
  /** Completion candidates for the word being typed; `words` come after the program name, the last one is the current word. */
  complete: (words: string[]) => Promise<string[]>;
};

type Token = { word: string } | { op: '|' | '>' | '>>' | '&&' | ';' };
type Stage = { argv: string[]; assigns: Record<string, string> };
type Pipeline = { stages: Stage[]; redirect?: { file: string; append: boolean } };

type BuiltinIO = { args: string[]; stdin?: string; out: (text: string) => void; err: (text: string) => void };
type Builtin = { description: string; run: (io: BuiltinIO) => number | undefined };

class ExitSignal extends Error {}

/** The REPL's own dot-commands, completed in `pizza repl`. */
const REPL_COMMANDS = ['.help', '.exit', '.quit', '.clear', '.history', '.scope'];

const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function tokenize(input: string, lookup: (name: string) => string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let started = false;
  let i = 0;
  const flush = () => {
    if (started) tokens.push({ word });
    word = '';
    started = false;
  };
  const variable = () => {
    const match = /^\$(?:\{(\w+)\}|(\w+|\?))/.exec(input.slice(i));
    if (!match) {
      i++;
      return '$';
    }
    i += match[0].length;
    return lookup(match[1] ?? match[2]!);
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      flush();
      i++;
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated quote');
      word += input.slice(i + 1, end);
      started = true;
      i = end + 1;
    } else if (ch === '"') {
      started = true;
      i++;
      while (input[i] !== '"') {
        if (i >= input.length) throw new Error('unterminated quote');
        if (input[i] === '\\' && '"\\$'.includes(input[i + 1] ?? '')) {
          word += input[i + 1];
          i += 2;
        } else if (input[i] === '$') word += variable();
        else word += input[i++];
      }
      i++;
    } else if (ch === '\\') {
      word += input[i + 1] ?? '';
      started = true;
      i += 2;
    } else if (ch === '$') {
      const value = variable();
      word += value;
      started ||= value !== '';
    } else if (ch === '#' && !started) {
      break;
    } else {
      const op = (['&&', '>>', '|', '>', ';'] as const).find((o) => input.startsWith(o, i));
      if (op) {
        flush();
        tokens.push({ op });
        i += op.length;
      } else {
        word += ch;
        started = true;
        i++;
      }
    }
  }
  flush();
  return tokens;
}

function parse(tokens: Token[]): { pipeline: Pipeline; next: '&&' | ';' }[] {
  const list: { pipeline: Pipeline; next: '&&' | ';' }[] = [];
  let pipeline: Pipeline = { stages: [] };
  let stage: Stage = { argv: [], assigns: {} };
  const endStage = () => {
    if (stage.argv.length === 0 && Object.keys(stage.assigns).length === 0) throw new Error('syntax error: empty command');
    pipeline.stages.push(stage);
    stage = { argv: [], assigns: {} };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if ('word' in token) {
      const assign = stage.argv.length === 0 && /^([A-Za-z_]\w*)=(.*)$/s.exec(token.word);
      if (assign) stage.assigns[assign[1]!] = assign[2]!;
      else stage.argv.push(token.word);
    } else if (token.op === '|') {
      endStage();
    } else if (token.op === '>' || token.op === '>>') {
      const file = tokens[++i];
      if (!file || !('word' in file)) throw new Error(`syntax error near "${token.op}"`);
      pipeline.redirect = { file: file.word, append: token.op === '>>' };
    } else {
      endStage();
      list.push({ pipeline, next: token.op });
      pipeline = { stages: [] };
    }
  }
  if (stage.argv.length > 0 || Object.keys(stage.assigns).length > 0 || pipeline.stages.length > 0) {
    endStage();
    list.push({ pipeline, next: ';' });
  }
  return list;
}

/** Splits text into lines, dropping the empty string after a final newline. */
const lines = (text: string) => text.replace(/\n$/, '').split('\n');

/**
 * A small POSIX-ish shell for the web terminal: quoting, `$VAR`, `VAR=x cmd`, pipes, `>`/`>>` redirects,
 * `&&` and `;`, a few builtins, history and tab completion. Programs get a Padrone runtime wired to the terminal.
 */
export function createShell(options: { term: Terminal; editor: LineEditor; vfs: Vfs; programs: Record<string, ShellProgram> }) {
  const { term, editor, vfs, programs } = options;
  const env: Record<string, string> = { HOME: '/home/guest', USER: 'guest', SHELL: 'padrone-sh', TERM: 'xterm-256color' };
  const history: string[] = [];
  const replHistory: string[] = [];
  const signalHandlers = new Set<(signal: PadroneSignal) => void>();
  let status = 0;
  let atPrompt = false;
  let abandon: ((code: number) => void) | undefined;

  const builtins: Record<string, Builtin> = {
    help: {
      description: 'Show this help',
      run: ({ out }) => {
        out(`${bold('Programs')}\n`);
        for (const [name, program] of Object.entries(programs)) out(`  ${name.padEnd(10)} ${program.description}\n`);
        out(`\n${bold('Shell builtins')}\n`);
        for (const [name, builtin] of Object.entries(builtins)) out(`  ${name.padEnd(10)} ${builtin.description}\n`);
        out(`\n${bold('Shell features')}\n`);
        out(`  Tab completion, ↑/↓ history, Ctrl+C to cancel, Ctrl+L to clear\n`);
        out(`  Pipes and redirects: pizza menu --json | head -n 5, echo '{}' > pizza.config.json\n`);
        out(`  Variables: export PIZZA_SIZE=large, PIZZA_STORE=harbor pizza order funghi -n, echo $?\n`);
        return 0;
      },
    },
    clear: {
      description: 'Clear the screen',
      run: () => {
        term.clear();
        term.write('\x1b[H\x1b[2J');
        return 0;
      },
    },
    echo: { description: 'Print arguments', run: ({ args, out }) => void out(`${args.join(' ')}\n`) },
    ls: { description: 'List files', run: ({ out }) => void out(`${vfs.list().join('  ')}\n`) },
    cat: {
      description: 'Print files (or stdin)',
      run: ({ args, stdin, out, err }) => {
        if (args.length === 0) {
          out(stdin ?? '');
          return 0;
        }
        for (const file of args) {
          const content = vfs.read(file);
          if (content === undefined) {
            err(`cat: ${file}: No such file`);
            return 1;
          }
          out(content.endsWith('\n') ? content : `${content}\n`);
        }
        return 0;
      },
    },
    grep: {
      description: 'Filter lines: grep [-i] [-v] <pattern> [file]',
      run: ({ args, stdin, out, err }) => {
        const flags = args.filter((a) => /^-[iv]+$/.test(a)).join('');
        const [pattern, file] = args.filter((a) => !/^-[iv]+$/.test(a));
        if (pattern === undefined) {
          err('usage: grep [-i] [-v] <pattern> [file]');
          return 2;
        }
        const input = file ? vfs.read(file) : stdin;
        const regex = new RegExp(pattern, flags.includes('i') ? 'i' : '');
        const matched = lines(input ?? '').filter((line) => regex.test(line) !== flags.includes('v'));
        if (matched.length > 0) out(`${matched.join('\n')}\n`);
        return matched.length > 0 ? 0 : 1;
      },
    },
    head: {
      description: 'First lines of stdin: head [-n N]',
      run: ({ args, stdin, out }) => {
        const count = Number(args[args.indexOf('-n') + 1] ?? 10) || 10;
        out(
          `${lines(stdin ?? '')
            .slice(0, count)
            .join('\n')}\n`,
        );
        return 0;
      },
    },
    export: {
      description: 'Set environment variables: export NAME=value',
      run: ({ args, out }) => {
        if (args.length === 0) return builtins.env!.run({ args, out, err: out });
        for (const arg of args) {
          const [name, ...value] = arg.split('=');
          if (name) env[name] = value.join('=');
        }
        return 0;
      },
    },
    unset: {
      description: 'Remove environment variables',
      run: ({ args }) => {
        for (const name of args) delete env[name];
        return 0;
      },
    },
    env: {
      description: 'Print environment variables',
      run: ({ out }) => {
        out(
          `${Object.entries(env)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')}\n`,
        );
        return 0;
      },
    },
    history: {
      description: 'Show command history',
      run: ({ out }) => {
        out(`${history.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join('\n')}\n`);
        return 0;
      },
    },
  };

  // Ctrl+C while a command runs: deliver SIGINT like a terminal would
  editor.onIdleKey = (key) => {
    if (key !== '\x03' || signalHandlers.size === 0) return;
    term.write('^C');
    for (const handler of [...signalHandlers]) {
      try {
        handler('SIGINT');
      } catch (error) {
        if (!(error instanceof ExitSignal)) throw error;
      }
    }
  };

  async function runProgram(program: ShellProgram, stage: Stage, stdin: string | undefined, stdout: string[] | undefined) {
    let code = 0;
    const abandoned = new Promise<number>((resolve) => {
      abandon = resolve;
    });
    const runtime = createBrowserRuntime({
      term,
      editor,
      argv: stage.argv.slice(1),
      env: { ...env, ...stage.assigns },
      stdin,
      stdout,
      onSignal: (callback) => {
        signalHandlers.add(callback);
        return () => signalHandlers.delete(callback);
      },
      // A second Ctrl+C force-exits a command that ignores cancellation: stop waiting for it
      exit: (exitCode) => {
        abandon?.(exitCode);
        throw new ExitSignal(`exit ${exitCode}`);
      },
      setExitCode: (exitCode) => {
        code = exitCode;
      },
      complete: (line) =>
        /^\.\w*$/.test(line) ? { candidates: REPL_COMMANDS.filter((c) => c.startsWith(line)), from: 0 } : completeWords(program, line),
      history: replHistory,
    });
    const finished = program.run(runtime).then(
      () => code,
      (error: unknown) => {
        if (!(error instanceof PromptCancelledError)) term.write(`${red(error instanceof Error ? error.message : String(error))}\n`);
        return 1;
      },
    );
    try {
      return await Promise.race([finished, abandoned]);
    } finally {
      abandon = undefined;
      signalHandlers.clear();
    }
  }

  async function runStage(stage: Stage, stdin: string | undefined, stdout: string[] | undefined): Promise<number> {
    const [name] = stage.argv;
    if (!name) {
      Object.assign(env, stage.assigns);
      return 0;
    }
    const out = (text: string) => (stdout ? stdout.push(text) : term.write(text));
    const err = (text: string) => term.write(`${red(text)}\n`);
    const builtin = builtins[name];
    if (builtin) return builtin.run({ args: stage.argv.slice(1), stdin, out, err }) ?? 0;
    const program = programs[name];
    if (program) return runProgram(program, stage, stdin, stdout);
    err(`padrone-sh: command not found: ${name}. Type "help" to see what's available.`);
    return 127;
  }

  async function runPipeline({ stages, redirect }: Pipeline): Promise<number> {
    let input: string | undefined;
    let code = 0;
    for (const [i, stage] of stages.entries()) {
      const captured = i < stages.length - 1 || redirect ? ([] as string[]) : undefined;
      code = await runStage(stage, input, captured);
      input = captured?.join('');
    }
    if (redirect) vfs.write(redirect.file, input ?? '', redirect.append);
    return code;
  }

  async function execute(line: string) {
    let list: ReturnType<typeof parse>;
    try {
      list = parse(tokenize(line, (name) => (name === '?' ? String(status) : (env[name] ?? ''))));
    } catch (error) {
      term.write(`${red(`padrone-sh: ${(error as Error).message}`)}\n`);
      status = 2;
      return;
    }
    for (const { pipeline, next } of list) {
      status = await runPipeline(pipeline);
      if (next === '&&' && status !== 0) break;
    }
  }

  async function completeWords(program: ShellProgram, text: string): Promise<Completion> {
    const words = text.split(/\s+/);
    const current = words.at(-1) ?? '';
    return { candidates: await program.complete(words.filter((w, i) => w || i === words.length - 1)), from: text.length - current.length };
  }

  async function complete(line: string): Promise<Completion> {
    const separator = [...line.matchAll(/&&|[|;]/g)].at(-1);
    const words = line
      .slice(separator ? separator.index + separator[0].length : 0)
      .trimStart()
      .split(/\s+/);
    const current = words.at(-1) ?? '';
    const from = line.length - current.length;
    if (['>', '>>'].includes(words.at(-2) ?? '')) return { candidates: vfs.list().filter((f) => f.startsWith(current)), from };
    const [name, ...rest] = words.filter((w, i) => i === words.length - 1 || !/^[A-Za-z_]\w*=/.test(w));
    if (rest.length === 0) {
      return { candidates: [...Object.keys(programs), ...Object.keys(builtins)].filter((c) => c.startsWith(current)), from };
    }
    const program = programs[name!];
    if (program) return { candidates: (await completeWords(program, rest.join(' '))).candidates, from };
    if (['cat', 'grep', 'head'].includes(name!)) return { candidates: vfs.list().filter((f) => f.startsWith(current)), from };
    return { candidates: [], from };
  }

  const prompt = () => `${status === 0 ? '\x1b[1;32m' : '\x1b[1;31m'}➜\x1b[0m \x1b[1;36m~\x1b[0m `;

  return {
    /** Reads and runs commands until the page goes away. */
    async start(greeting: string) {
      term.write(greeting);
      while (true) {
        atPrompt = true;
        const line = await editor.readLine(prompt(), { history, complete });
        atPrompt = false;
        if (line === null) {
          term.write(dim('(there is nowhere to exit to: this terminal lives in the page)\n'));
          continue;
        }
        if (line === REPL_SIGINT) {
          status = 130;
          continue;
        }
        if (!line.trim()) continue;
        if (history.at(-1) !== line) history.push(line);
        await execute(line);
      }
    },
    /** Types a command at the prompt and runs it, if the shell is waiting for input. */
    async type(command: string) {
      if (!atPrompt) return false;
      editor.onData('\x15');
      for (const ch of command) {
        editor.onData(ch);
        await new Promise((resolve) => setTimeout(resolve, 18));
        if (!atPrompt) return false;
      }
      editor.onData('\r');
      return true;
    },
    get idle() {
      return atPrompt;
    },
  };
}

export type Shell = ReturnType<typeof createShell>;
