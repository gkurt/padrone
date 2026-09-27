import { thenMaybe } from '#src/core/results.ts';
import { resolveCommand } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { getInterceptorOptionNames } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, PadroneCommand, PadroneCommandConfig } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand, getVersion } from '../util/utils.ts';
import { frameworkFlags, passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** What `version --verbose` shows: the program's version and the environment it runs in, plus `info` fields. */
export type PadroneVersionInfo = {
  name: string;
  version: string;
  runtime: string;
  platform: string;
  arch: string;
  shell?: string;
  [key: string]: string | undefined;
};

/** The version, or with `--verbose` the version info: text, or an object under JSON output (e.g. `--json`). */
export type VersionCommand = PadroneCommand<
  'version',
  '',
  PadroneSchema<{ verbose?: boolean }>,
  string | PadroneVersionInfo | Promise<string | PadroneVersionInfo>,
  [],
  [],
  false
>;

export type WithVersion<T> = WithCommand<T, 'version', VersionCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

export type PadroneVersionOptions = {
  /**
   * Flags that show the version: long names (`'version'` → `--version`) and single characters.
   * Long flags work on every command that doesn't define an option of that name; single characters only on the root
   * command, since subcommands often use `-v` for verbose. Defaults to `['version', 'v', 'V']`.
   * Pass `[]` to keep only the `version` command.
   */
  flags?: readonly string[];
  /**
   * Extra fields for `version --verbose`, e.g. `() => ({ 'API endpoint': config.apiUrl })`.
   * Fields that are `undefined` are left out.
   */
  info?: (command: AnyPadroneCommand) => Record<string, string | undefined> | Promise<Record<string, string | undefined>>;
};

const DEFAULT_VERSION_FLAGS = ['version', 'v', 'V'] as const;

// ── Version info ────────────────────────────────────────────────────────

function runtimeName(): string {
  const g = globalThis as { Bun?: { version: string }; Deno?: { version: { deno: string } }; process?: { version?: string } };
  if (g.Bun) return `Bun ${g.Bun.version}`;
  if (g.Deno) return `Deno ${g.Deno.version.deno}`;
  return g.process?.version ? `Node.js ${g.process.version}` : 'unknown';
}

function shellName(env: Record<string, string | undefined>): string | undefined {
  const shell = env.SHELL ?? env.ComSpec;
  return shell
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '');
}

function versionInfo(
  rootCommand: AnyPadroneCommand,
  version: string,
  runtime: ResolvedPadroneRuntime,
  extra: Record<string, string | undefined> | undefined,
): PadroneVersionInfo {
  const proc = (globalThis as { process?: { platform?: string; arch?: string } }).process;
  const info: PadroneVersionInfo = {
    name: rootCommand.name,
    version,
    runtime: runtimeName(),
    platform: proc?.platform ?? 'unknown',
    arch: proc?.arch ?? 'unknown',
    shell: shellName(runtime.env()),
    ...extra,
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as PadroneVersionInfo;
}

const INFO_LABELS: Record<string, string> = { runtime: 'Runtime', platform: 'Platform', arch: 'Architecture', shell: 'Shell' };

function formatVersionInfo({ name, version, ...rest }: PadroneVersionInfo): string {
  const rows = Object.entries(rest).map(([key, value]) => [INFO_LABELS[key] ?? key, value] as const);
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [`${name} ${version}`, ...rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`)].join('\n');
}

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
          const isRoot = !res.command.parent;
          // Single-character flags only on the root command: `-v` often means verbose on subcommands
          const applicable = versionFlags.filter((flag) => isRoot || flag.length > 1);
          const hasVersionFlag = applicable.some((flag) => flags.flag(flag));
          // `--version=false` / `--no-version` is consumed without showing the version
          if (!hasVersionFlag) {
            flags.delete(...applicable.filter((flag) => flags.flag(flag) === false));
            return res;
          }

          // Route to the version command so its action handles the rest
          const versionCmd = getRootCommand(res.command).commands?.find((c) => c.name === 'version');
          if (!versionCmd) return res;
          resolveCommand(versionCmd);
          // Keep the flags extensions read (`--json`, `--no-color`, …), minus the command's own options and the version flags
          const extensionOptions = getInterceptorOptionNames(versionCmd);
          const rawArgs: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(res.rawArgs)) {
            if (flags.has(key) && extensionOptions.has(key) && !versionFlags.includes(key)) rawArgs[key] = value;
          }
          const verbose = flags.get('verbose');
          if (verbose !== undefined) rawArgs.verbose = verbose;
          return { ...res, command: versionCmd, rawArgs, positionalArgs: [] };
        });
      },
    }),
  );

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds version support:
 * - `version` command; `version --verbose` also shows the runtime, platform, architecture and shell
 * - `--version` on any command, and `-v` / `-V` on the root command (configurable with `flags`)
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
            builtin: true,
            flagNames: options.flags ?? DEFAULT_VERSION_FLAGS,
          } as PadroneCommandConfig)
          .arguments(passthroughSchema({ verbose: { type: 'boolean', description: 'Also show the runtime, platform and shell' } }))
          .action((args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            const version = getVersion(rootCommand.version);
            if (!args.verbose) return version;
            return thenMaybe(version, (resolved) =>
              thenMaybe(options.info?.(rootCommand), (extra) => {
                const info = versionInfo(rootCommand, resolved, ctx.runtime, extra);
                return ctx.runtime.format === 'json' ? info : formatVersionInfo(info);
              }),
            );
          }),
      )
      .intercept(createVersionInterceptor(options.flags ?? DEFAULT_VERSION_FLAGS))) as any;
}
