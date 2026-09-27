import { ConfigError } from '../core/errors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneCommand } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { getRootCommand } from '../util/utils.ts';
import { programEnvVar } from './utils.ts';

type ConfigData = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

/** Where and how the built-in loader looks beyond the first file in cwd (`searchParents`, `packageJson`, `merge`, `extends`). */
export type ConfigSearchOptions = {
  parents?: boolean;
  packageJsonKey?: string;
  /** Merge every config found instead of using the first one. */
  merge?: boolean;
  /** Set to `false` to not follow `extends` keys. */
  extends?: boolean;
  /** Environment that locates the user config directory (`XDG_CONFIG_HOME`, `HOME`, `APPDATA`). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

// Lazily resolved Node.js modules — cached after first import to keep loadConfig sync after initialization.
let _fs: typeof import('node:fs') | undefined;
let _path: typeof import('node:path') | undefined;
let _url: typeof import('node:url') | undefined;
let _createRequire: typeof import('node:module').createRequire | undefined;

async function initNodeModules(): Promise<void> {
  if (_fs && _path && _url && _createRequire) return;
  _fs = await import('node:fs');
  _path = await import('node:path');
  _url = await import('node:url');
  _createRequire = (await import('node:module')).createRequire;
}

// Eagerly start caching node modules so loadConfig is sync by the time it's called.
try {
  if (typeof process !== 'undefined') initNodeModules();
} catch {
  // Non-CLI environments (browser, edge) — ignore
}

type NodeModules = { fs: typeof import('node:fs'); path: typeof import('node:path') };

/** The user config directory (`program.dirs.config`); `XDG_CONFIG_HOME` is honored on every platform. */
function getUserConfigDir(appName: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!env.XDG_CONFIG_HOME && !env.HOME && !env.USERPROFILE) return undefined;
  return getProgramDirs(appName, env).config;
}

// ── Finding config files ────────────────────────────────────────────────

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

/**
 * The config files to load, lowest precedence first: the user config directory, then the searched directories from
 * the farthest to cwd. Each directory contributes its first matching file (or `package.json` key).
 * Without `merge`, only the highest-precedence one.
 */
function findConfigs(
  { fs, path }: NodeModules,
  cwd: string,
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): FoundConfig[] {
  // A single path comes from `--config`: it must exist, and it's the only config
  if (typeof files === 'string') {
    const abs = path.isAbsolute(files) ? files : path.resolve(cwd, files);
    if (!fs.existsSync(abs)) throw new ConfigError(`Config file not found: ${abs}`);
    return [{ file: abs }];
  }

  const found: FoundConfig[] = [];
  const inDir = (dir: string, packageJsonKey?: string): FoundConfig | undefined => {
    for (const candidate of files) {
      const abs = path.isAbsolute(candidate) ? candidate : path.resolve(dir, candidate);
      if (fs.existsSync(abs)) return { file: abs };
    }
    const pkg = path.join(dir, 'package.json');
    if (packageJsonKey && fs.existsSync(pkg) && packageJsonHasKey(fs, pkg, packageJsonKey)) return { file: pkg, key: packageJsonKey };
    return undefined;
  };

  // Nearest first: cwd (and its parents with `searchParents`), then the user config directory
  for (const dir of search?.parents ? ancestorDirs(path, cwd) : [cwd]) {
    const config = inDir(dir, search?.packageJsonKey);
    if (!config || found.some((f) => f.file === config.file)) continue;
    found.push(config);
    if (!search?.merge) return found;
  }
  const userDir = xdgAppName ? getUserConfigDir(xdgAppName, search?.env) : undefined;
  const userConfig = userDir ? inDir(userDir) : undefined;
  if (userConfig && !found.some((f) => f.file === userConfig.file)) found.push(userConfig);

  return (search?.merge ? found : found.slice(0, 1)).reverse();
}

// ── Reading config files ────────────────────────────────────────────────

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

export function parseConfigText(content: string, ext: string, file: string): ConfigData {
  const bun = (globalThis as { Bun?: BunParsers }).Bun;
  // Editors on Windows may save a byte order mark, which YAML and TOML parsers would read as part of the first key
  const text = content.replace(/^\uFEFF/, '');
  // Anything else (`.json`, `.jsonc`, extensionless rc files) is JSON with comments and trailing commas
  const json = ext !== '.yaml' && ext !== '.yml' && ext !== '.toml';
  const parser = json ? bun?.JSONC : ext === '.toml' ? bun?.TOML : bun?.YAML;
  if (!parser && !json) {
    throw new ConfigError(`Cannot read ${file}: ${ext.slice(1).toUpperCase()} config files need Bun, or a custom \`loadConfig\``);
  }
  // An empty file, or one with only comments, is an empty config
  if (json && !stripJsonc(text).trim()) return {};
  try {
    return ((parser ? parser.parse(text) : JSON.parse(stripJsonc(text))) ?? {}) as ConfigData;
  } catch (err) {
    throw new ConfigError(`Invalid config file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);

export function isConfigObject(value: unknown): value is ConfigData {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readConfig({ fs, path }: NodeModules, { file, key }: FoundConfig): MaybePromise<ConfigData> {
  const check = (data: unknown): ConfigData => {
    if (isConfigObject(data)) return data;
    throw new ConfigError(`Invalid config in ${file}${key ? `: "${key}"` : ''} must be an object`);
  };
  if (key) return check(parseConfigText(fs.readFileSync(file, 'utf-8'), '.json', file)[key]);

  const ext = path.extname(file).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) {
    // A file URL: Node's ESM loader rejects Windows paths like `C:\...`
    const specifier = _url ? _url.pathToFileURL(file).href : file;
    return import(/* @vite-ignore */ specifier).then((mod) => check(mod.default ?? mod));
  }
  // Unknown extensions are read as JSON (comments and trailing commas allowed)
  return check(parseConfigText(fs.readFileSync(file, 'utf-8'), ext, file));
}

// ── Merging and `extends` ───────────────────────────────────────────────

/** Objects merge key by key; anything else (arrays included) is replaced by `override`. */
export function deepMerge(base: ConfigData, override: ConfigData): ConfigData {
  const merged: ConfigData = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = merged[key];
    merged[key] = isConfigObject(current) && isConfigObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/**
 * A config with a profile applied: `profiles.<name>` overrides the top-level values, and the `profiles` and `profile` keys
 * are removed. `name` defaults to the config's `profile` key. Throws a `ConfigError` for an unknown profile.
 */
export function applyProfile(data: ConfigData, name?: string): ConfigData {
  const { profiles, profile, ...base } = data;
  const selected = name || (typeof profile === 'string' ? profile : undefined);
  if (!selected) return base;
  const values = isConfigObject(profiles) && Object.hasOwn(profiles, selected) ? profiles[selected] : undefined;
  if (isConfigObject(values)) return deepMerge(base, values);
  const names = isConfigObject(profiles) ? Object.keys(profiles) : [];
  throw new ConfigError(
    `Unknown profile "${selected}"${names.length ? `. Available profiles: ${names.join(', ')}` : ': no profiles are defined'}`,
  );
}

/** The commands from the root's first subcommand down to `command`. */
export function commandChain(command: AnyPadroneCommand): AnyPadroneCommand[] {
  const chain: AnyPadroneCommand[] = [];
  for (let current: AnyPadroneCommand | undefined = command; current?.parent; current = current.parent) chain.unshift(current);
  return chain;
}

/** The subcommand names of a command, which name sections in a config with `sections`. */
function sectionNames(command: AnyPadroneCommand): Set<string> {
  return new Set((command.commands ?? []).map((c) => c.name).filter(Boolean));
}

/**
 * A config's values for `command` with per-command sections: top-level values, overridden by the section of each command
 * on the way (`serve: { ... }`, `db: { migrate: { ... } }`). A key that names a subcommand is always its section, never a value.
 */
export function applySections(data: ConfigData, command: AnyPadroneCommand): ConfigData {
  const without = (values: ConfigData, parent: AnyPadroneCommand) => {
    const names = sectionNames(parent);
    return Object.fromEntries(Object.entries(values).filter(([key]) => !names.has(key)));
  };
  let values = without(data, getRootCommand(command));
  let level: unknown = data;
  for (const current of commandChain(command)) {
    level = isConfigObject(level) && Object.hasOwn(level, current.name) ? level[current.name] : undefined;
    if (!isConfigObject(level)) break;
    values = deepMerge(values, without(level, current));
  }
  return values;
}

/** A file path for messages: relative to cwd when inside it. */
export function displayPath(file: string): string {
  if (!_path || typeof process === 'undefined' || !_path.isAbsolute(file)) return file;
  const relative = _path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') && !_path.isAbsolute(relative) ? relative : file;
}

/** The environment variable that selects a profile by default: `my-cli` → `MY_CLI_PROFILE`. */
export function profileEnvVar(programName: string): string {
  return programEnvVar(programName, 'PROFILE');
}

/** Runs `step` over `items` in order, waiting for each only when it returns a promise. */
function reduceMaybe<T, A>(items: readonly T[], initial: A, step: (acc: A, item: T) => MaybePromise<A>): MaybePromise<A> {
  let acc: MaybePromise<A> = initial;
  for (const item of items) acc = thenMaybe(acc, (value) => step(value, item));
  return acc;
}

/** `./base.json` and `/abs/base.json` relative to the extending file; package names through Node's resolution. */
function resolveExtends({ fs, path }: NodeModules, specifier: string, from: string): string {
  const relative = specifier.startsWith('.') || path.isAbsolute(specifier);
  let resolved: string | undefined;
  if (relative) resolved = path.resolve(path.dirname(from), specifier);
  else {
    try {
      resolved = _createRequire?.(from).resolve(specifier);
    } catch {
      resolved = undefined;
    }
  }
  if (!resolved || !fs.existsSync(resolved)) throw new ConfigError(`Config file not found: ${specifier} (extended by ${from})`);
  return resolved;
}

/** Reads a config and the configs it `extends` (in order, each overridden by the next and by the config itself). */
function loadWithExtends(modules: NodeModules, found: FoundConfig, followExtends: boolean, chain: string[] = []): MaybePromise<ConfigData> {
  if (chain.includes(found.file)) throw new ConfigError(`Circular config extends: ${[...chain, found.file].join(' -> ')}`);
  return thenMaybe(readConfig(modules, found), (config) => {
    if (!followExtends || config.extends === undefined) return config;
    const { extends: bases, ...own } = config;
    const list = Array.isArray(bases) ? bases : [bases];
    if (!list.every((base): base is string => typeof base === 'string')) {
      throw new ConfigError(`Invalid config in ${found.file}: "extends" must be a path or a list of paths`);
    }
    const merged = reduceMaybe(list, {} as ConfigData, (acc, base) => {
      const file = resolveExtends(modules, base, found.file);
      // Data configs never run code: a JSON config in an untrusted directory can't import a script
      if (isScriptConfigFile(file) && (found.key || !isScriptConfigFile(found.file))) {
        throw new ConfigError(`Invalid config in ${found.file}: "extends" names ${base}, and only a script config can extend a script`);
      }
      return thenMaybe(loadWithExtends(modules, { file }, followExtends, [...chain, found.file]), (data) => deepMerge(acc, data));
    });
    return thenMaybe(merged, (base) => deepMerge(base, own));
  });
}

/** A config that was loaded: its file (and `package.json` key) and its data, with `extends` resolved. */
export type ConfigLayer = FoundConfig & { data: ConfigData };

/** The configs `loadConfig` merges, lowest precedence first. Empty in non-CLI environments. */
export function loadConfigLayers(files: string | string[], xdgAppName?: string, search?: ConfigSearchOptions): MaybePromise<ConfigLayer[]> {
  if (typeof process === 'undefined') return [];
  const load = () => {
    const modules = { fs: _fs!, path: _path! };
    const followExtends = search?.extends !== false;
    return reduceMaybe(findConfigs(modules, process.cwd(), files, xdgAppName, search), [] as ConfigLayer[], (layers, config) =>
      thenMaybe(loadWithExtends(modules, config, followExtends), (data) => [...layers, { ...config, data }]),
    );
  };
  if (_fs && _path) return load();
  return initNodeModules().then(load, () => []);
}

/** A custom `loadConfig` of `padroneConfig()`. */
export type ConfigLoader = (
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
) => ConfigData | undefined | Promise<ConfigData | undefined>;

/** Loaded configs, merged: with the custom loader (`data` only), else with the built-in one (`layers` too). */
export function loadConfigData(
  loader: ConfigLoader | undefined,
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): MaybePromise<{ data?: ConfigData; layers?: ConfigLayer[] }> {
  if (loader) return thenMaybe(loader(files, xdgAppName, search), (data) => ({ data }));
  return thenMaybe(loadConfigLayers(files, xdgAppName, search), (layers) => ({
    data: layers.length === 0 ? undefined : layers.reduce<ConfigData>((acc, layer) => deepMerge(acc, layer.data), {}),
    layers,
  }));
}

export function getPath(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (isConfigObject(value) && Object.hasOwn(value, key) ? value[key] : undefined), data);
}

/**
 * Built-in config file loader. Directly accesses the file system.
 * Returns `undefined` in non-CLI environments where `node:fs` is unavailable.
 * Throws a `ConfigError` when an explicit `--config` file is missing or a config file can't be parsed.
 */
export function loadConfig(
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): MaybePromise<ConfigData | undefined> {
  return thenMaybe(loadConfigData(undefined, files, xdgAppName, search), ({ data }) => data);
}

const NON_JSON_EXTENSIONS = new Set(['.yaml', '.yml', '.toml', ...SCRIPT_EXTENSIONS]);

/** A file's lowercased extension (`.json`), or `''`. */
export function configFileExtension(file: string): string {
  return /\.[^./\\]+$/.exec(file)?.[0].toLowerCase() ?? '';
}

/** Whether a config file is read as JSON (`.json`, `.jsonc`, extensionless rc files), so it can be written back. */
export function isJsonConfigFile(file: string): boolean {
  return !NON_JSON_EXTENSIONS.has(configFileExtension(file));
}

/** Whether a config file is a script (`.js`, `.ts`, …) that is imported rather than parsed. */
export function isScriptConfigFile(file: string): boolean {
  return SCRIPT_EXTENSIONS.has(configFileExtension(file));
}

/**
 * The project config file (`config --local`): the first of `files` in cwd (or, with `parents`, the nearest parent that has one),
 * else the first relative one that `creatable` accepts, in cwd.
 */
export async function findLocalConfigFile(
  files: readonly string[],
  parents: boolean,
  creatable: (file: string) => boolean = isJsonConfigFile,
): Promise<string | undefined> {
  await initNodeModules();
  const cwd = process.cwd();
  const names = files.filter((file) => !_path!.isAbsolute(file));
  for (const dir of parents ? ancestorDirs(_path!, cwd) : [cwd]) {
    const found = names.map((name) => _path!.join(dir, name)).find((file) => _fs!.existsSync(file));
    if (found) return found;
  }
  const name = names.find(creatable);
  return name && _path!.join(cwd, name);
}

/**
 * The user config directory and the file in it that `config set` writes: the first of `files` found there,
 * else the first relative one that `creatable` accepts (JSON by default). `undefined` when the directory can't be located.
 */
export async function findUserConfigFile(
  files: readonly string[],
  appName: string,
  env?: Record<string, string | undefined>,
  creatable: (file: string) => boolean = isJsonConfigFile,
): Promise<{ dir: string; file?: string } | undefined> {
  await initNodeModules();
  const dir = getUserConfigDir(appName, env);
  if (!dir) return undefined;
  const candidates = files.filter((file) => !_path!.isAbsolute(file)).map((file) => _path!.join(dir, file));
  return { dir, file: candidates.find((file) => _fs!.existsSync(file)) ?? candidates.find(creatable) };
}
