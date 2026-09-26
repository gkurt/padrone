import { thenMaybe } from '#src/core/results.ts';
import { resolveCommand } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand, getVersion } from '../util/utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type VersionCommand = PadroneCommand<'version', '', PadroneSchema<void>, string, [], [], false>;

export type WithVersion<T> = WithCommand<T, 'version', VersionCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

const versionInterceptor = defineInterceptor(
  { id: 'padrone:version', name: 'padrone:version', order: -1000, options: { version: 'flag', v: 'flag', V: 'flag' } },
  () => ({
    parse(_ctx, next) {
      return thenMaybe(next(), (res) => {
        const hasVersionFlag = res.rawArgs.version || res.rawArgs.v || res.rawArgs.V;

        // Only show version for root command (no subcommand matched)
        if (hasVersionFlag && !res.command.parent) {
          delete res.rawArgs.version;
          delete res.rawArgs.v;
          delete res.rawArgs.V;

          // Route to the version command so its action handles the rest
          const versionCmd = res.command.commands?.find((c) => c.name === 'version');
          if (versionCmd) {
            resolveCommand(versionCmd);
            return { ...res, command: versionCmd, rawArgs: {}, positionalArgs: [] };
          }
        }

        return res;
      });
    },
  }),
);

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds version support:
 * - `version` command
 * - `--version` / `-v` / `-V` flags (root command only)
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneVersion())
 * ```
 */
export function padroneVersion(): <T extends CommandTypesBase>(builder: T) => WithVersion<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command('version', (c) =>
        c.configure({ description: 'Display the version number', hidden: true }).action((_args, ctx) => {
          const rootCommand = getRootCommand(ctx.command);
          return getVersion(rootCommand.version);
        }),
      )
      .intercept(versionInterceptor)) as any;
}
