import { findCommandByName } from '#src/core/commands.ts';
import { PadroneError } from '#src/core/errors.ts';
import { defineInterceptor } from '#src/core/interceptors.ts';
import { tokenizeInput } from '#src/core/parse.ts';
import { thenMaybe } from '#src/core/results.ts';
import { getCommandFieldRules, parseCommand } from '#src/core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '#src/types/index.ts';
import { fileErrorReason, readTextFile } from '#src/util/files.ts';
import { inputTokens, isRemoteCaller } from './utils.ts';

export type PadroneResponseFilesOptions = {
  /** The character that marks a response file argument. Defaults to `'@'`. */
  prefix?: string;
  /**
   * What a response file named inside another one is relative to: `'cwd'` (default), or `'file'`, the directory of the
   * file that names it, like clap's argfiles. Response files on the command line are always relative to cwd.
   */
  relativeTo?: 'cwd' | 'file';
};

const MAX_DEPTH = 10;

/** The arguments in a response file: each line is split like a command line; blank lines and `#` comment lines are skipped. */
export function parseResponseFile(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith('#') ? [] : [...tokenizeInput(trimmed)];
  });
}

const isAbsolutePath = (file: string) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(file);

/** `file` relative to the directory of `including` (no `node:path`, so it runs anywhere). */
function besideFile(file: string, including: string): string {
  const slash = Math.max(including.lastIndexOf('/'), including.lastIndexOf('\\'));
  return isAbsolutePath(file) || slash === -1 ? file : `${including.slice(0, slash + 1)}${file}`;
}

/**
 * Replaces each `@file` token before `--` with the file's arguments (nested response files expand too, up to 10 levels,
 * relative to cwd or, with `relativeTo: 'file'`, to the file that names them); `@@text` passes `@text`. A missing file is
 * an error. Tokens for which `keep` (given the tokens before them) is true stay as they are.
 */
export function expandResponseFiles(
  tokens: readonly string[],
  prefix = '@',
  keep?: (before: readonly string[]) => boolean,
  relativeTo: 'cwd' | 'file' = 'cwd',
): string[] | Promise<string[]> {
  const out: string[] = [];
  let afterDoubleDash = false;

  const read = (file: string): string | Promise<string> => {
    const fail = (err: unknown): never => {
      const reason = fileErrorReason(err);
      const hint = reason === 'file not found' ? ` (write ${prefix}${prefix}${file} for a literal "${prefix}${file}")` : '';
      throw new PadroneError(`Cannot read response file "${file}": ${reason}${hint}`, { phase: 'parse', cause: err });
    };
    try {
      const text = readTextFile(file);
      return text instanceof Promise ? text.catch(fail) : text;
    } catch (err) {
      return fail(err);
    }
  };

  const expand = (list: readonly string[], depth: number, including?: string): void | Promise<void> => {
    for (let i = 0; i < list.length; i++) {
      const token = list[i]!;
      if (afterDoubleDash || !token.startsWith(prefix) || keep?.(out)) {
        if (token === '--') afterDoubleDash = true;
        out.push(token);
        continue;
      }
      if (token.startsWith(prefix + prefix)) {
        out.push(token.slice(prefix.length));
        continue;
      }
      const named = token.slice(prefix.length);
      const file = including && relativeTo === 'file' ? besideFile(named, including) : named;
      if (!named) throw new PadroneError(`Expected a response file path after "${prefix}"`, { phase: 'parse' });
      if (depth >= MAX_DEPTH)
        throw new PadroneError(`Response files nested more than ${MAX_DEPTH} levels deep: "${file}"`, { phase: 'parse' });
      const rest = list.slice(i + 1);
      const expanded = thenMaybe(read(file), (text) => expand(parseResponseFile(text), depth + 1, file));
      if (expanded instanceof Promise) return expanded.then(() => expand(rest, depth, including));
    }
  };

  return thenMaybe(expand(tokens, 0), () => out);
}

const MARKER = 'padrone0response0file0value';

/** Whether the next token would be the value of an option with `fromFile` meta (`--body @notes.md`), which reads the file itself. */
function isFromFileValue(before: readonly string[], root: AnyPadroneCommand): boolean {
  if (!before.at(-1)?.startsWith('-')) return false;
  const { command, rawArgs } = parseCommand([...before, MARKER], root, findCommandByName);
  return [...getCommandFieldRules(command).fromFile].some((field) => {
    const value = rawArgs[field];
    return value === MARKER || (Array.isArray(value) && value.includes(MARKER));
  });
}

const RESPONSE_FILES_ID = 'padrone:response-files';
const registeredOptions = new WeakMap<object, Required<PadroneResponseFilesOptions>>();

/** The options of the response files extension registered on `root`, if any. */
export function responseFilesOptions(root: AnyPadroneCommand): Required<PadroneResponseFilesOptions> | undefined {
  const registered = root.interceptors?.findLast(({ meta }) => meta.id === RESPONSE_FILES_ID);
  return registered && !registered.meta.disabled ? registeredOptions.get(registered.factory) : undefined;
}

/**
 * Extension for response files, like javac's or clap's argfiles: `my-cli @args.txt deploy` reads the arguments in
 * `args.txt` (one or more per line, quoted like a shell line; blank lines and `#` comments skipped) in place of `@args.txt`.
 * Paths are relative to cwd (nested ones, to the including file with `relativeTo: 'file'`). Tokens after `--` stay as they
 * are, and `@@text` passes `@text` literally.
 * A missing file is an error. Serve, MCP and `tool()` calls never expand response files.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneResponseFiles())
 * ```
 */
export function padroneResponseFiles(options: PadroneResponseFilesOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const prefix = options.prefix || '@';
  const relativeTo = options.relativeTo ?? 'cwd';
  const interceptor = defineInterceptor({ id: RESPONSE_FILES_ID, name: RESPONSE_FILES_ID, order: -1600, async: true }, () => ({
    parse(ctx, next) {
      if (isRemoteCaller(ctx.caller)) return next();
      const tokens = inputTokens(ctx.input, ctx.command);
      const end = tokens.indexOf('--');
      if (!(end === -1 ? tokens : tokens.slice(0, end)).some((token) => token.startsWith(prefix))) return next();
      const keep = (before: readonly string[]) => isFromFileValue(before, ctx.command);
      return thenMaybe(expandResponseFiles(tokens, prefix, keep, relativeTo), (input) => next({ input }));
    },
  }));
  registeredOptions.set(interceptor, { prefix, relativeTo });
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
