import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues, coerceArgs } from '../core/args.ts';
import { isBuiltinCommand } from '../core/commands.ts';
import { ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { HelpArgumentInfo } from '../output/formatter.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorValidateContext, PadroneSchema } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ConfigSource } from './config-command.ts';
import { addConfigCommand } from './config-command.ts';
import type { ConfigLayer, ConfigLoader, ConfigSearchOptions } from './config-loader.ts';
import { applyProfile, applySections, commandChain, displayPath, getPath, loadConfigData, profileEnvVar } from './config-loader.ts';
import { addedPaths, frameworkFlags, isRemoteCaller, valuesForCommand, withIssueSources } from './utils.ts';

export type { ConfigSearchOptions } from './config-loader.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneConfigProfilesOptions = {
  /** The flag that selects a profile. Defaults to `'profile'` (`--profile work`). */
  flag?: string;
  /** The environment variable that selects a profile. Defaults to `<PROGRAM>_PROFILE` (program `my-cli` → `MY_CLI_PROFILE`). */
  env?: string;
  /**
   * Let remote callers (serve, MCP, `tool()`) pick a profile with the flag. By default it's an unknown option for them,
   * like `--config`, so a request can't switch to another profile's values. Defaults to `false`.
   */
  remote?: boolean;
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
   * order). `true`, or `{ flag, env, remote }` to rename the flag and the variable. Defaults to `false`.
   */
  profiles?: boolean | PadroneConfigProfilesOptions;
  /**
   * Per-command sections, like viper and cobra: in `{ "port": 8080, "serve": { "port": 3000 }, "db": { "migrate": { ... } } }`
   * a key that names a subcommand is that command's section, and its values override the ones above it for that command
   * (and its subcommands). With sections, such a key is never an option value. Defaults to `false`.
   */
  sections?: boolean;
  /** Also fill the options of built-in commands (`help`, `version`, `serve`, …). Defaults to `false`. */
  builtins?: boolean;
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
  loadConfig?: ConfigLoader;
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
 * - Per-command sections (`sections: true`): `serve: { ... }` applies to `serve`
 * - A `config` command (`command: true`) to get, set, list and edit the user config file
 * - Optional schema validation and transformation of config data
 * - Directly accesses the file system (gracefully no-ops in non-CLI environments)
 *
 * Config values have the lowest precedence (CLI > stdin > env > config). Only keys the command has options for are applied
 * (option names, aliases or kebab-case names), so a program-wide config file works for every command; `null` means unset.
 * Numbers and booleans are coerced to the option's type like CLI input (YAML `name: 123` for a string gives `"123"`), and a
 * validation error about a value from a config file names it: `… (from config.json)`. Built-in commands aren't filled.
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
  const profiles = options?.profiles ? (options.profiles === true ? {} : options.profiles) : undefined;
  const profileFlag = profiles ? (profiles.flag ?? 'profile') : undefined;
  const sections = !!options?.sections;
  const skips = (command: AnyPadroneCommand) => !options?.builtins && isBuiltinCommand(command);

  const source: ConfigSource = {
    files: configFiles ?? [],
    schema: configSchema,
    loadConfig: options?.loadConfig,
    profileFlag,
    sections,
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

  const helpOptions = (command: AnyPadroneCommand): HelpArgumentInfo[] => {
    if (skips(command)) return [];
    const config: HelpArgumentInfo = {
      name: 'config',
      flags: ['c'],
      type: 'string',
      valueName: 'file',
      optional: true,
      description: 'Config file to load',
    };
    const profile: HelpArgumentInfo = {
      name: profileFlag!,
      type: 'string',
      optional: true,
      description: 'Config profile to use',
      env: source.profileEnv(command),
    };
    return [...(flagEnabled ? [config] : []), ...(profileFlag ? [profile] : [])];
  };

  /** The file a value at `path` (in the values for `command`) comes from: the last layer that sets it, or the nearest object it's in. */
  const sourceOf = (layers: ConfigLayer[] | undefined, command: AnyPadroneCommand, profile: string | undefined, explicit?: string) => {
    const chain = commandChain(command).map((c) => c.name);
    const sectionPaths = sections ? chain.map((_, i) => chain.slice(0, i + 1)) : [];
    const prefixes = [[], ...sectionPaths].flatMap((section) => [section, ...(profile ? [['profiles', profile, ...section]] : [])]);
    const sets = (layer: ConfigLayer, path: readonly string[]) =>
      prefixes.some((prefix) => getPath(layer.data, [...prefix, ...path]) !== undefined);
    return (path: readonly string[]) => {
      if (!layers?.length) return explicit ?? 'config file';
      for (let length = path.length; length > 0; length--) {
        const layer = layers.findLast((l) => sets(l, path.slice(0, length)));
        if (layer) return displayPath(layer.file);
      }
      return displayPath(layers.at(-1)!.file);
    };
  };

  const interceptor = defineInterceptor(
    {
      id: 'padrone:config',
      name: 'padrone:config',
      order: CONFIG_ORDER,
      async: true,
      ...((flagEnabled || profileFlag) && {
        options: { ...(flagEnabled && { config: 'value', c: 'value' }), ...(profileFlag && { [profileFlag]: 'value' }) },
        helpOptions,
      }),
      ...(inherit === false && { inherit: false }),
    },
    () => ({
      validate(ctx: InterceptorValidateContext, next) {
        const flags = frameworkFlags(ctx.rawArgs, ctx.command);
        // Remote callers can't make the program read (or import) a local file, or pick a profile unless allowed:
        // for them these flags stay unknown options.
        const remote = isRemoteCaller(ctx.caller);
        let explicitConfigPath: string | undefined;
        if (flagEnabled && !remote) {
          explicitConfigPath = (flags.get('config') ?? flags.get('c')) as string | undefined;
          if (typeof explicitConfigPath === 'string') flags.delete('config', 'c');
        }

        let profile: string | undefined;
        if (profileFlag) {
          const value = remote && !profiles?.remote ? undefined : flags.get(profileFlag);
          if (value !== undefined) {
            flags.delete(profileFlag);
            if (typeof value !== 'string' || !value) throw new ConfigError(`--${profileFlag} needs a profile name`);
            profile = value;
          }
          profile ||= ctx.runtime.env()[source.profileEnv(ctx.command)] || undefined;
        }

        // Skip entirely for built-in commands and when there's nothing to load
        const nothingToLoad = !explicitConfigPath && !configFiles && !packageJsonOption;
        if (skips(ctx.command) || (nothingToLoad && !profile)) return next();

        // Load config data: explicit --config flag takes priority, then auto-detect
        const { xdgAppName, search } = source.locate(ctx.command, ctx.runtime.env());
        const loaded = nothingToLoad
          ? {}
          : loadConfigData(options?.loadConfig, explicitConfigPath ?? configFiles ?? [], xdgAppName, search);

        return thenMaybe(loaded, ({ data: loadedData, layers }) => {
          const withProfile = profileFlag && (loadedData || profile) ? applyProfile(loadedData ?? {}, profile) : loadedData;
          if (!withProfile) return next();
          const configData = sections ? applySections(withProfile, ctx.command) : withProfile;
          const selected = profile ?? (typeof loadedData?.profile === 'string' ? loadedData.profile : undefined);
          const fromFile = sourceOf(layers, ctx.command, selected, explicitConfigPath);

          const fill = (values: Record<string, unknown>) => {
            const rawArgs = applyValues(ctx.rawArgs, valuesForCommand(ctx.command, values, ctx.positionalArgs));
            return thenMaybe(next({ rawArgs }), (result) => withIssueSources(result, addedPaths(ctx.rawArgs, rawArgs), fromFile));
          };
          if (!configSchema) return fill(configData);

          const validated = configSchema['~standard'].validate(coerceArgs(configData, configSchema as PadroneSchema));
          return thenMaybe(validated, (result) => {
            if (result.issues) {
              const files = layers?.length ? ` ${layers.map((layer) => displayPath(layer.file)).join(', ')}` : '';
              throw new ConfigError(`Invalid config file${files}:\n${formatIssueMessages(result.issues)}`, {
                command: ctx.command.path || ctx.command.name,
              });
            }
            return fill(result.value as Record<string, unknown>);
          });
        });
      },
    }),
  );

  return ((builder: AnyPadroneBuilder) => {
    const result = builder.intercept(interceptor);
    return commandName ? addConfigCommand(result, commandName, source, disabledInterceptor) : result;
  }) as any;
}
