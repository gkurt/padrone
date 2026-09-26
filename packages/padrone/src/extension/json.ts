import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorParseResult } from '../types/index.ts';
import { safeJsonStringify } from '../util/json.ts';
import { frameworkFlags, markErrorReported } from './utils.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

/** The JSON shape of an error: `{ error: { name, message, exitCode?, suggestions?, issues? } }`. */
function toErrorJson(error: unknown): { error: Record<string, unknown> } {
  if (!(error instanceof Error)) return { error: { message: String(error) } };
  const { exitCode, suggestions, command } = error as { exitCode?: number; suggestions?: string[]; command?: string };
  return {
    error: {
      name: error.name,
      message: error.message,
      ...(command !== undefined && { command }),
      ...(exitCode !== undefined && { exitCode }),
      ...(suggestions?.length && { suggestions }),
      ...(error instanceof ValidationError && {
        issues: error.issues.map((issue) => ({
          path: issue.path?.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
          message: issue.message,
        })),
      }),
    },
  };
}

// ── Interceptor ─────────────────────────────────────────────────────────

const jsonInterceptor = defineInterceptor({ id: 'padrone:json', name: 'padrone:json', order: -1101, options: { json: 'flag' } }, () => {
  let enabled = false;
  const read = (rawArgs: Record<string, unknown>, command: AnyPadroneCommand, runtime: { format?: string }) => {
    const flags = frameworkFlags(rawArgs, command);
    if (!flags.has('json')) return;
    enabled = flags.get('json') !== false;
    flags.delete('json');
    if (enabled) runtime.format = 'json';
  };

  return {
    // Registered on the program: read in parse, so routing errors are printed as JSON too
    parse(ctx, next) {
      // Parsing failed (e.g. an unknown command), so the flag is only in the raw input
      const onError = (err: unknown): never => {
        const { input } = ctx;
        if (Array.isArray(input) ? input.includes('--json') : /(^|\s)--json(\s|$)/.test(input ?? '')) enabled = true;
        throw err;
      };
      let parsed: InterceptorParseResult | Promise<InterceptorParseResult>;
      try {
        parsed = next();
      } catch (err) {
        return onError(err);
      }
      const handle = (res: InterceptorParseResult) => {
        read(res.rawArgs, res.command, ctx.runtime);
        return res;
      };
      return parsed instanceof Promise ? parsed.then(handle, onError) : handle(parsed);
    },
    // Registered on a command: its parse handler doesn't run
    validate(ctx, next) {
      read(ctx.rawArgs, ctx.command, ctx.runtime);
      return next();
    },
    error(ctx, next) {
      if (!enabled || ctx.caller !== 'cli') return next();
      // Keep help and auto-output from printing it as text
      markErrorReported(ctx.error);
      return thenMaybe(next(), (er) => {
        if (er.error !== undefined) ctx.runtime.output(safeJsonStringify(toErrorJson(er.error), 2));
        return er;
      });
    },
  };
});

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds a `--json` flag, like oclif's `enableJsonFlag` or `gh --json`:
 * - The command's result is printed as JSON (iterator items as one JSON value per line), and output
 *   primitives (`ctx.context.output.table()` etc.) render JSON.
 * - In `cli()`, errors are printed to stdout as `{ "error": { "name", "message", ... } }`
 *   (validation errors include their `issues`) instead of text.
 *
 * Apply to the program for every command, or inside `.command()` for one command.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneJson())
 * // my-cli users list --json
 * ```
 */
export function padroneJson(): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(jsonInterceptor)) as any;
}
