import {
  buildReplCompleter,
  findCommandByName,
  formatSuggestions,
  getCommandRuntime,
  subcommandNames,
  suggestSimilar,
} from '../core/commands.ts';
import { createTerminalReplSession } from '../core/default-runtime.ts';
import { formatErrorText } from '../core/errors.ts';
import { REPL_SIGINT, type ReplSessionConfig } from '../core/runtime.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { shouldUseAnsi } from '../output/styling.ts';
import type { AnyPadroneCommand, PadroneEvalPreferences, PadroneReplPreferences } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';

export type ReplDeps = {
  existingCommand: AnyPadroneCommand;
  evalCommand: (input: string, prefs?: PadroneEvalPreferences) => any;
  replActiveRef: { value: boolean };
};

/**
 * Creates a REPL async iterable for running commands interactively.
 */
export function createReplIterator(deps: ReplDeps, options?: PadroneReplPreferences): AsyncIterable<any> & { drain: () => Promise<any> } {
  const { existingCommand, evalCommand, replActiveRef } = deps;

  const overrides = options?.runtime && Object.fromEntries(Object.entries(options.runtime).filter(([, v]) => v !== undefined));
  const runtime = overrides ? { ...getCommandRuntime(existingCommand), ...overrides } : getCommandRuntime(existingCommand);

  if (replActiveRef.value) {
    runtime.error('REPL is already running. Nested REPL sessions are not supported.');
    const empty = (async function* () {})();
    return Object.assign(empty, { drain: async () => ({ value: [] }) }) as any;
  }

  const programName = existingCommand.name || 'padrone';
  const env = runtime.env();
  const useAnsi = runtime.format === 'ansi' || (runtime.format === 'auto' && shouldUseAnsi(env, runtime.terminal?.isTTY));

  const historySize = options?.historySize ?? 1000;
  const historyFile =
    options?.historyFile === true
      ? `${getProgramDirs(programName, env).state}${globalThis.process?.platform === 'win32' ? '\\' : '/'}repl_history`
      : options?.historyFile || undefined;

  // The commands along a scope path (like 'db' or 'db migrate') from `from`, up to the first unknown name
  const resolveScope = (scope: string, from = existingCommand): AnyPadroneCommand[] => {
    const stack: AnyPadroneCommand[] = [];
    for (const part of scope.split(/\s+/)) {
      const found = findCommandByName(part, (stack.at(-1) ?? from).commands);
      if (!found) break;
      stack.push(found);
    }
    return stack;
  };

  async function* replIterator() {
    replActiveRef.value = true;
    const showGreeting = options?.greeting !== false;
    const showHint = options?.hint !== false;

    // Empty line before greeting/hint block
    if (showGreeting || showHint) runtime.output('');

    // Greeting: default shows program title (or name) + version, like "Welcome to My App v1.0.0"
    if (showGreeting) {
      if (options?.greeting) {
        runtime.output(options.greeting);
      } else {
        const displayName = existingCommand.title || programName;
        const version = existingCommand.version;
        const greeting = version ? `Welcome to ${displayName} v${version}` : `Welcome to ${displayName}`;
        runtime.output(greeting);
      }
    }

    // Hint: dimmed text below greeting
    if (showHint) {
      const hintText =
        (typeof options?.hint === 'string' ? options.hint : undefined) ?? 'Type ".help" for more information, ".exit" to quit.';
      runtime.output(useAnsi ? `\x1b[2m${hintText}\x1b[0m` : hintText);
    }

    // Empty line after greeting/hint block
    if (showGreeting || showHint) runtime.output('');

    // Scope stack for nested/contextual REPLs.
    // `cd <subcommand>` pushes, `cd ..`/`..` pops. The scope path is prepended to all eval input.
    const scopeStack: AnyPadroneCommand[] = options?.scope ? resolveScope(options.scope) : [];

    const getScopeCommand = () => (scopeStack.length ? scopeStack[scopeStack.length - 1]! : existingCommand);
    const getScopePath = () => scopeStack.map((c) => c.name).join(' ');

    /** The input with the scope path prepended, so it resolves from the root; `help <command>` gets it after `help`. */
    const withScope = (input: string) => {
      const scopePath = getScopePath();
      if (!scopePath) return input;
      if (!input) return scopePath;
      const word = input.split(/\s/, 1)[0]!;
      const help = findCommandByName(word, existingCommand.commands);
      const builtinHelp = help?.name === 'help' && help.flagNames !== undefined && !findCommandByName(word, getScopeCommand().commands);
      return builtinHelp ? input.replace(word, `${word} ${scopePath}`) : `${scopePath} ${input}`;
    };

    const buildPrompt = () => {
      if (options?.prompt) return typeof options.prompt === 'function' ? options.prompt() : options.prompt;
      const scopePath = getScopePath();
      const label = scopePath ? `${programName}/${scopePath.replace(/ /g, '/')}` : programName;
      return useAnsi ? `\x1b[1m${label}\x1b[0m ❯ ` : `${label} ❯ `;
    };

    // Build completer scoped to the current command
    const buildScopedCompleter = () => {
      const scopeCmd = getScopeCommand();
      const inScope = scopeStack.length > 0;
      return buildReplCompleter(scopeCmd, { inScope });
    };

    const savedHistory = historyFile ? await openHistoryFile(historyFile, historySize) : undefined;
    // Track command history for .history built-in
    const commandHistory = [...(savedHistory?.entries ?? [])];

    // Build session config with completer
    const sessionConfig: ReplSessionConfig = { history: [...commandHistory, ...(options?.history ?? [])], historySize };
    if (options?.completion !== false) {
      sessionConfig.completer = buildScopedCompleter();
    }

    // If the runtime provides a custom readLine, use it (stateless, no history/completion).
    // Otherwise, create a persistent terminal session with history + tab completion.
    const session = runtime.readLine ? undefined : createTerminalReplSession(sessionConfig);
    const questionFn = session ? (prompt: string) => session.question(prompt) : runtime.readLine!;

    // Update the session's completer when scope changes
    const updateCompleter = () => {
      if (options?.completion === false) return;
      const completer = buildScopedCompleter();
      if (session) session.completer = completer;
      sessionConfig.completer = completer;
    };

    // Track last SIGINT time for double Ctrl+C to exit
    let lastSigintTime = 0;

    try {
      while (true) {
        const promptStr = buildPrompt();
        const input = await questionFn(promptStr);

        // EOF (Ctrl+D, closed connection)
        if (input === null) break;

        // Handle Ctrl+C (SIGINT sentinel from terminal session)
        if (input === REPL_SIGINT) {
          const now = Date.now();
          if (now - lastSigintTime < 2000) break; // Double Ctrl+C within 2s → exit
          lastSigintTime = now;
          runtime.output('(press Ctrl+C again to exit, or Ctrl+D)');
          continue;
        }

        const trimmed = input.trim();
        if (!trimmed) continue;

        // Reset SIGINT timer on any real input
        lastSigintTime = 0;

        // Track command history for .history
        commandHistory.push(trimmed);
        savedHistory?.add(trimmed);

        // Dot-prefixed built-in REPL commands
        if (trimmed === '.exit' || trimmed === '.quit') break;
        // Bare `exit`/`quit` too, unless the scope has a command by that name
        if ((trimmed === 'exit' || trimmed === 'quit') && !findCommandByName(trimmed, getScopeCommand().commands)) break;
        if (trimmed === '.clear') {
          runtime.output('\x1B[2J\x1B[H');
          continue;
        }
        if (trimmed === '.help') {
          const lines = [
            'REPL Commands:',
            '  .                 Execute the current scoped command',
            '  .help             Print this help message',
            '  .exit, exit       Exit the REPL (also .quit, quit)',
            '  .clear            Clear the screen',
            '  .history          Show command history',
            '  .scope <cmd>      Scope into a subcommand',
            '  .scope ..         Go up one scope level',
          ];
          lines.push(
            '',
            'Keybindings:',
            '  Ctrl+C       Cancel current line (press twice to exit)',
            '  Ctrl+D       Exit the REPL',
            '  Up/Down      Navigate history',
            '  Tab          Auto-complete',
            '',
            'Type "help" to see available commands.',
          );
          runtime.output(lines.join('\n'));
          continue;
        }
        if (trimmed === '.history') {
          // Show all previous entries (excluding the .history command itself)
          const entries = commandHistory.slice(0, -1);
          if (entries.length === 0) {
            runtime.output('No history.');
          } else {
            runtime.output(entries.map((entry, i) => `${i + 1}  ${entry}`).join('\n'));
          }
          continue;
        }

        // `.scope <subcommand>` — scope the REPL to a command subtree
        // `.scope ..` or `..` — go up one scope level
        if (trimmed.startsWith('.scope ') || trimmed === '.scope') {
          const target = trimmed.slice(6).trim();
          if (target === '..' || target === '') {
            if (scopeStack.length > 0) {
              scopeStack.pop();
              updateCompleter();
            }
          } else {
            const found = resolveScope(target, getScopeCommand());
            const parts = target.split(/\s+/);
            if (found.length < parts.length) {
              const similar = suggestSimilar(parts[found.length]!, subcommandNames(found.at(-1) ?? getScopeCommand()));
              runtime.error(`Unknown command: ${target}${similar.length ? `\n\n  ${formatSuggestions(similar)}` : ''}`);
            } else if (!found.at(-1)!.commands?.length) {
              runtime.error(`"${target}" has no subcommands to scope into.`);
            } else {
              scopeStack.push(...found);
              updateCompleter();
            }
          }
          continue;
        }

        // `..` shorthand for `.scope ..`
        if (trimmed === '..') {
          if (scopeStack.length > 0) {
            scopeStack.pop();
            updateCompleter();
          }
          continue;
        }

        // `.` (bare dot) — execute the current command (scoped or root)
        let evalInput = trimmed;
        if (trimmed === '.') {
          evalInput = '';
        }

        const prefix = options?.outputPrefix;
        const prefixLines = prefix
          ? (text: string) =>
              text
                .split('\n')
                .map((l) => prefix + l)
                .join('\n')
          : undefined;

        // The session's runtime overrides, with handler output prefixed
        const evalRuntime = prefixLines
          ? {
              ...overrides,
              output: (...args: unknown[]) => {
                const first = args[0];
                runtime.output(typeof first === 'string' ? prefixLines(first) : first, ...args.slice(1));
              },
              error: (text: string) => runtime.error(prefixLines(text)),
            }
          : overrides;

        // Resolve before/after spacing from the shorthand or object form
        const sp = options?.spacing;
        const isSpacingObject = typeof sp === 'object' && sp !== null && !Array.isArray(sp);
        const spacingBefore = isSpacingObject ? sp.before : sp;
        const spacingAfter = isSpacingObject ? sp.after : sp;

        const emitSpacingLine = (value: boolean | string) => {
          if (typeof value === 'string') {
            const sep = value.length === 1 ? value.repeat(runtime.terminal?.columns ?? 80) : value;
            runtime.output(sep);
          } else if (value) {
            runtime.output('');
          }
        };
        const emitSpacing = (value: typeof spacingBefore) => {
          if (!value) return;
          if (Array.isArray(value)) {
            for (const line of value) emitSpacingLine(line);
          } else {
            emitSpacingLine(value);
          }
        };

        emitSpacing(spacingBefore);

        const scopedInput = withScope(evalInput);

        try {
          const replEvalPrefs: PadroneEvalPreferences = {
            caller: 'repl',
            ...(evalRuntime && { runtime: evalRuntime }),
            ...(options?.context !== undefined && { context: options.context }),
          };
          const result = await evalCommand(scopedInput, replEvalPrefs);
          if (result.error) {
            const msg = formatErrorText(result.error);
            runtime.error(prefixLines ? prefixLines(msg) : msg);
          } else if (result.argsResult?.issues) {
            const msg = `Validation error:\n${formatIssueMessages(result.argsResult.issues)}`;
            runtime.error(prefixLines ? prefixLines(msg) : msg);
          }
          yield result as any;
        } catch (err) {
          const msg = formatErrorText(err);
          runtime.error(prefixLines ? prefixLines(msg) : msg);
        } finally {
          emitSpacing(spacingAfter);
        }
      }
    } finally {
      replActiveRef.value = false;
      session?.close();
    }
  }

  const iterable = replIterator();
  (iterable as any).drain = async () => {
    try {
      const results: any[] = [];
      for await (const result of iterable) results.push(result);
      return { value: results };
    } catch (err) {
      return { error: err };
    }
  };
  return iterable as any;
}

/**
 * The REPL's history file: one entry per line, oldest first, keeping the last `size`. `add` saves an entry right away,
 * skipping a repeat of the last one. History is a convenience: files that can't be read or written are ignored.
 */
async function openHistoryFile(file: string, size: number): Promise<{ entries: string[]; add: (entry: string) => void }> {
  if (size <= 0) return { entries: [], add: () => {} };
  const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]).catch(() => []);
  let entries: string[] = [];
  try {
    if (fs?.existsSync(file)) entries = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-size);
  } catch {}
  const add = (entry: string) => {
    if (!fs || !path || entry === entries.at(-1)) return;
    entries = [...entries, entry].slice(-size);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Private like shell history: commands can carry tokens and passwords
      fs.writeFileSync(file, `${entries.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch {}
  };
  return { entries, add };
}
