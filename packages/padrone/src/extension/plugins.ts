import { commandSymbol, isPadroneProgram } from '../core/commands.ts';
import { ActionError, ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, AnyPadroneProgram, CommandTypesBase } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { readTextFile, writeTextFileAtomic } from '../util/files.ts';
import { satisfiesRange } from '../util/semver-range.ts';
import { findExecutable, pathDirs, spawnInherited } from '../util/spawn.ts';
import { getRootCommand } from '../util/utils.ts';
import { detectInstaller } from './upgrade.ts';
import { passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** Package managers `padronePlugins()` installs plugins with. */
export type PadronePluginPackageManager = 'npm' | 'bun' | 'pnpm' | 'yarn';

export type PadronePluginsOptions = {
  /**
   * Directory user-installed plugins live in: their `package.json` and `node_modules`, and `plugins.json`, the list of
   * installed and linked plugins. Defaults to `plugins` in the program's data directory (`program.dirs.data`).
   */
  dir?: string;
  /** Plugin modules the program always loads, before the user's (package names or absolute paths, imported with `import`). */
  packages?: readonly string[];
  /** Add the `plugins` command group (`list`, `install`, `uninstall`, `link`); a string names it. Defaults to `false`. */
  command?: boolean | string;
  /** Package manager `plugins install` / `uninstall` run. Defaults to bun under Bun, else the one the program was installed with. */
  packageManager?: PadronePluginPackageManager;
  /**
   * Install with the package manager's `--ignore-scripts`, so a package's install scripts don't run (the plugin's module is
   * still imported, and runs, when the program starts). Defaults to `false`.
   */
  ignoreScripts?: boolean;
  /**
   * Names that plugins installed at runtime may have: exact names, `@scope/*` or `prefix*`. Others are refused by
   * `plugins install` and skipped, with an error, when `plugins.json` lists them. Links and `packages` are always allowed.
   */
  allow?: readonly string[];
  /**
   * The plugin API version of this program. A plugin module may export `padroneApi`, the semver range it works with
   * (`'^2.0.0'`); one whose range doesn't include this version isn't loaded. Without it the range isn't checked.
   */
  apiVersion?: string;
  /** Let a plugin replace a command the program already has. Defaults to `false`: such a plugin is skipped with an error. */
  override?: boolean;
  /** Called for a plugin that fails to load, instead of printing to stderr. */
  onError?: (error: Error, plugin: { name: string }) => void;
  /** Runs a package manager command (`['npm', 'install', 'x']`) in `cwd`, resolving with its exit code. Defaults to spawning it without a shell. */
  exec?: (command: readonly string[], options: { cwd: string }) => Promise<number>;
  /** Imports a plugin module: a `file:` URL, or a package name from `packages`. Defaults to `import()`. */
  import?: (specifier: string) => Promise<unknown>;
};

/** An entry of `plugins.json`: a package installed into the plugins directory, or a linked local path. */
type PluginEntry = {
  name: string;
  spec?: string;
  link?: string;
  /** The version installed, checked when the plugin loads */
  version?: string;
  /** `sha256-<hex>` of the plugin's module file, checked when the plugin loads (not for links) */
  integrity?: string;
};

// ── Storage ──────────────────────────────────────────────────────────────

const sep = () => (globalThis.process?.platform === 'win32' ? '\\' : '/');
const join = (...parts: string[]) => parts.join(sep());

function pluginsDir(options: PadronePluginsOptions, root: AnyPadroneCommand, env: Record<string, string | undefined>): string {
  return options.dir ?? join(getProgramDirs(root.name, env).data, 'plugins');
}

const manifestPath = (dir: string) => join(dir, 'plugins.json');

/** `plugins.json`'s text, or `undefined` when there is none: synchronously once `node:fs` is loaded. */
function readManifestText(dir: string): string | undefined | Promise<string | undefined> {
  const missing = (err: unknown) => {
    if ((err as { code?: string })?.code === 'ENOENT') return undefined;
    throw err;
  };
  try {
    const text = readTextFile(manifestPath(dir));
    return text instanceof Promise ? text.catch(missing) : text;
  } catch (err) {
    return missing(err);
  }
}

function parseManifest(text: string | undefined, dir: string): PluginEntry[] {
  if (text === undefined) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid plugins file ${manifestPath(dir)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const plugins = (data as { plugins?: unknown })?.plugins;
  if (!Array.isArray(plugins)) throw new ConfigError(`Invalid plugins file ${manifestPath(dir)}: expected { "plugins": [...] }`);
  return plugins.filter(
    (entry): entry is PluginEntry => !!entry && isSafeName(entry.name) && (isSafeSpec(entry.spec) || typeof entry.link === 'string'),
  );
}

/**
 * A name that's later joined into `node_modules/<name>`, passed to the package manager and printed: no `..` segments, no
 * leading `-`, no control characters (terminal escapes).
 */
const isSafeName = (name: unknown): name is string =>
  typeof name === 'string' &&
  !!name &&
  !name.startsWith('-') &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  !/[\x00-\x1f\x7f]/.test(name) &&
  !name.split(/[\\/]/).some((part) => part === '..' || part === '.');

/** A spec from `plugins.json` reaches the package manager on `update`, so it gets the same check as `install`'s. */
const isSafeSpec = (spec: unknown): spec is string => typeof spec === 'string' && SPEC_PATTERN.test(spec);

async function readManifest(dir: string): Promise<PluginEntry[]> {
  return parseManifest(await readManifestText(dir), dir);
}

const writeManifest = (dir: string, plugins: PluginEntry[]) =>
  // The list decides which code runs at startup: written atomically, readable and writable by the user only
  writeTextFileAtomic(manifestPath(dir), `${JSON.stringify({ plugins }, null, 2)}\n`, { private: true });

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const fs = await import('node:fs');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** The `import` / `default` target of a package.json `exports` value, following conditions and the `"."` entry. */
function exportsTarget(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports;
  if (Array.isArray(exports)) return exports.map(exportsTarget).find(Boolean);
  if (!exports || typeof exports !== 'object') return undefined;
  const map = exports as Record<string, unknown>;
  if ('.' in map) return exportsTarget(map['.']);
  for (const condition of ['import', 'node', 'default']) if (condition in map) return exportsTarget(map[condition]);
  return undefined;
}

/** The module file a plugin path stands for: the file itself, or a package directory's entry point. */
async function moduleFile(path: string): Promise<string> {
  const fs = await import('node:fs');
  if (!fs.statSync(path).isDirectory()) return path;
  const pkg = await readJson(join(path, 'package.json'));
  const entry = exportsTarget(pkg?.exports) ?? pkg?.module ?? pkg?.main;
  if (typeof entry === 'string') return join(path, entry.replace(/^\.\//, ''));
  const index = ['index.js', 'index.mjs', 'index.ts'].map((name) => join(path, name)).find((file) => fs.existsSync(file));
  return index ?? join(path, 'index.js');
}

const installedPath = (dir: string, name: string) => join(dir, 'node_modules', ...name.split('/'));
const entryPath = (dir: string, entry: PluginEntry) => entry.link ?? installedPath(dir, entry.name);

/** `sha256-<hex>` of the plugin's module file */
async function fileIntegrity(file: string): Promise<string> {
  const fs = await import('node:fs');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fs.readFileSync(file)));
  return `sha256-${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether `name` matches an `allow` pattern: exact, `@scope/*` or `prefix*` */
const isAllowed = (name: string, allow: readonly string[] | undefined) =>
  !allow || allow.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

// ── Loading ──────────────────────────────────────────────────────────────

/** The command tree of a program export, also from another copy of padrone (its symbol has the same description). */
function programCommand(value: unknown): AnyPadroneCommand | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (isPadroneProgram(value)) return (value as { [commandSymbol]: AnyPadroneCommand })[commandSymbol];
  const symbol = Object.getOwnPropertySymbols(value).find((s) => s.description === commandSymbol.description);
  return symbol ? (value as Record<symbol, AnyPadroneCommand | undefined>)[symbol] : undefined;
}

const isPlugin = (value: unknown) => typeof value === 'function' || !!programCommand(value);

/** The plugin a module exports (`default`, or `plugin`): an extension function, or a program to mount under its name. */
function pluginExport(mod: unknown): unknown {
  const value = (mod as { default?: unknown })?.default ?? (mod as { plugin?: unknown })?.plugin ?? mod;
  // A CommonJS module imported as ESM: `{ default: { default: plugin } }`
  return isPlugin(value) ? value : ((value as { default?: unknown })?.default ?? value);
}

/**
 * `builder` wrapped so the names of the top-level commands defined through it are pushed to `names`, and the wrapper for
 * every builder a call returns; `unwrap` gives the real builder back.
 */
function trackCommands(builder: AnyPadroneProgram, names: string[]) {
  const originals = new WeakMap<object, AnyPadroneProgram>();
  const wrap = (target: AnyPadroneProgram): AnyPadroneProgram => {
    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (property === 'command' || property === 'mount') names.push(String([args[0]].flat()[0]));
          const result = value.apply(object, args);
          return result && typeof result === 'object' && commandSymbol in result ? wrap(result) : result;
        };
      },
    });
    originals.set(proxy, target);
    return proxy;
  };
  return { program: wrap(builder), unwrap: (value: AnyPadroneProgram) => originals.get(value) ?? value };
}

/** Applies a plugin; `defined` collects the names of the top-level commands it defines */
function applyPlugin(program: AnyPadroneProgram, plugin: unknown, name: string, defined: string[]): AnyPadroneProgram {
  if (typeof plugin === 'function') {
    const tracked = trackCommands(program, defined);
    return tracked.unwrap((plugin as (builder: AnyPadroneProgram) => AnyPadroneProgram)(tracked.program));
  }
  const command = programCommand(plugin);
  if (command) {
    defined.push(command.name);
    return program.mount(command.name, { [commandSymbol]: command } as unknown as AnyPadroneProgram) as unknown as AnyPadroneProgram;
  }
  throw new Error(`"${name}" doesn't export a padrone extension or program`);
}

const toSpecifier = async (path: string) => {
  const { pathToFileURL } = await import('node:url');
  return pathToFileURL(path).href;
};

const rootOf = (program: AnyPadroneProgram) => (program as unknown as { [commandSymbol]: AnyPadroneCommand })[commandSymbol];

async function readVersion(dir: string, entry: PluginEntry): Promise<string | undefined> {
  const pkg = await readJson(join(entryPath(dir, entry), 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : undefined;
}

// ── Extension ────────────────────────────────────────────────────────────

const PLUGINS_ID = 'padrone:plugins';
/** Outermost, so `__complete` (-3000), `--repl` and help already see the plugins' commands. */
const PLUGINS_ORDER = -3100;
/** A package spec can't start with `-`, so it's never taken as a package manager option */
const SPEC_PATTERN = /^[^-\s]/;

const managerCommands: Record<PadronePluginPackageManager, { add: string[]; remove: string[] }> = {
  npm: { add: ['npm', 'install'], remove: ['npm', 'uninstall'] },
  bun: { add: ['bun', 'add'], remove: ['bun', 'remove'] },
  pnpm: { add: ['pnpm', 'add'], remove: ['pnpm', 'remove'] },
  yarn: { add: ['yarn', 'add'], remove: ['yarn', 'remove'] },
};

function detectPackageManager(): PadronePluginPackageManager {
  if ((globalThis as { Bun?: unknown }).Bun) return 'bun';
  const installer = detectInstaller();
  return installer === 'brew' ? 'npm' : installer;
}

/** A package manager command run in `cwd`, found on `PATH` so Windows `.cmd` shims work without a shell. */
async function spawnPackageManager(command: readonly string[], options: { cwd: string }): Promise<number> {
  const env = globalThis.process?.env ?? {};
  const file = await findExecutable(command[0]!, pathDirs(env), { env });
  if (!file) throw new ActionError(`"${command[0]}" was not found on PATH`);
  return spawnInherited(file, command.slice(1), { cwd: options.cwd });
}

/** The package name in an npm spec (`@acme/x@^1` → `@acme/x`); `undefined` for URLs, paths and git specs. */
function specName(spec: string): string | undefined {
  const match = spec.match(/^(@[a-z0-9][\w.-]*\/[\w.-]+|[a-z0-9][\w.-]*)(?:@.*)?$/i);
  return match?.[1];
}

/**
 * Extension for plugins users install at runtime, like oclif's `plugins`: at startup (the start phase, before routing) it
 * loads each plugin module and applies it to the program, so its commands route, show in help and complete. A plugin module
 * default-exports a `PadroneExtension` (`(program) => program.command(...)`), or a program, mounted under its name.
 * Plugins come from `packages` and from `plugins.json` in the plugins directory; one that fails to load is reported on stderr
 * and skipped. With no plugins the run stays synchronous.
 *
 * With `command: true` it adds a `plugins` group, only available on the command line (not to serve, MCP or `tool()`):
 * - `plugins list` lists the installed and linked plugins
 * - `plugins install <package>` installs one into the plugins directory with the package manager (`npm install`, `bun add`, …)
 * - `plugins uninstall <name>` removes one
 * - `plugins link <path>` uses a local directory or file, for developing a plugin
 *
 * ```ts
 * createPadrone('my-cli').extend(padronePlugins({ command: true }))
 * // my-cli plugins install my-cli-plugin-deploy
 * ```
 */
export function padronePlugins(options: PadronePluginsOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const importModule = options.import ?? ((specifier: string) => import(specifier));
  const exec = options.exec ?? spawnPackageManager;
  const commandName = options.command === true ? 'plugins' : options.command || undefined;
  /** Programs with the plugins applied, so a run on one (e.g. in the REPL) doesn't load them again */
  const augmented = new WeakSet<object>();
  const cache = new WeakMap<object, { key: string; program: Promise<AnyPadroneProgram> }>();

  const specifierOf = async (dir: string, entry: PluginEntry | { name: string; package: string }) => {
    if (!('package' in entry)) return toSpecifier(await moduleFile(entryPath(dir, entry)));
    return /^([/\\]|[a-z]:[\\/])/i.test(entry.package) ? toSpecifier(await moduleFile(entry.package)) : entry.package;
  };
  const importEntry = async (dir: string, entry: PluginEntry | { name: string; package: string }) =>
    importModule(await specifierOf(dir, entry));
  const loadModule = async (dir: string, entry: PluginEntry | { name: string; package: string }) =>
    pluginExport(await importEntry(dir, entry));

  /** Refuses a plugin that isn't allowed, or whose installed version or module file changed since it was recorded */
  const verifyEntry = async (dir: string, entry: PluginEntry) => {
    if (entry.link) return;
    if (!isAllowed(entry.name, options.allow)) throw new Error('not in the allowed plugins');
    if (entry.version) {
      const installed = await readVersion(dir, entry);
      if (installed !== entry.version)
        throw new Error(`version ${installed ?? 'unknown'} is installed, but ${entry.version} was recorded; run \`update\``);
    }
    if (entry.integrity && (await fileIntegrity(await moduleFile(entryPath(dir, entry)))) !== entry.integrity) {
      throw new Error('its files changed since it was installed; run `update` to trust the new ones');
    }
  };

  /** Applies a plugin, checking its API range and that it doesn't replace a command the program has */
  const applyChecked = (program: AnyPadroneProgram, mod: unknown, name: string): AnyPadroneProgram => {
    const range = (mod as { padroneApi?: unknown })?.padroneApi;
    if (options.apiVersion && typeof range === 'string' && !satisfiesRange(options.apiVersion, range)) {
      throw new Error(`it needs plugin API ${range}, but this program has ${options.apiVersion}`);
    }
    const defined: string[] = [];
    const result = applyPlugin(program, pluginExport(mod), name, defined);
    if (!options.override) {
      const existing = new Set(rootOf(program).commands?.map((c) => c.name));
      const replaced = defined.find((commandName) => existing.has(commandName));
      if (replaced) throw new Error(`it would replace the "${replaced}" command`);
    }
    return result;
  };

  const load = async (program: AnyPadroneProgram, dir: string, entries: PluginEntry[], runtime: ResolvedPadroneRuntime) => {
    let result = program;
    const all = [...(options.packages ?? []).map((name) => ({ name, package: name })), ...entries];
    for (const entry of all) {
      try {
        if ('spec' in entry || 'link' in entry) await verifyEntry(dir, entry as PluginEntry);
        result = applyChecked(result, await importEntry(dir, entry), entry.name);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (options.onError) options.onError(error, { name: entry.name });
        else runtime.error(`Plugin "${entry.name}" failed to load: ${error.message}`);
      }
    }
    augmented.add(result);
    return result;
  };

  const loader = defineInterceptor({ id: PLUGINS_ID, name: PLUGINS_ID, order: PLUGINS_ORDER, async: true }, () => ({
    start(ctx, next) {
      if (augmented.has(ctx.program)) return next();
      const dir = pluginsDir(options, ctx.command, ctx.runtime.env());
      const withText = (text: string | undefined) => {
        const entries = parseManifest(text, dir);
        if (entries.length === 0 && !options.packages?.length) return next();
        const key = text ?? '';
        let cached = cache.get(ctx.program);
        if (cached?.key !== key) {
          cached = { key, program: load(ctx.program, dir, entries, ctx.runtime) };
          cache.set(ctx.program, cached);
        }
        return cached.program.then((program) =>
          next({ program, command: (program as unknown as { [commandSymbol]: AnyPadroneCommand })[commandSymbol] }),
        );
      };
      const text = readManifestText(dir);
      return text instanceof Promise ? text.then(withText) : withText(text);
    },
  }));

  return ((builder: AnyPadroneBuilder) => {
    const result = builder.intercept(loader);
    if (!commandName) return result;

    const dirOf = (command: AnyPadroneCommand, env: Record<string, string | undefined>) =>
      pluginsDir(options, getRootCommand(command), env);
    const manager = () => managerCommands[options.packageManager ?? detectPackageManager()];
    const dependencies = async (dir: string) => Object.keys((await readJson(join(dir, 'package.json')))?.dependencies ?? {});
    const version = readVersion;
    const run = async (command: readonly string[], cwd: string) => {
      const code = await exec(command, { cwd });
      if (code !== 0) throw new ActionError(`"${command.join(' ')}" failed with exit code ${code}`, { exitCode: code });
    };
    /** Fails when the module at `entry` isn't a plugin, so a broken one isn't recorded */
    const check = async (dir: string, entry: PluginEntry) => {
      const plugin = await loadModule(dir, entry);
      if (!isPlugin(plugin)) throw new Error(`"${entry.name}" doesn't export a padrone extension or program`);
    };
    /** Records the version and module file the entry has now, which are checked when it loads */
    const record = async (dir: string, entry: PluginEntry) => {
      entry.version = await readVersion(dir, entry);
      entry.integrity = await fileIntegrity(await moduleFile(entryPath(dir, entry)));
    };
    const nameField = { type: 'string', description: 'The plugin' } as const;

    return result.command(commandName, (c) =>
      c
        .configure({ description: 'Manage plugins', builtin: true })
        .command(['list', 'ls'], (l) =>
          l
            .configure({ description: 'List installed plugins' })
            .arguments(passthroughSchema({ json: { type: 'boolean', description: 'Print the plugins as JSON' } }))
            .async()
            .action(async (args, ctx) => {
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entries = await readManifest(dir);
              if (args.json) {
                return JSON.stringify(
                  [
                    ...(options.packages ?? []).map((name) => ({ name, builtIn: true })),
                    ...(await Promise.all(entries.map(async (entry) => ({ ...entry, version: await version(dir, entry) })))),
                  ],
                  null,
                  2,
                );
              }
              const rows = [
                ...(options.packages ?? []).map((name) => [name, '(built in)']),
                ...(await Promise.all(
                  entries.map(async (entry) => [
                    entry.name,
                    [await version(dir, entry), entry.link && `(link: ${entry.link})`].filter(Boolean).join(' '),
                  ]),
                )),
              ];
              if (rows.length === 0) return 'No plugins installed';
              const width = Math.max(...rows.map(([name]) => name!.length)) + 2;
              return rows.map(([name, info]) => `${name!.padEnd(width)}${info}`.trimEnd()).join('\n');
            }),
        )
        .command(['install', 'add'], (i) =>
          i
            .configure({ description: 'Install a plugin from the package registry', mutation: true })
            .arguments(passthroughSchema({ package: { type: 'string', description: 'The package, e.g. my-plugin@1.2.0' } }), {
              positional: ['package'],
            })
            .async()
            .action(async (args, ctx) => {
              const spec = args.package;
              if (!spec) throw new ActionError(`Usage: ${commandName} install <package>`);
              if (!SPEC_PATTERN.test(spec)) throw new ActionError(`Invalid package "${spec}"`);
              const fs = await import('node:fs');
              const dir = dirOf(ctx.command, ctx.runtime.env());
              fs.mkdirSync(dir, { recursive: true });
              const pkgFile = join(dir, 'package.json');
              if (!fs.existsSync(pkgFile)) {
                const root = getRootCommand(ctx.command);
                fs.writeFileSync(pkgFile, `${JSON.stringify({ name: `${root.name}-plugins`, private: true }, null, 2)}\n`, 'utf-8');
              }
              const before = new Set(await dependencies(dir));
              await run([...manager().add, ...(options.ignoreScripts ? ['--ignore-scripts'] : []), spec], dir);
              const name = (await dependencies(dir)).find((dep) => !before.has(dep)) ?? specName(spec);
              if (!name) throw new ActionError(`Couldn't tell which package "${spec}" installed`);
              const entry: PluginEntry = { name, spec };
              try {
                if (!isAllowed(name, options.allow)) throw new Error(`"${name}" is not in the allowed plugins`);
                await check(dir, entry);
                await record(dir, entry);
              } catch (err) {
                await run([...manager().remove, name], dir);
                throw new ActionError(`"${name}" isn't a plugin: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
              }
              const entries = (await readManifest(dir)).filter((e) => e.name !== name);
              await writeManifest(dir, [...entries, entry]);
              const installed = await version(dir, entry);
              return `Installed plugin ${name}${installed ? `@${installed}` : ''}`;
            }),
        )
        .command(['uninstall', 'remove', 'rm'], (u) =>
          u
            .configure({ description: 'Remove a plugin', mutation: true })
            .arguments(passthroughSchema({ name: nameField }), { positional: ['name'] })
            .async()
            .action(async (args, ctx) => {
              if (!args.name) throw new ActionError(`Usage: ${commandName} uninstall <name>`);
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entries = await readManifest(dir);
              const entry = entries.find((e) => e.name === args.name);
              if (!entry) {
                const builtIn = options.packages?.includes(args.name);
                throw new ActionError(builtIn ? `"${args.name}" is built into the program` : `No plugin "${args.name}"`);
              }
              if (!entry.link) await run([...manager().remove, entry.name], dir);
              // Read again: the package manager may have taken a while, and another run may have changed the list
              await writeManifest(
                dir,
                (await readManifest(dir)).filter((e) => e.name !== entry.name),
              );
              return `${entry.link ? 'Unlinked' : 'Uninstalled'} plugin ${entry.name}`;
            }),
        )
        .command('update', (u) =>
          u
            .configure({ description: 'Update installed plugins (all, or the named one)', mutation: true })
            .arguments(passthroughSchema({ name: { type: 'string', description: 'The plugin; all when omitted' } }), {
              positional: ['name'],
            })
            .async()
            .action(async (args, ctx) => {
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entries = await readManifest(dir);
              const targets = entries.filter((e) => !e.link && e.spec && (!args.name || e.name === args.name));
              const denied = targets.find((e) => !isAllowed(e.name, options.allow));
              if (denied) throw new ActionError(`"${denied.name}" is not in the allowed plugins`);
              if (args.name && targets.length === 0) throw new ActionError(`No installed plugin "${args.name}"`);
              if (targets.length === 0) return 'No plugins to update';
              const lines: string[] = [];
              for (const entry of targets) {
                const before = await version(dir, entry);
                await run([...manager().add, ...(options.ignoreScripts ? ['--ignore-scripts'] : []), entry.spec!], dir);
                await check(dir, entry);
                await record(dir, entry);
                lines.push(
                  entry.version === before
                    ? `${entry.name} is up to date (${before})`
                    : `${entry.name} ${before ?? '?'} → ${entry.version}`,
                );
              }
              const fresh = await readManifest(dir);
              await writeManifest(
                dir,
                fresh.map((e) => targets.find((t) => t.name === e.name) ?? e),
              );
              return lines.join('\n');
            }),
        )
        .command('info', (n) =>
          n
            .configure({ description: 'Show details of a plugin' })
            .arguments(passthroughSchema({ name: nameField }), { positional: ['name'] })
            .async()
            .action(async (args, ctx) => {
              if (!args.name) throw new ActionError(`Usage: ${commandName} info <name>`);
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entry = (await readManifest(dir)).find((e) => e.name === args.name);
              if (!entry) throw new ActionError(`No plugin "${args.name}"`);
              const pkg = await readJson(join(entryPath(dir, entry), 'package.json'));
              return [
                `Name:        ${entry.name}`,
                `Version:     ${typeof pkg?.version === 'string' ? pkg.version : 'unknown'}`,
                typeof pkg?.description === 'string' && `Description: ${pkg.description}`,
                entry.link ? `Linked from: ${entry.link}` : `Installed as: ${entry.spec}`,
                `Location:    ${entryPath(dir, entry)}`,
                entry.integrity && `Integrity:   ${entry.integrity}`,
              ]
                .filter(Boolean)
                .join('\n');
            }),
        )
        .command('link', (k) =>
          k
            .configure({ description: 'Use a plugin from a local directory or file, for developing it', mutation: true })
            .arguments(passthroughSchema({ path: { type: 'string', description: 'The plugin directory or module file' } }), {
              positional: ['path'],
            })
            .async()
            .action(async (args, ctx) => {
              if (!args.path) throw new ActionError(`Usage: ${commandName} link <path>`);
              const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
              const target = path.resolve(args.path);
              if (!fs.existsSync(target)) throw new ActionError(`${target} doesn't exist`);
              const pkg = fs.statSync(target).isDirectory() ? await readJson(path.join(target, 'package.json')) : undefined;
              const name = typeof pkg?.name === 'string' ? pkg.name : path.basename(target).replace(/\.[cm]?[jt]s$/, '');
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entry: PluginEntry = { name, link: target };
              await check(dir, entry);
              const entries = (await readManifest(dir)).filter((e) => e.name !== name);
              await writeManifest(dir, [...entries, entry]);
              return `Linked plugin ${name} → ${target}`;
            }),
        ),
    );
  }) as any;
}
