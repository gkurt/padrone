import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { writeTextFileAtomic } from '../util/files.ts';
import { isCI } from '../util/utils.ts';

/**
 * Configuration for the update check feature.
 */
export type UpdateCheckConfig = {
  /**
   * The npm package name to check. Defaults to the program name.
   */
  packageName?: string;
  /**
   * Registry to check for updates.
   * - `'npm'` — checks the npm registry (default)
   * - A URL string — custom registry endpoint that returns JSON with a `version` or `dist-tags.latest` field
   */
  registry?: 'npm' | string;
  /**
   * How often to check for updates. Accepts shorthand like `'1d'`, `'12h'`, `'30m'`.
   * Defaults to `'1d'` (once per day).
   */
  interval?: string;
  /**
   * Path to the cache file for storing the last check timestamp and latest version.
   * Defaults to `update-check.json` in the program's cache directory (`program.dirs.cache`, e.g. `~/.cache/<programName>`).
   */
  cache?: string;
  /**
   * Environment variable name to disable update checks (e.g. `'MYAPP_NO_UPDATE_CHECK'`).
   * When set to a truthy value, update checks are skipped.
   * Defaults to `'<PROGRAM_NAME>_NO_UPDATE_CHECK'` (uppercased, hyphens to underscores).
   */
  disableEnvVar?: string;
  /**
   * Command suggested in the notification. Defaults to `npm update -g <packageName>`.
   * Pass a function to build it from the package name and the latest version.
   */
  updateCommand?: string | ((packageName: string, latestVersion: string) => string);
  /**
   * Whether to show the notice, called when a newer version is known (after the built-in rules: CI, non-TTY output,
   * `NO_UPDATE_NOTIFIER` and `disableEnvVar` skip the check altogether). Return `false` to suppress it,
   * e.g. inside npm scripts: `({ runtime }) => !runtime.env().npm_lifecycle_event`.
   */
  shouldNotify?: (info: UpdateInfo) => boolean;
  /** The notice text (printed to stderr, and by `version --check`). Defaults to `Update available: 1.0.0 → 2.0.0` and the command to run. */
  format?: (info: UpdateInfo) => string;
};

/** A newer version, as passed to `padroneUpdateCheck({ shouldNotify, format })`. */
export type UpdateInfo = {
  packageName: string;
  /** The running version. */
  current: string;
  /** The newer version found. */
  latest: string;
  /** The command the notice suggests (see `updateCommand`). */
  updateCommand: string;
  runtime: ResolvedPadroneRuntime;
};

type CacheData = {
  lastCheck: number;
  latestVersion: string;
};

/** Whether a version from the registry or the cache looks like one, so it's safe to print and compare. */
export const isVersion = (value: unknown): value is string => typeof value === 'string' && /^v?\d[\w.+-]*$/.test(value);

/**
 * Parses an interval string like '1d', '12h', '30m', '1w' into milliseconds.
 */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)\s*(ms|s|m|h|d|w)$/);
  if (!match) return 86_400_000; // default 1d

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    case 'w':
      return value * 604_800_000;
    default:
      return 86_400_000;
  }
}

/**
 * Compares two semver version strings.
 * Returns true if `latest` is newer than `current`. Pre-releases only count as newer when `current` is one too,
 * or with `prerelease: true` (e.g. following a `next` channel).
 */
export function isNewerVersion(current: string, latest: string, options?: { prerelease?: boolean }): boolean {
  const parse = (v: string) => {
    const cleaned = v.replace(/^v/, '').replace(/\+.*$/, '');
    const dash = cleaned.indexOf('-');
    const nums = (dash === -1 ? cleaned : cleaned.slice(0, dash)).split('.').map(Number);
    return { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0, prerelease: dash === -1 ? undefined : cleaned.slice(dash + 1) };
  };

  const c = parse(current);
  const l = parse(latest);

  // Don't notify about pre-release versions unless user is already on a pre-release
  if (l.prerelease && !c.prerelease && !options?.prerelease) return false;

  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  if (l.patch !== c.patch) return l.patch > c.patch;
  // The release is newer than its own pre-releases
  if (!c.prerelease || !l.prerelease) return !!c.prerelease && !l.prerelease;
  return comparePrerelease(l.prerelease, c.prerelease) > 0;
}

/** Semver pre-release precedence: dot-separated identifiers, numeric ones compared as numbers (`beta.10` > `beta.2`). */
function comparePrerelease(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Reads the update check cache file.
 */
async function readCache(cachePath: string): Promise<CacheData | undefined> {
  try {
    const { existsSync, readFileSync } = await import('node:fs');
    if (!existsSync(cachePath)) return undefined;
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    // An empty version records a check that found none
    if (typeof data.lastCheck === 'number' && (data.latestVersion === '' || isVersion(data.latestVersion))) {
      return data as CacheData;
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

/**
 * Writes the update check cache file.
 */
async function writeCache(cachePath: string, data: CacheData): Promise<void> {
  // Best-effort: a cache that can't be written only means checking again
  await writeTextFileAtomic(cachePath, JSON.stringify(data)).catch(() => {});
}

/**
 * Resolves the cache path, expanding a leading `~` or `~/` to the home directory.
 */
async function resolveCachePath(cachePath: string): Promise<string> {
  const { homedir } = await import('node:os');
  const { resolve } = await import('node:path');
  if (cachePath === '~' || /^~[/\\]/.test(cachePath)) return resolve(homedir(), cachePath.slice(2));
  return resolve(cachePath);
}

/** The default cache file, `update-check.json` in `program.dirs.cache`, and the one older versions wrote. */
async function defaultCachePaths(programName: string, env: Record<string, string | undefined>) {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const home = env.HOME || env.USERPROFILE || homedir();
  return {
    cache: join(getProgramDirs(programName, { ...env, HOME: home }).cache, 'update-check.json'),
    legacy: join(home, '.config', `${programName}-update-check.json`),
  };
}

/** Moves the cache older versions kept in `~/.config`; an unreadable one is removed. */
async function migrateLegacyCache(legacyPath: string, cachePath: string): Promise<CacheData | undefined> {
  const data = await readCache(legacyPath);
  if (data) await writeCache(cachePath, data);
  try {
    const { rmSync } = await import('node:fs');
    rmSync(legacyPath, { force: true });
  } catch {
    // Best-effort
  }
  return data;
}

const FETCH_TIMEOUT_MS = 3000;
/** A detached refresh delays nothing, so it can wait longer for a slow registry. */
const BACKGROUND_FETCH_TIMEOUT_MS = 10_000;

function registryUrl(packageName: string, registry: string, tag: string): string {
  return registry === 'npm'
    ? `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}/${encodeURIComponent(tag)}`
    : registry;
}

/**
 * Fetches the version a dist-tag (`latest` by default, or e.g. `next`) points to on the registry.
 * Resolves `undefined` when the registry can't be reached or doesn't know the package.
 */
export async function fetchLatestVersion(packageName: string, registry: string, tag = 'latest'): Promise<string | undefined> {
  const url = registryUrl(packageName, registry, tag);
  try {
    // A slow registry must not keep the CLI from exiting
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as Record<string, unknown>;

    // A custom endpoint may return { "dist-tags": { latest: "x.y.z", next: "..." } }, the npm registry { version: "x.y.z" }
    const distTags = data['dist-tags'] as Record<string, unknown> | undefined;
    const version = distTags?.[tag] ?? data.version;
    if (typeof version === 'string') return version;
  } catch {
    // Network errors are expected (offline, firewall, etc.)
  }
  return undefined;
}

/**
 * Formats the update notification message.
 */
export function formatUpdateMessage(
  currentVersion: string,
  latestVersion: string,
  packageName: string,
  command?: UpdateCheckConfig['updateCommand'],
): string {
  return `\n  Update available: ${currentVersion} \u2192 ${latestVersion}\n  Run "${updateCommandFor(packageName, latestVersion, command)}" to update\n`;
}

const updateCommandFor = (packageName: string, latest: string, command: UpdateCheckConfig['updateCommand']) =>
  typeof command === 'function' ? command(packageName, latest) : (command ?? `npm update -g ${packageName}`);

/** The info about a newer version the `shouldNotify` and `format` callbacks get. */
export function updateInfo(
  packageName: string,
  current: string,
  latest: string,
  config: UpdateCheckConfig,
  runtime: ResolvedPadroneRuntime,
): UpdateInfo {
  return { packageName, current, latest, updateCommand: updateCommandFor(packageName, latest, config.updateCommand), runtime };
}

/** The notice for a newer version: `format`'s text, or the default message. */
export function formatUpdateNotice(info: UpdateInfo, config: UpdateCheckConfig): string {
  return config.format ? config.format(info) : formatUpdateMessage(info.current, info.latest, info.packageName, info.updateCommand);
}

/**
 * Fetches the version `tag` points to from `url` and records it in the cache `file`, keeping the cached one on failure.
 * Runs in a detached process (`refreshInBackground`), so it only uses its parameters and globals.
 */
async function refreshCacheFile(url: string, tag: string, file: string, timeout: number): Promise<void> {
  try {
    const { writeFileSync } = await import('node:fs');
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return;
    const data = (await response.json()) as { 'dist-tags'?: Record<string, unknown>; version?: unknown } | null;
    const latestVersion = data?.['dist-tags']?.[tag] ?? data?.version;
    if (typeof latestVersion === 'string') writeFileSync(file, JSON.stringify({ lastCheck: Date.now(), latestVersion }));
  } catch {
    // Offline, firewalled or an unknown package: checked again after the interval
  }
}

/**
 * Runs `refreshCacheFile` in a detached, unref'd process, like update-notifier, so a slow registry never delays the exit.
 * Resolves `undefined` when this runtime can't run a script that way (Deno, a Node single-executable app, the browser),
 * otherwise with a promise that settles when the process exits.
 */
async function refreshInBackground(args: Parameters<typeof refreshCacheFile>): Promise<{ exited: Promise<void> } | undefined> {
  const proc = globalThis.process;
  const executable = proc?.execPath?.split(/[\\/]/).pop() ?? '';
  // A compiled Bun binary runs scripts as Bun with `BUN_BE_BUN`
  if (!proc?.execPath || (!('Bun' in globalThis) && !/^node(js)?(\.exe)?$/i.test(executable))) return undefined;
  try {
    const { spawn } = await import('node:child_process');
    const script = `(${refreshCacheFile.toString()})(...JSON.parse(process.argv[process.argv.length - 1]))`;
    const child = spawn(proc.execPath, ['-e', script, JSON.stringify(args)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...proc.env, BUN_BE_BUN: '1' },
    });
    child.unref();
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    return { exited };
  } catch {
    return undefined;
  }
}

/** A started update check: `notify` prints the notice, `refresh` settles once the cache is refreshed (if it was stale). */
export type UpdateCheck = { notify: () => void; refresh: Promise<void> };

/**
 * Checks for updates without waiting for the registry: `notify` uses the cached latest version, and a stale cache is
 * refreshed in the background for the next run.
 */
export async function createUpdateChecker(
  programName: string,
  currentVersion: string,
  config: UpdateCheckConfig,
  runtime: ResolvedPadroneRuntime,
): Promise<UpdateCheck> {
  const packageName = config.packageName ?? programName;
  const intervalMs = parseInterval(config.interval ?? '1d');
  const disableEnvVar = config.disableEnvVar ?? `${programName.toUpperCase().replace(/-/g, '_')}_NO_UPDATE_CHECK`;
  const skipped: UpdateCheck = { notify: noop, refresh: Promise.resolve() };

  const env = runtime.env();
  if (isCI(env) || env.NO_UPDATE_NOTIFIER || env[disableEnvVar]) return skipped;
  if (runtime.terminal && !runtime.terminal.isTTY) return skipped;

  const defaults = config.cache ? undefined : await defaultCachePaths(programName, env);
  const cachePath = defaults?.cache ?? (await resolveCachePath(config.cache!));
  const cached = (await readCache(cachePath)) ?? (defaults && (await migrateLegacyCache(defaults.legacy, cachePath)));
  const latest = cached?.latestVersion;
  const info =
    latest && isNewerVersion(currentVersion, latest) ? updateInfo(packageName, currentVersion, latest, config, runtime) : undefined;
  const notify = info && config.shouldNotify?.(info) !== false ? () => runtime.error(formatUpdateNotice(info, config)) : noop;
  const age = cached ? Date.now() - cached.lastCheck : -1;
  if (age >= 0 && age < intervalMs) return { notify, refresh: skipped.refresh };

  // Recorded before checking, so runs in the meantime don't check too; a failed check waits for the next interval
  await writeCache(cachePath, { lastCheck: Date.now(), latestVersion: latest ?? '' });
  const url = registryUrl(packageName, config.registry ?? 'npm', 'latest');
  const background = await refreshInBackground([url, 'latest', cachePath, BACKGROUND_FETCH_TIMEOUT_MS]);
  const refresh = background?.exited ?? refreshCacheFile(url, 'latest', cachePath, FETCH_TIMEOUT_MS);
  return { notify, refresh };
}

function noop() {}
