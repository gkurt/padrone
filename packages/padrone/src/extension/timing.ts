import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorMeta } from '../types/index.ts';
import { frameworkFlags, isRemoteCaller } from './utils.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(2);
  return `${mins}m ${secs}s`;
}

// ── Interceptor ─────────────────────────────────────────────────────────

const timingMeta: InterceptorMeta = {
  id: 'padrone:timing',
  name: 'padrone:timing',
  order: -1002,
  options: { timing: 'flag', time: 'flag' },
};

function createTimingInterceptor(enabledByDefault: boolean) {
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
          if (enabled && !isRemoteCaller(ctx.caller)) {
            const elapsed = performance.now() - startTime;
            ctx.runtime.error(`\nDone in ${formatDuration(elapsed)}`);
          }
          return res;
        });
      },
    };
  });
}

// ── Extension ───────────────────────────────────────────────────────────

export interface PadroneTimingOptions {
  /** Enable timing by default without requiring `--time` flag. Default: `false`. */
  enabled?: boolean;
}

/**
 * Extension that tracks command execution time.
 *
 * - `--time` / `--timing` → enables timing output
 * - `--no-time` / `--no-timing` → disables timing output
 *
 * Pass `{ enabled: true }` to enable timing by default (can be disabled via `--no-time`).
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
  return ((builder: AnyPadroneBuilder) => builder.intercept(createTimingInterceptor(options?.enabled ?? false))) as any;
}
