import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorMeta } from '../types/index.ts';
import { frameworkFlags, isRemoteCaller } from './utils.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Rounded to what's shown before picking the unit, so 999.6ms is `1.00s` and 59.999s is `1m 0.00s`. */
function formatDuration(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  const centis = Math.round(ms / 10);
  if (centis < 6000) return `${(centis / 100).toFixed(2)}s`;
  return `${Math.floor(centis / 6000)}m ${((centis % 6000) / 100).toFixed(2)}s`;
}

const defaultFormat = ({ duration, failed }: PadroneTimingInfo) => `\n${failed ? 'Failed after' : 'Done in'} ${duration}`;

// ── Interceptor ─────────────────────────────────────────────────────────

const timingMeta: InterceptorMeta = {
  id: 'padrone:timing',
  name: 'padrone:timing',
  order: -1002,
  options: { timing: 'flag', time: 'flag' },
};

function createTimingInterceptor(enabledByDefault: boolean, format: NonNullable<PadroneTimingOptions['format']>) {
  return defineInterceptor(timingMeta, () => {
    let enabled = enabledByDefault;
    let flagsRead = false;
    // Replaced in the start phase; interceptors registered on a command only join from the route phase
    let startTime = performance.now();

    const readFlags = (rawArgs: Record<string, unknown>, command: AnyPadroneCommand) => {
      flagsRead = true;
      const flags = frameworkFlags(rawArgs, command);
      enabled = flags.flag('timing') ?? flags.flag('time') ?? enabled;
      flags.delete('timing', 'time');
    };

    return {
      start(_ctx, next) {
        startTime = performance.now();
        return next();
      },
      parse(_ctx, next) {
        return thenMaybe(next(), (res) => {
          readFlags(res.rawArgs, res.command);
          return res;
        });
      },
      // Registered on a command: its parse handler doesn't run
      validate(ctx, next) {
        if (!flagsRead) readFlags(ctx.rawArgs, ctx.command);
        return next();
      },
      shutdown(ctx, next) {
        return thenMaybe(next(), (res) => {
          // Serve and MCP handle requests; they have no terminal to report to
          if (!enabled || isRemoteCaller(ctx.caller)) return res;
          const elapsed = performance.now() - startTime;
          const failed = ctx.error !== undefined;
          const text = format({ elapsed, duration: formatDuration(elapsed), failed, ...(failed && { error: ctx.error }) });
          if (text) ctx.runtime.error(text);
          return res;
        });
      },
    };
  });
}

// ── Extension ───────────────────────────────────────────────────────────

/** What `padroneTiming({ format })` gets to build the line printed after a command. */
export type PadroneTimingInfo = {
  /** Elapsed milliseconds. */
  elapsed: number;
  /** The elapsed time as shown by default: `12ms`, `1.50s`, `1m 2.00s`. */
  duration: string;
  /** Whether the command failed. */
  failed: boolean;
  /** The error the command failed with. */
  error?: unknown;
};

export interface PadroneTimingOptions {
  /** Enable timing by default without requiring `--time` flag. Default: `false`. */
  enabled?: boolean;
  /**
   * Builds the line printed to stderr. Return `null` or `''` to print nothing.
   * Defaults to `\nDone in <duration>`, or `\nFailed after <duration>` when the command failed.
   */
  format?: (info: PadroneTimingInfo) => string | null | undefined;
}

/**
 * Extension that tracks command execution time.
 *
 * - `--time` / `--timing` → enables timing output
 * - `--no-time` / `--no-timing` → disables timing output
 *
 * Pass `{ enabled: true }` to enable timing by default (can be disabled via `--no-time`), and `format` to change the line.
 * It's printed after the command's result or error: `Done in 1.20s`, or `Failed after 1.20s`.
 *
 * Usage:
 * ```ts
 * // Opt-in via flag
 * createPadrone('my-cli').extend(padroneTiming())
 *
 * // Always on, opt-out via --no-time
 * createPadrone('my-cli').extend(padroneTiming({ enabled: true }))
 * ```
 */
export function padroneTiming(options?: PadroneTimingOptions): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = createTimingInterceptor(options?.enabled ?? false, options?.format ?? defaultFormat);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
