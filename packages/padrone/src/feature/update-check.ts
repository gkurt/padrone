import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
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
   * Defaults to `~/.config/<programName>-update-check.json`.
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
};

type CacheData = {
  lastCheck: number;
  latestVersion: string;
};

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
    if (typeof data.lastCheck === 'number' && typeof data.latestVersion === 'string') {
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
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
  } catch {
    // Ignore errors — cache is best-effort
  }
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

const FETCH_TIMEOUT_MS = 3000;

/**
 * Fetches the version a dist-tag (`latest` by default, or e.g. `next`) points to on the registry.
 * Resolves `undefined` when the registry can't be reached or doesn't know the package.
 */
export async function fetchLatestVersion(packageName: string, registry: string, tag = 'latest'): Promise<string | undefined> {
  const url =
    registry === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}/${encodeURIComponent(tag)}`
      : registry;

  try {
    // A slow registry must not keep the CLI from exiting
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as Record<string, unknown>;

    // Custom endpoint may return { "dist-tags": { latest: "x.y.z", next: "..." } }
    const distTags = data['dist-tags'] as Record<string, string> | undefined;
    if (distTags?.[tag]) return distTags[tag];

    // npm registry returns { version: "x.y.z" }
    if (typeof data.version === 'string') return data.version;
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
  const updateCommand = typeof command === 'function' ? command(packageName, latestVersion) : (command ?? `npm update -g ${packageName}`);
  return `\n  Update available: ${currentVersion} \u2192 ${latestVersion}\n  Run "${updateCommand}" to update\n`;
}

/**
 * Checks for updates. Resolves to a function that prints the update notification
 * when a newer version is available (from the cache when it is fresh, otherwise from the registry).
 */
export async function createUpdateChecker(
  programName: string,
  currentVersion: string,
  config: UpdateCheckConfig,
  runtime: ResolvedPadroneRuntime,
): Promise<() => void> {
  const packageName = config.packageName ?? programName;
  const registry = config.registry ?? 'npm';
  const intervalMs = parseInterval(config.interval ?? '1d');
  const disableEnvVar = config.disableEnvVar ?? `${programName.toUpperCase().replace(/-/g, '_')}_NO_UPDATE_CHECK`;

  // Check if disabled
  const env = runtime.env();
  if (isCI(env) || env.NO_UPDATE_NOTIFIER) return noop;
  if (env[disableEnvVar]) return noop;
  if (runtime.terminal && !runtime.terminal.isTTY) return noop;

  const defaultCachePath = `~/.config/${programName}-update-check.json`;
  const cachePath = await resolveCachePath(config.cache ?? defaultCachePath);
  const notifier = (latestVersion: string | undefined) =>
    latestVersion && isNewerVersion(currentVersion, latestVersion)
      ? () => runtime.error(formatUpdateMessage(currentVersion, latestVersion, packageName, config.updateCommand))
      : noop;

  // Checked recently: use the cached version
  const cached = await readCache(cachePath);
  if (cached && Date.now() - cached.lastCheck < intervalMs) return notifier(cached.latestVersion);

  // A failed check is cached too, so an offline machine doesn't wait for the registry on every run
  const latestVersion = await fetchLatestVersion(packageName, registry);
  await writeCache(cachePath, { lastCheck: Date.now(), latestVersion: latestVersion ?? cached?.latestVersion ?? '' });
  return notifier(latestVersion ?? cached?.latestVersion);
}

function noop() {}
