/** Standard per-user directories for a program, from `program.dirs`. None of them are created. */
export type PadroneDirs = {
  /** Settings the user edits. Linux `~/.config/<app>`, macOS `~/Library/Application Support/<app>`, Windows `%APPDATA%\<app>`. */
  config: string;
  /** Data that can be deleted and rebuilt. Linux `~/.cache/<app>`, macOS `~/Library/Caches/<app>`, Windows `%LOCALAPPDATA%\<app>\Cache`. */
  cache: string;
  /** Data the program keeps. Linux `~/.local/share/<app>`, macOS `~/Library/Application Support/<app>`, Windows `%LOCALAPPDATA%\<app>\Data`. */
  data: string;
  /** State that persists between runs (history, last run). Linux `~/.local/state/<app>`, macOS `~/Library/Application Support/<app>`, Windows `%LOCALAPPDATA%\<app>\State`. */
  state: string;
  /** Log files. Linux `~/.local/state/<app>/log`, macOS `~/Library/Logs/<app>`, Windows `%LOCALAPPDATA%\<app>\Log`. */
  log: string;
};

/**
 * The standard directories for `appName` on `platform` (defaults to the current one), like env-paths.
 * `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` are honored on every platform when set.
 */
export function getProgramDirs(
  appName: string,
  env: Record<string, string | undefined>,
  platform: string | undefined = globalThis.process?.platform,
): PadroneDirs {
  const windows = platform === 'win32';
  const join = (...parts: string[]) => parts.join(windows ? '\\' : '/');
  const home = env.HOME || env.USERPROFILE || '.';
  const xdg = (name: string) => env[`XDG_${name}_HOME`];

  const dirs: PadroneDirs = windows
    ? (() => {
        const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return {
          config: join(env.APPDATA || join(home, 'AppData', 'Roaming'), appName),
          cache: join(local, appName, 'Cache'),
          data: join(local, appName, 'Data'),
          state: join(local, appName, 'State'),
          log: join(local, appName, 'Log'),
        };
      })()
    : platform === 'darwin'
      ? {
          config: join(home, 'Library', 'Application Support', appName),
          cache: join(home, 'Library', 'Caches', appName),
          data: join(home, 'Library', 'Application Support', appName),
          state: join(home, 'Library', 'Application Support', appName),
          log: join(home, 'Library', 'Logs', appName),
        }
      : {
          config: join(home, '.config', appName),
          cache: join(home, '.cache', appName),
          data: join(home, '.local', 'share', appName),
          state: join(home, '.local', 'state', appName),
          log: join(home, '.local', 'state', appName, 'log'),
        };

  const configHome = xdg('CONFIG');
  const cacheHome = xdg('CACHE');
  const dataHome = xdg('DATA');
  const stateHome = xdg('STATE');
  if (configHome) dirs.config = join(configHome, appName);
  if (cacheHome) dirs.cache = join(cacheHome, appName);
  if (dataHome) dirs.data = join(dataHome, appName);
  if (stateHome) {
    dirs.state = join(stateHome, appName);
    if (!windows && platform !== 'darwin') dirs.log = join(stateHome, appName, 'log');
  }
  return dirs;
}
