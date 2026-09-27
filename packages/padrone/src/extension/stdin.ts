import { applyValues, getFieldTypes, getStdinConfig, isArrayField, isAsyncStreamField } from '../core/args.ts';
import { resolveStdin, resolveStdinAlways } from '../core/default-runtime.ts';
import { positionalFields } from '../core/from-file.ts';
import { defineInterceptor, LOCAL_CALLERS } from '../core/interceptors.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext } from '../types/index.ts';
import { createStdinStream } from '../util/stream.ts';
import { isProvidedPositionally } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

// Serve, MCP and tool calls pass the field as an argument; the process's stdin isn't theirs (MCP's stdio transport reads it)
const stdinMeta = { id: 'padrone:stdin', name: 'padrone:stdin', order: -1001, callers: LOCAL_CALLERS } as const;

const isDash = (value: unknown) => value === '-' || (Array.isArray(value) && value.length === 1 && value[0] === '-');

const stdinInterceptor = defineInterceptor(stdinMeta, () => ({
  validate(ctx: InterceptorValidateContext, next) {
    const config = getStdinConfig(ctx.command.meta);
    if (!config) return next();
    const { field } = config;
    const { command, rawArgs, positionalArgs } = ctx;

    // A lone `-` reads stdin, like `cat -`: as the option's value, or as the field's only positional value
    const positionalIndexes = positionalFields(command, positionalArgs.length).flatMap((name, i) => (name === field ? [i] : []));
    const dashPositional =
      positionalIndexes.length === 1 && positionalArgs[positionalIndexes[0]!] === '-' ? positionalIndexes[0] : undefined;
    const dash = isDash(rawArgs[field]) || dashPositional !== undefined;

    // Skip if the field was already provided via CLI flags or positionally
    if (!dash && field in rawArgs && rawArgs[field] !== undefined) return next();
    if (!dash && isProvidedPositionally(command, field, positionalArgs)) return next();

    /** Sets the field to what stdin gave, in place of the `-` it was given. */
    const fill = (value: string | string[] | AsyncIterable<unknown>) => {
      if (dashPositional === undefined)
        return next({ rawArgs: dash ? { ...rawArgs, [field]: value } : applyValues(rawArgs, { [field]: value }) });
      // In place of the `-`, so the positionals after it keep their fields; a stream can't be a positional value
      if (typeof value === 'string' || Array.isArray(value))
        return next({ positionalArgs: positionalArgs.toSpliced(dashPositional, 1, ...[value].flat()) });
      return next({ rawArgs: { ...rawArgs, [field]: value }, positionalArgs: positionalArgs.toSpliced(dashPositional, 1) });
    };

    const streamInfo = isAsyncStreamField(command.argsSchema, field);
    if (streamInfo) return fill(createStdinStream(resolveStdinAlways(ctx.runtime as any), streamInfo.itemSchema));

    const stdin = dash ? resolveStdinAlways(ctx.runtime as any) : resolveStdin(ctx.runtime as any);
    if (!stdin) return next();

    if (isArrayField(command.argsSchema, field)) {
      return (async () => {
        const lines: string[] = [];
        for await (const line of stdin.lines()) lines.push(config.trim ? line.trim() : line);
        // Empty input leaves the field to its default, like text mode
        if (lines.length === 0 && !dash) return next();
        return fill(lines);
      })();
    }

    // A number or boolean read from stdin (`echo 21 | …`) ends with a newline that isn't part of the value
    const types = getFieldTypes(command.argsSchema, field);
    const trim = config.trim || (!types.has('string') && ['number', 'integer', 'boolean'].some((type) => types.has(type)));
    return stdin.text().then((raw) => {
      const text = trim ? raw.trim() : raw;
      if (!text && !dash) return next();
      return fill(text);
    });
  },
}));

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that reads stdin data into the argument field specified by `meta.stdin`.
 * Included by default via `createPadrone()`.
 *
 * Read mode is inferred from the schema type:
 * - `string` field → reads all stdin as a single string
 * - `string[]` field → reads stdin line-by-line into an array
 * - `AsyncIterable` field → returns a stream for line-by-line async consumption
 *
 * Stdin is read when piped (not a TTY) and the field wasn't already provided via CLI flags or positionally,
 * or when the field's value is a lone `-` (even from a terminal). `{ field, trim: true }` trims the text, and number
 * and boolean fields are always trimmed. It's never read for serve, MCP and `tool()` calls.
 */
export function padroneStdin(options?: { disabled?: boolean }): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = options?.disabled ? defineInterceptor({ ...stdinMeta, disabled: true }, () => ({})) : stdinInterceptor;
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
