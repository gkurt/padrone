import { commandSymbol, isPadroneProgram } from '../core/commands.ts';
import { ActionError, ConfigError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, AnyPadroneProgram, CommandTypesBase } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { readTextFile } from '../util/files.ts';
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
  /** Runs a package manager command (`['npm', 'install', 'x']`) in `cwd`, resolving with its exit code. Defaults to spawning it without a shell. */
  exec?: (command: readonly string[], options: { cwd: string }) => Promise<number>;
  /** Imports a plugin module: a `file:` URL, or a package name from `packages`. Defaults to `import()`. */
  import?: (specifier: string) => Promise<unknown>;
};

/** An entry of `plugins.json`: a package installed into the plugins directory, or a linked local path. */
type PluginEntry = { name: string; spec?: string; link?: string };

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
    (entry): entry is PluginEntry =>
      !!entry && isSafeName(entry.name) && (typeof entry.spec === 'string' || typeof entry.link === 'string'),
  );
}

/** A name that's later joined into `node_modules/<name>` and passed to the package manager: no `..` segments, no leading `-`. */
const isSafeName = (name: unknown): name is string =>
  typeof name === 'string' && !!name && !name.startsWith('-') && !name.split(/[\\/]/).some((part) => part === '..' || part === '.');

async function readManifest(dir: string): Promise<PluginEntry[]> {
  return parseManifest(await readManifestText(dir), dir);
}

async function writeManifest(dir: string, plugins: PluginEntry[]): Promise<void> {
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The list decides which code runs at startup: written atomically, readable and writable by the user only
  const temp = `${manifestPath(dir)}.${globalThis.process?.pid ?? 0}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ plugins }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(temp, manifestPath(dir));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

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

function applyPlugin(program: AnyPadroneProgram, plugin: unknown, name: string): AnyPadroneProgram {
  if (typeof plugin === 'function') return program.extend(plugin as (builder: AnyPadroneProgram) => AnyPadroneProgram);
  const command = programCommand(plugin);
  if (command)
    return program.mount(command.name, { [commandSymbol]: command } as unknown as AnyPadroneProgram) as unknown as AnyPadroneProgram;
  throw new Error(`"${name}" doesn't export a padrone extension or program`);
}

const toSpecifier = async (path: string) => {
  const { pathToFileURL } = await import('node:url');
  return pathToFileURL(path).href;
};

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
  const loadModule = async (dir: string, entry: PluginEntry | { name: string; package: string }) =>
    pluginExport(await importModule(await specifierOf(dir, entry)));

  const load = async (program: AnyPadroneProgram, dir: string, entries: PluginEntry[], runtime: ResolvedPadroneRuntime) => {
    let result = program;
    const all = [...(options.packages ?? []).map((name) => ({ name, package: name })), ...entries];
    for (const entry of all) {
      try {
        result = applyPlugin(result, await loadModule(dir, entry), entry.name);
      } catch (err) {
        runtime.error(`Plugin "${entry.name}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
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
    const version = async (dir: string, entry: PluginEntry) => {
      const pkg = await readJson(join(entryPath(dir, entry), 'package.json'));
      return typeof pkg?.version === 'string' ? pkg.version : undefined;
    };
    const run = async (command: readonly string[], cwd: string) => {
      const code = await exec(command, { cwd });
      if (code !== 0) throw new ActionError(`"${command.join(' ')}" failed with exit code ${code}`, { exitCode: code });
    };
    /** Fails when the module at `entry` isn't a plugin, so a broken one isn't recorded */
    const check = async (dir: string, entry: PluginEntry) => {
      const plugin = await loadModule(dir, entry);
      if (!isPlugin(plugin)) throw new Error(`"${entry.name}" doesn't export a padrone extension or program`);
    };
    const nameField = { type: 'string', description: 'The plugin' } as const;

    return result.command(commandName, (c) =>
      c
        .configure({ description: 'Manage plugins', builtin: true })
        .command(['list', 'ls'], (l) =>
          l
            .configure({ description: 'List installed plugins' })
            .async()
            .action(async (_args, ctx) => {
              const dir = dirOf(ctx.command, ctx.runtime.env());
              const entries = await readManifest(dir);
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
                await check(dir, entry);
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
              await writeManifest(
                dir,
                entries.filter((e) => e !== entry),
              );
              return `${entry.link ? 'Unlinked' : 'Uninstalled'} plugin ${entry.name}`;
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
