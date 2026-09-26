import { thenMaybe } from '#src/core/results.ts';
import { resolveCommand } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand, PadroneCommandConfig } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand, getVersion } from '../util/utils.ts';
import { frameworkFlags } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type VersionCommand = PadroneCommand<'version', '', PadroneSchema<void>, string, [], [], false>;

export type WithVersion<T> = WithCommand<T, 'version', VersionCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

export type PadroneVersionOptions = {
  /**
   * Flags that show the version on the root command: long names (`'version'` → `--version`) and single characters.
   * Defaults to `['version', 'v', 'V']`. Pass `[]` to keep only the `version` command.
   */
  flags?: readonly string[];
};

const DEFAULT_VERSION_FLAGS = ['version', 'v', 'V'] as const;

const createVersionInterceptor = (versionFlags: readonly string[]) =>
  defineInterceptor(
    {
      id: 'padrone:version',
      name: 'padrone:version',
      order: -1000,
      options: Object.fromEntries(versionFlags.map((flag) => [flag, 'flag' as const])),
    },
    () => ({
      parse(_ctx, next) {
        return thenMaybe(next(), (res) => {
          const flags = frameworkFlags(res.rawArgs, res.command);
          const hasVersionFlag = versionFlags.some((flag) => flags.get(flag));

          // Only show version for root command (no subcommand matched)
          if (hasVersionFlag && !res.command.parent) {
            flags.delete(...versionFlags);

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
 * - `--version` / `-v` / `-V` flags (root command only; configurable with `flags`)
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneVersion())
 * ```
 */
export function padroneVersion(options: PadroneVersionOptions = {}): <T extends CommandTypesBase>(builder: T) => WithVersion<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command('version', (c) =>
        c
          .configure({
            description: 'Display the version number',
            hidden: true,
            flagNames: options.flags ?? DEFAULT_VERSION_FLAGS,
          } as PadroneCommandConfig)
          .action((_args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            return getVersion(rootCommand.version);
          }),
      )
      .intercept(createVersionInterceptor(options.flags ?? DEFAULT_VERSION_FLAGS))) as any;
}
