import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { isAsyncIterator, isIterator } from '../core/results.ts';
import type { OutputConfig } from '../output/output-indicator.ts';
import { createOutputIndicator, formatDeclarativeOutput } from '../output/output-indicator.ts';
import { resolveOutputFormat } from '../output/styling.ts';
import type {
  AnyPadroneBuilder,
  CommandTypesBase,
  InterceptorErrorContext,
  InterceptorErrorResult,
  InterceptorExecuteContext,
  InterceptorExecuteResult,
} from '../types/index.ts';
import { safeJsonStringify } from '../util/json.ts';
import { getJsonOutputFilter, isErrorReported, isRemoteCaller, markErrorReported } from './utils.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Outputs each value and collects into a result.
 * For iterators: outputs each yielded value, returns collected array.
 * For promises: awaits, then recurses.
 * For other values: outputs directly, returns as-is.
 */
function outputAndCollect(value: unknown, output: (value: unknown) => void, outputItem = output): unknown {
  if (value == null) return value;

  if (isAsyncIterator(value)) {
    return (async () => {
      const items: unknown[] = [];
      const iter = (value as any)[Symbol.asyncIterator]();
      while (true) {
        const { done, value: item } = await iter.next();
        if (done) break;
        items.push(item);
        if (item != null) outputItem(item);
      }
      return items;
    })();
  }

  if (typeof value !== 'string' && !Array.isArray(value) && isIterator(value)) {
    const items: unknown[] = [];
    const iter = (value as any)[Symbol.iterator]();
    while (true) {
      const { done, value: item } = iter.next();
      if (done) break;
      items.push(item);
      if (item != null) outputItem(item);
    }
    return items;
  }

  if (value instanceof Promise) {
    return value.then((resolved) => outputAndCollect(resolved, output, outputItem));
  }

  output(value);
  return value;
}

// ── Interceptor ─────────────────────────────────────────────────────────

/** Callers that print to a terminal; serve, MCP and tool calls return results through their own transport. */
const TERMINAL_CALLERS = new Set<string>(['cli', 'eval', 'repl']);

const autoOutputMeta = { id: 'padrone:auto-output', name: 'padrone:auto-output', order: -1100 } as const;

/** `DEBUG` set to anything but empty, `0` or `false` (e.g. `DEBUG=1`, `DEBUG=*`). */
function isDebugEnv(env: Record<string, string | undefined>): boolean {
  const debug = env.DEBUG;
  return !!debug && debug !== '0' && debug !== 'false';
}

/** The JSON shape of an error: `{ error: { name, message, command?, exitCode?, suggestions?, issues?, stack? } }`. */
function toErrorJson(error: unknown, stack: boolean): { error: Record<string, unknown> } {
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
      ...(stack && { stack: formatErrorStack(error) }),
    },
  };
}

/** The error's stack, followed by the stacks of its `cause` chain. */
function formatErrorStack(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current !== undefined && !seen.has(current); current = (current as { cause?: unknown })?.cause) {
    seen.add(current);
    const text = current instanceof Error ? (current.stack ?? `${current.name}: ${current.message}`) : String(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    if (!(current instanceof Error)) break;
  }
  return parts.join('\n');
}

function createAutoOutputInterceptor(outputConfig?: OutputConfig, errorOutput?: boolean, errorStack?: boolean) {
  return defineInterceptor(autoOutputMeta, () => ({
    error(ctx: InterceptorErrorContext, next: () => InterceptorErrorResult | Promise<InterceptorErrorResult>) {
      const handleResult = (er: InterceptorErrorResult): InterceptorErrorResult => {
        if (!er.error || errorOutput === false || ctx.caller !== 'cli' || isErrorReported(er.error)) return er;
        const showStack = errorStack ?? isDebugEnv(ctx.runtime.env());
        // Under JSON output (e.g. `--json`), errors go to stdout as JSON, like results
        if (ctx.runtime.format === 'json') ctx.runtime.output(safeJsonStringify(toErrorJson(er.error, showStack), 2));
        else ctx.runtime.error(showStack ? formatErrorStack(er.error) : er.error instanceof Error ? er.error.message : String(er.error));
        markErrorReported(er.error);
        return er;
      };

      const result = next();
      if (result instanceof Promise) return result.then(handleResult);
      return handleResult(result);
    },
    execute(ctx: InterceptorExecuteContext, next) {
      const outputCtx = resolveOutputFormat(ctx.runtime, ctx.caller);
      const indicator = createOutputIndicator(ctx.runtime.output, outputCtx);

      const handleResult = (e: InterceptorExecuteResult): InterceptorExecuteResult | Promise<InterceptorExecuteResult> => {
        // If the action already called output.*, skip auto-output
        if (indicator.called) return e;

        const autoOutput = (value: unknown): unknown => {
          if (value == null) return value;

          // Serve, MCP and tool calls return the result through their transport: collect streams without printing
          if (isRemoteCaller(ctx.caller)) return outputAndCollect(value, () => {});

          const json = ctx.runtime.format === 'json' && TERMINAL_CALLERS.has(ctx.caller);

          // `--jq` / `--template` turn each value into lines of their own
          const filter = json ? getJsonOutputFilter(ctx.runtime) : undefined;
          if (filter) {
            const writeLines = (v: unknown) => {
              for (const line of filter(v)) ctx.runtime.output(line);
            };
            return outputAndCollect(value, writeLines);
          }

          // Declarative output config: format the return value through the primitive
          if (outputConfig) {
            const rendered = formatDeclarativeOutput(value, outputConfig, outputCtx);
            if (rendered !== undefined) {
              ctx.runtime.output(rendered);
              return value;
            }
          }

          // `format: 'json'` (e.g. from `--json`): values as JSON, iterator items one per line (NDJSON)
          if (json) {
            const write = (space?: number) => (v: unknown) => ctx.runtime.output(safeJsonStringify(v, space) ?? String(v));
            return outputAndCollect(value, write(2), write());
          }
          return outputAndCollect(value, ctx.runtime.output);
        };

        if (e.result instanceof Promise) {
          return { result: e.result.then(autoOutput) };
        }

        const collected = autoOutput(e.result);
        if (collected instanceof Promise) return collected.then((v) => ({ result: v }));
        return { result: collected };
      };

      const executedOrPromise = next({ context: { output: indicator } });
      if (executedOrPromise instanceof Promise) return executedOrPromise.then(handleResult);
      return handleResult(executedOrPromise);
    },
  }));
}

// ── Extension ───────────────────────────────────────────────────────────

export type PadroneAutoOutputOptions = {
  /** Disable auto-output entirely. */
  disabled?: boolean;
  /**
   * Declarative output format for the command's return value.
   * When set, auto-output formats the return value through the specified primitive
   * instead of passing it raw to `runtime.output`.
   * Ignored when the action calls `ctx.context.output.*` explicitly.
   *
   * ```ts
   * // Format return value as a table
   * c.extend(padroneAutoOutput({ output: 'table' }))
   *
   * // Format with options
   * c.extend(padroneAutoOutput({ output: { type: 'table', options: { border: false } } }))
   * ```
   */
  output?: OutputConfig;
  /**
   * Automatically print errors to stderr in CLI mode, whichever phase threw them.
   * Skips errors another extension already printed (routing and validation errors are printed by help).
   * Under JSON output (`--json`, `format: 'json'`), every error is printed to stdout as
   * `{ "error": { "name", "message", ... } }` (validation errors include their `issues`).
   * @default true
   */
  errorOutput?: boolean;
  /**
   * Print the error's stack trace (and its `cause` chain) instead of only its message.
   * Defaults to on when the `DEBUG` environment variable is set (e.g. `DEBUG=1 my-cli deploy`).
   */
  errorStack?: boolean;
};

/**
 * Extension that automatically writes a command's return value to output after execution.
 *
 * - Values are passed directly to the runtime's `output` function (no stringification).
 * - Promises are awaited before output.
 * - Iterators and async iterators are consumed, outputting each yielded value as it arrives.
 *   The result is replaced with the collected array so `drain()` still works.
 * - `undefined` and `null` results produce no output.
 *
 * Also injects `ctx.context.output` with format-aware output primitives (table, tree, list, kv).
 * When action handlers use these methods, auto-output skips to avoid double output.
 *
 * Included in the default extensions. Can also be applied per-command:
 * ```ts
 * createPadrone('my-cli')
 *   .command('users', (c) =>
 *     c.extend(padroneAutoOutput({ output: 'table' }))
 *       .action(() => fetchUsers())
 *   )
 * ```
 */
export function padroneAutoOutput(options?: PadroneAutoOutputOptions): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = options?.disabled
    ? defineInterceptor({ ...autoOutputMeta, disabled: true }, () => ({}))
    : createAutoOutputInterceptor(options?.output, options?.errorOutput, options?.errorStack);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
