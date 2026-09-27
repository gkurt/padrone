import { ConfigError } from '../core/errors.ts';
import { thenMaybe } from '../core/results.ts';
import { getProgramDirs } from '../util/dirs.ts';

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
function getUserConfigDir(appName: string): string | undefined {
  const env = process.env;
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
  const userDir = xdgAppName ? getUserConfigDir(xdgAppName) : undefined;
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

function parseConfigText(text: string, ext: string, file: string): ConfigData {
  const bun = (globalThis as { Bun?: BunParsers }).Bun;
  // Anything else (`.json`, `.jsonc`, extensionless rc files) is JSON with comments and trailing commas
  const parser = ext === '.yaml' || ext === '.yml' ? bun?.YAML : ext === '.toml' ? bun?.TOML : bun?.JSONC;
  if (!parser && (ext === '.yaml' || ext === '.yml' || ext === '.toml')) {
    throw new ConfigError(`Cannot read ${file}: ${ext.slice(1).toUpperCase()} config files need Bun, or a custom \`loadConfig\``);
  }
  try {
    return (parser ? parser.parse(text) : JSON.parse(stripJsonc(text))) as ConfigData;
  } catch (err) {
    throw new ConfigError(`Invalid config file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);

function isConfigObject(value: unknown): value is ConfigData {
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
    const merged = reduceMaybe(list, {} as ConfigData, (acc, base) =>
      thenMaybe(
        loadWithExtends(modules, { file: resolveExtends(modules, base, found.file) }, followExtends, [...chain, found.file]),
        (data) => deepMerge(acc, data),
      ),
    );
    return thenMaybe(merged, (base) => deepMerge(base, own));
  });
}

function loadConfigSync(
  modules: NodeModules,
  files: string | string[],
  xdgAppName?: string,
  search?: ConfigSearchOptions,
): MaybePromise<ConfigData | undefined> {
  const found = findConfigs(modules, process.cwd(), files, xdgAppName, search);
  if (found.length === 0) return undefined;
  const followExtends = search?.extends !== false;
  return reduceMaybe(found, {} as ConfigData, (acc, config) =>
    thenMaybe(loadWithExtends(modules, config, followExtends), (data) => deepMerge(acc, data)),
  );
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
  if (typeof process === 'undefined') return undefined;
  if (_fs && _path) return loadConfigSync({ fs: _fs, path: _path }, files, xdgAppName, search);
  return initNodeModules().then(
    () => loadConfigSync({ fs: _fs!, path: _path! }, files, xdgAppName, search),
    () => undefined,
  );
}
