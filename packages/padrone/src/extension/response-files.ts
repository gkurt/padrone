import { PadroneError } from '#src/core/errors.ts';
import { defineInterceptor } from '#src/core/interceptors.ts';
import { tokenizeInput } from '#src/core/parse.ts';
import { thenMaybe } from '#src/core/results.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '#src/types/index.ts';
import { fileErrorReason, readTextFile } from '#src/util/files.ts';
import { inputTokens } from './aliases.ts';
import { isRemoteCaller } from './utils.ts';

export type PadroneResponseFilesOptions = {
  /** The character that marks a response file argument. Defaults to `'@'`. */
  prefix?: string;
};

const MAX_DEPTH = 10;

/** The arguments in a response file: each line is split like a command line; blank lines and `#` comment lines are skipped. */
export function parseResponseFile(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith('#') ? [] : [...tokenizeInput(trimmed)];
  });
}

/**
 * Replaces each `@file` token before `--` with the file's arguments (nested response files expand too, up to 10 levels);
 * `@@text` passes `@text`. A missing file is an error.
 */
export function expandResponseFiles(tokens: readonly string[], prefix = '@'): string[] | Promise<string[]> {
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

  const expand = (list: readonly string[], depth: number): void | Promise<void> => {
    for (let i = 0; i < list.length; i++) {
      const token = list[i]!;
      if (afterDoubleDash || !token.startsWith(prefix)) {
        if (token === '--') afterDoubleDash = true;
        out.push(token);
        continue;
      }
      if (token.startsWith(prefix + prefix)) {
        out.push(token.slice(prefix.length));
        continue;
      }
      const file = token.slice(prefix.length);
      if (!file) throw new PadroneError(`Expected a response file path after "${prefix}"`, { phase: 'parse' });
      if (depth >= MAX_DEPTH)
        throw new PadroneError(`Response files nested more than ${MAX_DEPTH} levels deep: "${file}"`, { phase: 'parse' });
      const rest = list.slice(i + 1);
      const expanded = thenMaybe(read(file), (text) => expand(parseResponseFile(text), depth + 1));
      if (expanded instanceof Promise) return expanded.then(() => expand(rest, depth));
    }
  };

  return thenMaybe(expand(tokens, 0), () => out);
}

/**
 * Extension for response files, like javac's or clap's argfiles: `my-cli @args.txt deploy` reads the arguments in
 * `args.txt` (one or more per line, quoted like a shell line; blank lines and `#` comments skipped) in place of `@args.txt`.
 * Paths are relative to cwd. Tokens after `--` stay as they are, and `@@text` passes `@text` literally.
 * A missing file is an error. Serve, MCP and `tool()` calls never expand response files.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneResponseFiles())
 * ```
 */
export function padroneResponseFiles(options: PadroneResponseFilesOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const prefix = options.prefix || '@';
  const interceptor = defineInterceptor(
    { id: 'padrone:response-files', name: 'padrone:response-files', order: -1600, async: true },
    () => ({
      parse(ctx, next) {
        if (isRemoteCaller(ctx.caller)) return next();
        const tokens = inputTokens(ctx.input, ctx.command);
        const end = tokens.indexOf('--');
        if (!(end === -1 ? tokens : tokens.slice(0, end)).some((token) => token.startsWith(prefix))) return next();
        return thenMaybe(expandResponseFiles(tokens, prefix), (input) => next({ input }));
      },
    }),
  );
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
