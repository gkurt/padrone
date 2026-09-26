import { thenMaybe } from '#src/core/results.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { UpdateCheckConfig } from '../feature/update-check.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import { getVersion } from '../util/utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

function createUpdateCheckInterceptor(config: UpdateCheckConfig) {
  return defineInterceptor(
    { id: 'padrone:update-check', name: 'padrone:update-check', order: 1000, options: { 'update-check': 'flag' } },
    () => {
      let checkPromise: Promise<(() => void) | undefined> | undefined;
      let suppressed = false;

      return {
        start(ctx, next) {
          const rootCommand = ctx.command;
          const runtime = ctx.runtime;

          checkPromise = Promise.resolve(getVersion(rootCommand.version)).then((currentVersion) =>
            import('../feature/update-check.ts').then(({ createUpdateChecker }) =>
              createUpdateChecker(rootCommand.name, currentVersion, config, runtime),
            ),
          );

          return next();
        },
        parse(_ctx, next) {
          return thenMaybe(next(), (res) => {
            if ('update-check' in res.rawArgs) {
              if (res.rawArgs['update-check'] === false) suppressed = true;
              delete res.rawArgs['update-check'];
            }
            return res;
          });
        },
        shutdown(_ctx, next) {
          const result = next();
          if (suppressed || !checkPromise) return result;

          // Try to show notification synchronously if the check already resolved
          let resolved: (() => void) | undefined | null = null;
          checkPromise.then(
            (fn) => {
              resolved = fn;
            },
            () => {
              resolved = undefined;
            },
          );

          if (resolved !== null) {
            (resolved as (() => void) | undefined)?.();
          }

          return result;
        },
      };
    },
  );
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds background update checking:
 * - Checks for newer versions on npm (or custom registry) in the background
 * - Shows an update notification after command execution
 * - Respects `--no-update-check` flag to suppress
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneUpdateCheck({ packageName: 'my-cli' }))
 * ```
 */
export function padroneUpdateCheck(config: UpdateCheckConfig = {}): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(createUpdateCheckInterceptor(config))) as any;
}
