import { thenMaybe } from '#src/core/results.ts';
import type { ResolvedPadroneRuntime } from '#src/core/runtime.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { UpdateCheckConfig } from '../feature/update-check.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { getRootCommand, getVersion } from '../util/utils.ts';
import { isUpgradeCommand } from './upgrade.ts';
import { frameworkFlags } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

function createUpdateCheckInterceptor(config: UpdateCheckConfig) {
  return defineInterceptor(
    { id: 'padrone:update-check', name: 'padrone:update-check', order: 1000, options: { 'update-check': 'flag' } },
    () => {
      let check: Promise<(() => void) | undefined> | undefined;
      let flagsRead = false;

      const readFlags = (
        ctx: { caller: string; runtime: ResolvedPadroneRuntime },
        rawArgs: Record<string, unknown>,
        command: AnyPadroneCommand,
      ) => {
        flagsRead = true;
        const flags = frameworkFlags(rawArgs, command);
        const suppressed = flags.flag('update-check') === false;
        flags.delete('update-check');
        // Only people running the CLI see the notice, never right after upgrading; `--no-update-check` skips the request too
        if (suppressed || ctx.caller !== 'cli' || isUpgradeCommand(command)) return;

        const rootCommand = getRootCommand(command);
        const runtime = ctx.runtime;
        check = Promise.resolve(getVersion(rootCommand.version))
          .then((currentVersion) =>
            import('../feature/update-check.ts').then(({ createUpdateChecker }) =>
              createUpdateChecker(rootCommand.name, currentVersion, config, runtime),
            ),
          )
          .catch(() => undefined);
      };

      return {
        parse(ctx, next) {
          return thenMaybe(next(), (res) => {
            readFlags(ctx, res.rawArgs, res.command);
            return res;
          });
        },
        // Registered on a command: its parse handler doesn't run
        validate(ctx, next) {
          if (!flagsRead) readFlags(ctx, ctx.rawArgs, ctx.command);
          return next();
        },
        shutdown(_ctx, next) {
          // Printed once the check settles, after the command's own output, without holding up the result
          return thenMaybe(next(), () => {
            check?.then((notify) => notify?.());
          });
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
