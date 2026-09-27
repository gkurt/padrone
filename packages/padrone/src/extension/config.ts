import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
import { ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorValidateContext } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ConfigSource } from './config-command.ts';
import { addConfigCommand } from './config-command.ts';
import type { ConfigSearchOptions } from './config-loader.ts';
import { applyProfile, loadConfig, profileEnvVar } from './config-loader.ts';
import { frameworkFlags, isRemoteCaller, valuesForCommand } from './utils.ts';

export type { ConfigSearchOptions } from './config-loader.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneConfigProfilesOptions = {
  /** The flag that selects a profile. Defaults to `'profile'` (`--profile work`). */
  flag?: string;
  /** The environment variable that selects a profile. Defaults to `<PROGRAM>_PROFILE` (program `my-cli` → `MY_CLI_PROFILE`). */
  env?: string;
};

export type PadroneConfigOptions = {
  /** Config file names to auto-detect (e.g. `['config.json', '.myapprc']`). First found is used. */
  files?: string | string[];
  /** Schema to validate and transform config file data into the args shape. */
  schema?: StandardSchemaV1;
  /** Disable this extension. */
  disabled?: boolean;
  /** Whether to add `--config` / `-c` flag support. Defaults to `true`. */
  flag?: boolean;
  /** Whether subcommands inherit this interceptor. Defaults to `true`. */
  inherit?: boolean;
  /**
   * Search for config files in the user's platform-specific config directory.
   * - `true` — use the program name as the subdirectory (e.g. program `'myapp'` → `~/.config/myapp/`).
   * - `string` — use a custom app name as the subdirectory.
   * - `false` — disable (default, or `true` with `command`).
   *
   * Directories searched (after cwd):
   * - **Linux**: `$XDG_CONFIG_HOME/<app>` or `~/.config/<app>`
   * - **macOS**: `~/Library/Application Support/<app>` (or `$XDG_CONFIG_HOME/<app>` when set)
   * - **Windows**: `%APPDATA%\<app>`
   *
   * Config files found in cwd always take precedence over XDG paths.
   */
  xdg?: string | boolean;
  /**
   * Also search the parent directories of cwd, nearest first, like cosmiconfig and lilconfig do
   * (so a config at the project root applies in its subdirectories). Defaults to `false`.
   */
  searchParents?: boolean;
  /**
   * Read config from a key of `package.json` in a searched directory, after its config files:
   * `true` uses the program name (`{ "my-cli": { ... } }`), a string names the key. Defaults to `false`.
   */
  packageJson?: string | boolean;
  /**
   * Merge every config found instead of using the first: the user config directory (`xdg`), then the searched
   * directories from the farthest to cwd, each overriding the last (like git's global and local config).
   * Objects merge key by key; arrays are replaced. An explicit `--config` file is still used alone. Defaults to `false`.
   */
  merge?: boolean;
  /**
   * Follow `extends` keys in config files: `"extends": "./base.json"` (or a list, or a package name) loads those configs
   * first, relative to the extending file, and the file's own values override them. Defaults to `true`.
   */
  extends?: boolean;
  /**
   * Named sets of values, like AWS's `--profile`: `profiles: { <name>: { ... } }` in a config overrides its top-level values
   * when selected by `--profile <name>`, the `<PROGRAM>_PROFILE` environment variable or a top-level `profile` key (in that
   * order). `true`, or `{ flag, env }` to rename the flag and the variable. Defaults to `false`.
   */
  profiles?: boolean | PadroneConfigProfilesOptions;
  /**
   * Add a command that manages the user config file, like `git config`: `config get|set|unset|list|path|edit`.
   * `true` names it `config`, a string names it. With it, `xdg` defaults to `true` and `files` to `['config.json']`,
   * so what `config set` writes is loaded. Defaults to `false`.
   */
  command?: boolean | string;
  /**
   * Custom config loader. When provided, replaces the built-in file system loader.
   * Useful for testing or non-CLI environments.
   */
  loadConfig?: (
    files: string | string[],
    xdgAppName?: string,
    search?: ConfigSearchOptions,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

// ── Extension ────────────────────────────────────────────────────────────

/** Inside env (-1000), so env values win, and outside interactive (-999), so values from config aren't prompted for. */
const CONFIG_ORDER = -999.5;

const disabledInterceptor = defineInterceptor(
  { id: 'padrone:config', name: 'padrone:config', order: CONFIG_ORDER, disabled: true },
  () => ({}),
);

/**
 * Extension that handles config file loading, validation, and merging into command arguments.
 *
 * Features:
 * - `--config` / `-c` flag for explicit config file path (can be disabled via `flag: false`)
 * - Auto-detection of config files from a list of candidate names, optionally in parent directories (`searchParents`),
 *   in a `package.json` key (`packageJson`) and in the user config directory (`xdg`)
 * - Layered configs: `merge: true` merges every config found, and `extends` keys pull in base configs
 * - Profiles (`profiles: true`): `--profile <name>` applies a config's `profiles.<name>` values
 * - A `config` command (`command: true`) to get, set, list and edit the user config file
 * - Optional schema validation and transformation of config data
 * - Directly accesses the file system (gracefully no-ops in non-CLI environments)
 *
 * Config values have the lowest precedence (CLI > stdin > env > config). Only keys the command has options for are applied
 * (option names, aliases or kebab-case names), so a program-wide config file works for every command; `null` means unset.
 *
 * Not included in the default built-in extensions — must be explicitly added:
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneConfig({
 *     files: ['config.json', '.myapprc'],
 *     schema: z.object({ port: z.number(), host: z.string() }),
 *   }))
 * ```
 */
export function padroneConfig(options?: PadroneConfigOptions): <T extends CommandTypesBase>(builder: T) => WithAsync<T> {
  if (options?.disabled) return ((builder: AnyPadroneBuilder) => builder.intercept(disabledInterceptor)) as any;

  const commandName = options?.command === true ? 'config' : options?.command || undefined;
  const configFiles = options?.files
    ? Array.isArray(options.files)
      ? options.files
      : [options.files]
    : commandName
      ? ['config.json']
      : undefined;
  const configSchema = options?.schema;
  const flagEnabled = options?.flag !== false;
  const inherit = options?.inherit;
  const xdgOption = options?.xdg ?? !!commandName;
  const packageJsonOption = options?.packageJson;
  const configLoader = options?.loadConfig ?? loadConfig;
  const profiles = options?.profiles ? (options.profiles === true ? {} : options.profiles) : undefined;
  const profileFlag = profiles ? (profiles.flag ?? 'profile') : undefined;

  const source: ConfigSource = {
    files: configFiles ?? [],
    schema: configSchema,
    loadConfig: options?.loadConfig,
    profileFlag,
    profileEnv: (command) => profiles?.env ?? profileEnvVar(getRootCommand(command).name),
    locate(command: AnyPadroneCommand, env: Record<string, string | undefined>) {
      // `true` → the root command's name, string → as-is
      const programName = getRootCommand(command).name;
      const xdgAppName = typeof xdgOption === 'string' ? xdgOption : xdgOption ? programName : undefined;
      const packageJsonKey =
        typeof packageJsonOption === 'string' ? packageJsonOption : packageJsonOption === true ? programName : undefined;
      const searching = options?.searchParents || packageJsonKey || options?.merge || options?.extends === false || xdgAppName;
      const search: ConfigSearchOptions | undefined = searching
        ? {
            parents: options?.searchParents,
            packageJsonKey,
            merge: options?.merge,
            ...(options?.extends === false && { extends: false }),
            ...(xdgAppName && { env }),
          }
        : undefined;
      return { xdgAppName, search };
    },
  };

  const interceptor = defineInterceptor(
    {
      id: 'padrone:config',
      name: 'padrone:config',
      order: CONFIG_ORDER,
      async: true,
      ...((flagEnabled || profileFlag) && {
        options: { ...(flagEnabled && { config: 'value', c: 'value' }), ...(profileFlag && { [profileFlag]: 'value' }) },
      }),
      ...(profileFlag && {
        helpOptions: (command: AnyPadroneCommand) => [
          { name: profileFlag, type: 'string', optional: true, description: 'Config profile to use', env: source.profileEnv(command) },
        ],
      }),
      ...(inherit === false && { inherit: false }),
    },
    () => ({
      validate(ctx: InterceptorValidateContext, next) {
        const flags = frameworkFlags(ctx.rawArgs, ctx.command);
        // Extract --config / -c from rawArgs. Remote callers can't point at local files: for them it's an unknown option
        let explicitConfigPath: string | undefined;
        if (flagEnabled && !isRemoteCaller(ctx.caller)) {
          explicitConfigPath = (flags.get('config') ?? flags.get('c')) as string | undefined;
          if (typeof explicitConfigPath === 'string') flags.delete('config', 'c');
        }

        let profile: string | undefined;
        if (profileFlag) {
          const value = flags.get(profileFlag);
          if (value !== undefined) {
            flags.delete(profileFlag);
            if (typeof value !== 'string' || !value) throw new ConfigError(`--${profileFlag} needs a profile name`);
            profile = value;
          }
          profile ||= ctx.runtime.env()[source.profileEnv(ctx.command)] || undefined;
        }

        // Skip entirely when there's nothing to load
        const nothingToLoad = !explicitConfigPath && !configFiles && !packageJsonOption;
        if (nothingToLoad && !profile) return next();

        // Load config data: explicit --config flag takes priority, then auto-detect
        const { xdgAppName, search } = source.locate(ctx.command, ctx.runtime.env());
        const configDataOrPromise = nothingToLoad ? undefined : configLoader(explicitConfigPath ?? configFiles ?? [], xdgAppName, search);

        const applyConfig = (loaded: Record<string, unknown> | undefined) => {
          const configData = profileFlag && (loaded || profile) ? applyProfile(loaded ?? {}, profile) : loaded;
          if (!configData) return next();

          // Validate against schema if provided
          if (configSchema) {
            const validated = configSchema['~standard'].validate(configData);
            return thenMaybe(validated, (result) => {
              if (result.issues) {
                throw new ConfigError(`Invalid config file:\n${formatIssueMessages(result.issues)}`, {
                  command: ctx.command.path || ctx.command.name,
                });
              }
              const validatedData = result.value as Record<string, unknown>;
              return next({ rawArgs: applyValues(ctx.rawArgs, valuesForCommand(ctx.command, validatedData, ctx.positionalArgs)) });
            });
          }

          // No schema — the keys this command has options for
          return next({ rawArgs: applyValues(ctx.rawArgs, valuesForCommand(ctx.command, configData, ctx.positionalArgs)) });
        };

        return thenMaybe(configDataOrPromise, applyConfig);
      },
    }),
  );

  return ((builder: AnyPadroneBuilder) => {
    const result = builder.intercept(interceptor);
    return commandName ? addConfigCommand(result, commandName, source, disabledInterceptor) : result;
  }) as any;
}
