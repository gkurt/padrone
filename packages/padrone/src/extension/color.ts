import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { ColorTheme } from '../output/colorizer.ts';
import { colorThemes } from '../output/colorizer.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import { frameworkFlags, parseWithFallback, rawInputFlag, toFlag } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const FORCE_VALUES = new Set(['true', '1', 'always', 'on', 'yes']);

/** Applies `--color[=value]`; an unknown theme throws, unless `lenient` (the input didn't parse, so another error is reported). */
function applyColorFlag(runtime: ResolvedPadroneRuntime, color: unknown, lenient = false) {
  const auto = runtime.format === 'auto';
  const keyword = typeof color === 'string' ? color.toLowerCase() : color;
  if (keyword === 'auto') return;
  if (keyword === 'never' || toFlag(color) === false) {
    if (auto || runtime.format === 'ansi' || runtime.format === 'console') runtime.format = 'text';
    return;
  }
  if (typeof keyword === 'string' && !FORCE_VALUES.has(keyword)) {
    if (!Object.hasOwn(colorThemes, keyword)) {
      if (lenient) return;
      const message = `Unknown color theme "${color}". Expected auto, always, never or a theme: ${Object.keys(colorThemes).join(', ')}`;
      throw new ValidationError(message, [{ path: ['color'], message }]);
    }
    runtime.theme = keyword as ColorTheme;
  }
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
          if (color !== undefined) applyColorFlag(ctx.runtime, color, true);
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
 * - `--color=<theme>` → force colors with the named theme (`default`, `ocean`, `warm` or `monochrome`; any other value is an error)
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
