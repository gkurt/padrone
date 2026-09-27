import { thenMaybe } from '#src/core/results.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ColorTheme } from '../output/colorizer.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import { frameworkFlags } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const FORCE_VALUES = new Set(['true', '1', 'always']);

const colorInterceptor = defineInterceptor(
  { id: 'padrone:color', name: 'padrone:color', order: -1001, options: { color: 'optional' } },
  () => ({
    parse(ctx, next) {
      return thenMaybe(next(), (res) => {
        const flags = frameworkFlags(res.rawArgs, res.command);
        if (!flags.has('color')) return res;
        const color = flags.get('color');
        flags.delete('color');

        const { runtime } = ctx;
        const auto = runtime.format === 'auto';
        if (color === 'auto') return res;
        if (color === false || color === 'false' || color === '0' || color === 'never') {
          if (auto || runtime.format === 'ansi' || runtime.format === 'console') runtime.format = 'text';
          return res;
        }
        if (typeof color === 'string' && !FORCE_VALUES.has(color)) runtime.theme = color as ColorTheme;
        if (auto) runtime.format = 'ansi';
        return res;
      });
    },
  }),
);

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that handles `--color` / `--no-color` flags:
 * - `--color`, `--color=true` or `--color=always` → force colors, even when output isn't a TTY
 * - `--color=false`, `--color=never` or `--no-color` → disable colors (text format)
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
