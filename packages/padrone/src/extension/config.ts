import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
import { ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { frameworkFlags } from './utils.ts';

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
   * Custom config loader. When provided, replaces the built-in file system loader.
   * Useful for testing or non-CLI environments.
   */
  loadConfig?: (
    files: string | string[],
    xdgAppName?: string,
    search?: ConfigSearchOptions,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

/** Where the built-in loader looks beyond cwd, from `searchParents` and `packageJson`. */
export type ConfigSearchOptions = { parents?: boolean; packageJsonKey?: string };

// ── File system config loader ───────────────────────────────────────────

// Lazily resolved Node.js modules — cached after first import to keep loadConfig sync after initialization.
let _fs: typeof import('node:fs') | undefined;
let _path: typeof import('node:path') | undefined;
let _url: typeof import('node:url') | undefined;

async function initNodeModules(): Promise<void> {
  if (_fs && _path && _url) return;
  _fs = await import('node:fs');
  _path = await import('node:path');
  _url = await import('node:url');
}

// Eagerly start caching node modules so loadConfig is sync by the time it's called.
try {
  if (typeof process !== 'undefined') initNodeModules();
} catch {
  // Non-CLI environments (browser, edge) — ignore
}

function getUserConfigDir(path: typeof import('node:path'), appName: string): string | undefined {
  const platform = process.platform;

  // Respect XDG_CONFIG_HOME on all platforms when explicitly set
  const xdgHome = process.env.XDG_CONFIG_HOME;
  if (xdgHome) return path.join(xdgHome, appName);

  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return undefined;

  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, appName) : path.join(home, 'AppData', 'Roaming', appName);
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName);

  // Linux and other Unix — default XDG path
  return path.join(home, '.config', appName);
}

/** A config file, or a `package.json` whose `key` holds the config. */
type FoundConfig = { file: string; key?: string };

/** `package.json` at `file` has `key` (an unreadable one counts as not having it). */
function packageJsonHasKey(fs: typeof import('node:fs'), file: string, key: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return !!data && typeof data === 'object' && Object.hasOwn(data, key);
  } catch {
    return false;
  }
}

/** `dir`, then each of its parents up to the filesystem root. */
function* ancestorDirs(path: typeof import('node:path'), dir: string): Generator<string> {
  for (let current = dir, parent = path.dirname(dir); ; current = parent, parent = path.dirname(parent)) {
    yield current;
    if (parent === current) return;
  }
}

function resolveConfigPath(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  cwd: string,
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): FoundConfig | undefined {
  // A single path comes from `--config`: it must exist
  if (typeof files === 'string') {
    const abs = path.isAbsolute(files) ? files : path.resolve(cwd, files);
    if (!fs.existsSync(abs)) throw new ConfigError(`Config file not found: ${abs}`);
    return { file: abs };
  }

  // Search in cwd (and its parents with `searchParents`) first
  for (const dir of search?.parents ? ancestorDirs(path, cwd) : [cwd]) {
    for (const candidate of files) {
      const abs = path.isAbsolute(candidate) ? candidate : path.resolve(dir, candidate);
      if (fs.existsSync(abs)) return { file: abs };
    }
    const key = search?.packageJsonKey;
    const pkg = path.join(dir, 'package.json');
    if (key && fs.existsSync(pkg) && packageJsonHasKey(fs, pkg, key)) return { file: pkg, key };
  }

  // Then search in the user config directory (XDG / platform-specific)
  if (xdgAppName) {
    const configDir = getUserConfigDir(path, xdgAppName);
    if (configDir) {
      for (const candidate of files) {
        const abs = path.join(configDir, candidate);
        if (fs.existsSync(abs)) return { file: abs };
      }
    }
  }

  return undefined;
}

/** Removes comments and trailing commas so JSONC parses with `JSON.parse` (runtimes without a native JSONC parser). */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const startIndex = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(startIndex, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
    } else if (ch === ',' && /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
      // trailing comma
    } else {
      out += ch;
    }
  }
  return out;
}

type BunParsers = {
  YAML?: { parse(text: string): unknown };
  TOML?: { parse(text: string): unknown };
  JSONC?: { parse(text: string): unknown };
};

function parseConfigText(text: string, ext: string, file: string): Record<string, unknown> {
  const bun = (globalThis as { Bun?: BunParsers }).Bun;
  const parser =
    ext === '.yaml' || ext === '.yml'
      ? bun?.YAML
      : ext === '.toml'
        ? bun?.TOML
        : ext === '.json' || ext === '.jsonc'
          ? bun?.JSONC
          : undefined;
  if (!parser && (ext === '.yaml' || ext === '.yml' || ext === '.toml')) {
    throw new ConfigError(`Cannot read ${file}: ${ext.slice(1).toUpperCase()} config files need Bun, or a custom \`loadConfig\``);
  }
  try {
    return (parser ? parser.parse(text) : JSON.parse(ext === '.jsonc' || ext === '.json' ? stripJsonc(text) : text)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new ConfigError(`Invalid config file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

function loadConfigSync(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined> {
  const found = resolveConfigPath(fs, path, process.cwd(), files, xdgAppName, search);
  if (!found) return undefined;
  const absolutePath = found.file;
  if (found.key) {
    const data = parseConfigText(fs.readFileSync(absolutePath, 'utf-8'), '.json', absolutePath)[found.key];
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    throw new ConfigError(`Invalid config in ${absolutePath}: "${found.key}" must be an object`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs' || ext === '.ts' || ext === '.cts' || ext === '.mts') {
    // A file URL: Node's ESM loader rejects Windows paths like `C:\...`
    const specifier = _url ? _url.pathToFileURL(absolutePath).href : absolutePath;
    return import(/* @vite-ignore */ specifier).then((mod) => mod.default ?? mod);
  }
  // Unknown extensions are read as JSON
  return parseConfigText(fs.readFileSync(absolutePath, 'utf-8'), ext, absolutePath);
}

/**
 * Built-in config file loader. Directly accesses the file system.
 * Returns `undefined` in non-CLI environments where `node:fs` is unavailable.
 * Throws a `ConfigError` when an explicit `--config` file is missing or a config file can't be parsed.
 */
function loadConfig(
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined> {
  if (typeof process === 'undefined') return undefined;
  if (_fs && _path) return loadConfigSync(_fs, _path, files, xdgAppName, search);
  return initNodeModules().then(
    () => loadConfigSync(_fs!, _path!, files, xdgAppName, search),
    () => undefined,
  );
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that handles config file loading, validation, and merging into command arguments.
 *
 * Features:
 * - `--config` / `-c` flag for explicit config file path (can be disabled via `flag: false`)
 * - Auto-detection of config files from a list of candidate names, optionally in parent directories (`searchParents`)
 *   and in a `package.json` key (`packageJson`)
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
          options?.searchParents || packageJsonKey ? { parents: options?.searchParents, packageJsonKey } : undefined;

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
