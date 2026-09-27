type NodeFs = typeof import('node:fs');
type Env = Record<string, string | undefined>;

const isWindows = (platform: string | undefined) => platform === 'win32';

/** A variable of `env` by name, ignoring case on Windows (`Path`, `PATHEXT`). */
function envValue(env: Env, name: string, platform: string | undefined): string | undefined {
  if (!isWindows(platform)) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** The directories of the `PATH` variable of `env`, in order. */
export function pathDirs(env: Env, platform: string | undefined = globalThis.process?.platform): string[] {
  const value = envValue(env, 'PATH', platform) ?? '';
  return value.split(isWindows(platform) ? ';' : ':').filter(Boolean);
}

/** The extensions an executable may have: `PATHEXT` on Windows (lowercased), otherwise none. */
function executableExtensions(env: Env, platform: string | undefined): string[] {
  if (!isWindows(platform)) return [''];
  const value = envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
  return value
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
}

const joinPath = (dir: string, name: string, platform: string | undefined) =>
  `${dir.replace(/[\\/]+$/, '')}${isWindows(platform) ? '\\' : '/'}${name}`;

function isExecutable(fs: NodeFs, file: string, platform: string | undefined): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!isWindows(platform)) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type ExecutableLookup = { env: Env; platform?: string };

/** The first executable called `name` in `dirs` (with a `PATHEXT` extension on Windows), like `which`. */
export async function findExecutable(name: string, dirs: readonly string[], lookup: ExecutableLookup): Promise<string | undefined> {
  if (!name || /[\\/]/.test(name)) return undefined;
  const fs = await import('node:fs');
  const platform = lookup.platform ?? globalThis.process?.platform;
  const extensions = executableExtensions(lookup.env, platform);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = joinPath(dir, name + ext, platform);
      if (isExecutable(fs, file, platform)) return file;
    }
  }
  return undefined;
}

/**
 * The executables in `dirs` whose names start with `prefix`, as `{ name, file }` with the prefix (and a Windows extension)
 * taken off the name; the first directory wins for a name. Synchronous, so it finds nothing where `node:fs` can't be loaded
 * synchronously.
 */
export function listExecutables(prefix: string, dirs: readonly string[], lookup: ExecutableLookup): { name: string; file: string }[] {
  const fs: NodeFs | undefined = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs || !prefix) return [];
  const platform = lookup.platform ?? globalThis.process?.platform;
  const extensions = executableExtensions(lookup.env, platform);
  const found = new Map<string, string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const ext = isWindows(platform) ? extensions.find((e) => entry.toLowerCase().endsWith(e)) : '';
      if (ext === undefined) continue;
      const name = entry.slice(prefix.length, entry.length - ext.length);
      if (!name || found.has(name)) continue;
      const file = joinPath(dir, entry, platform);
      if (isExecutable(fs, file, platform)) found.set(name, file);
    }
  }
  return [...found].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name));
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** An argument for `cmd.exe /d /s /c "…"` running a batch file: quoted for the program, cmd metacharacters `^`-escaped twice. */
function batchArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * The `[command, args, windowsVerbatimArguments]` to spawn `file` with `args`, never through a shell: on Windows a `.cmd` or
 * `.bat` file can only run under `cmd.exe`, so it gets a `cmd /d /s /c` line with every argument escaped (as cross-spawn does).
 */
export function spawnCommand(
  file: string,
  args: readonly string[],
  platform: string | undefined = globalThis.process?.platform,
  comspec = globalThis.process?.env?.ComSpec,
): [command: string, args: string[], verbatim: boolean] {
  if (!isWindows(platform) || !/\.(cmd|bat)$/i.test(file)) return [file, [...args], false];
  if (args.some((arg) => /[\r\n]/.test(arg))) throw new Error(`Can't pass an argument with a line break to ${file}`);
  const line = [file.replace(CMD_META, '^$1'), ...args.map(batchArgument)].join(' ');
  return [comspec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], true];
}

/** Runs `file` with `args` (no shell) with the terminal's stdio and resolves with its exit code (128 + n for a signal). */
export async function spawnInherited(file: string, args: readonly string[], options: { env?: Env; cwd?: string } = {}): Promise<number> {
  const [{ spawn }, os] = await Promise.all([import('node:child_process'), import('node:os')]);
  const [command, commandArgs, verbatim] = spawnCommand(file, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: options.env as NodeJS.ProcessEnv | undefined,
      cwd: options.cwd,
      windowsVerbatimArguments: verbatim,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const signalNumber = signal ? (os.constants.signals as Record<string, number>)[signal] : undefined;
      resolve(code ?? (signalNumber ? 128 + signalNumber : 1));
    });
  });
}
