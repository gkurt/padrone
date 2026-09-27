import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { ColorTheme } from '../output/colorizer.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import { frameworkFlags, parseWithFallback, rawInputFlag, toFlag } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const FORCE_VALUES = new Set(['true', '1', 'always', 'on', 'yes']);

function applyColorFlag(runtime: ResolvedPadroneRuntime, color: unknown) {
  const auto = runtime.format === 'auto';
  if (color === 'auto') return;
  if (color === 'never' || toFlag(color) === false) {
    if (auto || runtime.format === 'ansi' || runtime.format === 'console') runtime.format = 'text';
    return;
  }
  if (typeof color === 'string' && !FORCE_VALUES.has(color.toLowerCase())) runtime.theme = color as ColorTheme;
  if (auto) runtime.format = 'ansi';
}

const colorInterceptor = defineInterceptor(
  // A value only with `=` (`--color=never`): a bare `--color` never takes the next word, which may be a positional
  { id: 'padrone:color', name: 'padrone:color', order: -1001, options: { color: 'flag' } },
  () => ({
    parse(ctx, next) {
      return parseWithFallback(
        next,
        (res) => {
          const flags = frameworkFlags(res.rawArgs, res.command);
          if (!flags.has('color')) return res;
          applyColorFlag(ctx.runtime, flags.get('color'));
          flags.delete('color');
          return res;
        },
        // Parsing failed (e.g. an unknown command): the error is still printed with the requested colors
        () => {
          const color = rawInputFlag(ctx.input, 'color');
          if (color !== undefined) applyColorFlag(ctx.runtime, color);
        },
      );
    },
  }),
);

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that handles `--color` / `--no-color` flags:
 * - `--color`, `--color=always` (or `true`, `1`, `on`, `yes`) → force colors, even when output isn't a TTY
 * - `--color=never` (or `false`, `0`, `off`, `no`) or `--no-color` → disable colors (text format)
 * - `--color=auto` → detect from the terminal (the default)
 * - `--color=<theme>` → force colors with the named theme
 *
 * Modifies the runtime's format and theme accordingly. An explicit non-ANSI `format` (e.g. `'json'`) is kept.
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneColor())
 * ```
 */
export function padroneColor(): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(colorInterceptor)) as any;
}
