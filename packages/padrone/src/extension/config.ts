import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
import { ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ConfigSearchOptions } from './config-loader.ts';
import { loadConfig } from './config-loader.ts';
import { frameworkFlags } from './utils.ts';

export type { ConfigSearchOptions } from './config-loader.ts';

// ── Types ────────────────────────────────────────────────────────────────

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
   * - `false` — disable (default).
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

/**
 * Extension that handles config file loading, validation, and merging into command arguments.
 *
 * Features:
 * - `--config` / `-c` flag for explicit config file path (can be disabled via `flag: false`)
 * - Auto-detection of config files from a list of candidate names, optionally in parent directories (`searchParents`),
 *   in a `package.json` key (`packageJson`) and in the user config directory (`xdg`)
 * - Layered configs: `merge: true` merges every config found, and `extends` keys pull in base configs
 * - Optional schema validation and transformation of config data
 * - Directly accesses the file system (gracefully no-ops in non-CLI environments)
 *
 * Config values have the lowest precedence (CLI > stdin > env > config).
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
  if (options?.disabled) {
    const disabled = defineInterceptor({ id: 'padrone:config', name: 'padrone:config', order: -999, disabled: true }, () => ({}));
    return ((builder: AnyPadroneBuilder) => builder.intercept(disabled)) as any;
  }

  const configFiles = options?.files ? (Array.isArray(options.files) ? options.files : [options.files]) : undefined;
  const configSchema = options?.schema;
  const flagEnabled = options?.flag !== false;
  const inherit = options?.inherit;
  const xdgOption = options?.xdg;
  const packageJsonOption = options?.packageJson;
  const configLoader = options?.loadConfig ?? loadConfig;

  const interceptor = defineInterceptor(
    {
      id: 'padrone:config',
      name: 'padrone:config',
      order: -999,
      ...(flagEnabled && { options: { config: 'value', c: 'value' } }),
      ...(inherit === false && { inherit: false }),
    },
    () => ({
      validate(ctx: InterceptorValidateContext, next) {
        // Extract --config / -c from rawArgs
        let explicitConfigPath: string | undefined;
        if (flagEnabled) {
          const flags = frameworkFlags(ctx.rawArgs, ctx.command);
          explicitConfigPath = (flags.get('config') ?? flags.get('c')) as string | undefined;
          if (typeof explicitConfigPath === 'string') flags.delete('config', 'c');
        }

        // Skip entirely when there's nothing to load
        if (!explicitConfigPath && !configFiles && !packageJsonOption) return next();

        // `true` → the root command's name, string → as-is
        const programName = () => getRootCommand(ctx.command).name;
        const xdgAppName = typeof xdgOption === 'string' ? xdgOption : xdgOption === true ? programName() : undefined;
        const packageJsonKey =
          typeof packageJsonOption === 'string' ? packageJsonOption : packageJsonOption === true ? programName() : undefined;
        const search: ConfigSearchOptions | undefined =
          options?.searchParents || packageJsonKey || options?.merge || options?.extends === false
            ? {
                parents: options?.searchParents,
                packageJsonKey,
                merge: options?.merge,
                ...(options?.extends === false && { extends: false }),
              }
            : undefined;

        // Load config data: explicit --config flag takes priority, then auto-detect
        const configDataOrPromise = configLoader(explicitConfigPath ?? configFiles ?? [], xdgAppName, search);

        const applyConfig = (configData: Record<string, unknown> | undefined) => {
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
              const mergedRawArgs = applyValues(ctx.rawArgs, validatedData);
              return next({ rawArgs: mergedRawArgs });
            });
          }

          // No schema — pass through as-is
          const mergedRawArgs = applyValues(ctx.rawArgs, configData);
          return next({ rawArgs: mergedRawArgs });
        };

        return thenMaybe(configDataOrPromise, applyConfig);
      },
    }),
  );

  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
