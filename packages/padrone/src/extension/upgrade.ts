import { ActionError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { fetchLatestVersion, isNewerVersion } from '../feature/update-check.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { readTextFile, writeTextFileAtomic } from '../util/files.ts';
import { findExecutable, pathDirs, spawnInherited } from '../util/spawn.ts';
import { getRootCommand, getVersion } from '../util/utils.ts';
import { passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** Package managers `padroneUpgrade()` knows how to upgrade a global install with. */
export type PadroneInstaller = 'npm' | 'bun' | 'pnpm' | 'yarn' | 'brew';

/** What an upgrade is about to do, passed to a custom `installer`. */
export type PadroneUpgradePlan = {
  packageName: string;
  /** The running version. */
  current: string;
  /** The version being installed. */
  version: string;
  runtime: ResolvedPadroneRuntime;
  /** The package manager command about to run (`['npm', 'install', '-g', 'my-cli@2.0.0']`); unset for a custom `installer` function. */
  command?: readonly string[];
};

export type PadroneUpgradeOptions = {
  /** The npm package to upgrade. Defaults to the program name. */
  packageName?: string;
  /** Registry to read versions from: `'npm'` (default) or a URL returning `{ version }` or `{ "dist-tags": { ... } }`. */
  registry?: 'npm' | string;
  /** The dist-tag to upgrade to when no version is given, e.g. `'next'`. `--channel` overrides it. Defaults to `'latest'`. */
  channel?: string;
  /**
   * How the program is installed. Detected from its script path by default, symlinks resolved (a Homebrew cellar, `~/.bun`,
   * pnpm's or yarn's global directory, otherwise npm), then from the executable for a compiled binary. A function returns the command to run (`['npm', 'i', '-g', ...]`), or performs
   * the upgrade itself (e.g. downloading a standalone binary) and returns nothing.
   */
  installer?: PadroneInstaller | ((plan: PadroneUpgradePlan) => readonly string[] | undefined | Promise<readonly string[] | undefined>);
  /** Homebrew formula, when installed with `brew`. Defaults to the package name. `brew` only upgrades to the latest: `--to` and `--channel` fail. */
  brewFormula?: string;
  /** Name of the command. Defaults to `'upgrade'`. */
  command?: string;
  /** Runs an installer command and resolves with its exit code. Defaults to spawning it with inherited stdio. */
  exec?: (command: readonly string[]) => Promise<number>;
  /**
   * Checks the release before anything is installed (after `padroneConfirm()` asks, not on `--dry-run`), e.g. its
   * signature or provenance. Resolving `false` or throwing refuses the upgrade. A custom `installer` that downloads a
   * binary can check the bytes itself with `verifySha256()`.
   */
  verify?: (plan: PadroneUpgradePlan) => boolean | void | Promise<boolean | void>;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Whether `data` has the SHA-256 checksum `expected`: a hex digest, or a `SHA256SUMS` file (`<digest>  <file>` lines,
 * as `sha256sum` writes them) in which the line for `fileName` is used. Use it in a custom `padroneUpgrade()` installer
 * to refuse a download that doesn't match its published checksum.
 *
 * ```ts
 * const binary = new Uint8Array(await (await fetch(`${base}/my-cli-linux-x64`)).arrayBuffer());
 * const sums = await (await fetch(`${base}/SHA256SUMS`)).text();
 * if (!(await verifySha256(binary, sums, 'my-cli-linux-x64'))) throw new Error('Checksum mismatch');
 * ```
 */
export async function verifySha256(data: Uint8Array | ArrayBuffer | string, expected: string, fileName?: string): Promise<boolean> {
  const entries = expected
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^([0-9a-f]{64})(?:\s+\*?(?:\.\/)?(.+))?$/i))
    .filter((match) => !!match);
  const bare = entries.length === 1 && !entries[0]![2] ? entries[0] : undefined;
  const entry = fileName ? (entries.find((match) => match[2] === fileName) ?? bare) : entries.length === 1 ? entries[0] : undefined;
  if (!entry) return false;
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === entry[1]!.toLowerCase();
}

const toBytes = (data: Uint8Array | ArrayBuffer | string): Uint8Array<ArrayBuffer> =>
  (typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data)) as Uint8Array<ArrayBuffer>;

/** Bytes of a hex or base64 string (or the bytes themselves) */
function decodeBinary(value: Uint8Array | ArrayBuffer | string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') return toBytes(value);
  const text = value.trim();
  if (/^(?:[0-9a-f]{2})+$/i.test(text)) return Uint8Array.from(text.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}

/**
 * Whether `signature` (bytes, hex or base64) is `publicKey`'s signature of `data`. The key is a PEM `PUBLIC KEY` (SPKI) or
 * its raw bytes; the algorithm is Ed25519 (default) or `'ECDSA-P256'` (SHA-256, the raw `r || s` signature WebCrypto uses).
 * Use it in `verify` or a custom installer to check a release against the publisher's key baked into the program.
 * Resolves `false` for a signature that doesn't match or can't be read.
 *
 * ```ts
 * padroneUpgrade({ verify: async ({ version }) => verifySignature(await fetchBinary(version), await fetchSig(version), PUBLIC_KEY) })
 * ```
 */
export async function verifySignature(
  data: Uint8Array | ArrayBuffer | string,
  signature: Uint8Array | ArrayBuffer | string,
  publicKey: Uint8Array | ArrayBuffer | string,
  options: { algorithm?: 'Ed25519' | 'ECDSA-P256' } = {},
): Promise<boolean> {
  try {
    const algorithm = options.algorithm ?? 'Ed25519';
    const pem = typeof publicKey === 'string' ? publicKey.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/) : undefined;
    const keyBytes = pem ? decodeBinary(pem[1]!.replace(/\s+/g, '')) : decodeBinary(publicKey);
    const format = pem ? 'spki' : 'raw';
    const key =
      algorithm === 'Ed25519'
        ? await crypto.subtle.importKey(format, keyBytes, { name: 'Ed25519' }, false, ['verify'])
        : await crypto.subtle.importKey(format, keyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const params = algorithm === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
    return await crypto.subtle.verify(params, key, decodeBinary(signature), toBytes(data));
  } catch {
    return false;
  }
}

function installerFromPath(path: string): PadroneInstaller | undefined {
  const p = path.replace(/\\/g, '/').toLowerCase();
  // Where a JS runtime lives (e.g. Homebrew's Node) says nothing about how the program was installed
  if (/\/(node|nodejs|bun|deno)(\.exe)?$/.test(p)) return undefined;
  if (p.includes('/cellar/')) return 'brew';
  if (p.includes('/.bun/')) return 'bun';
  if (/\/pnpm\/|\/pnpm-global\//.test(p)) return 'pnpm';
  if (/\/\.yarn\/|\/yarn\/(data\/)?global\//.test(p)) return 'yarn';
  if (p.includes('/node_modules/')) return 'npm';
  return undefined;
}

/**
 * How the running program was installed: decided by the first path that tells, its script path (`process.argv[1]`),
 * then the executable (a compiled binary; a JS runtime's own path is ignored). So an npm install under Homebrew's Node
 * is npm and a pnpm install run by Bun is pnpm.
 */
export function detectInstaller(
  paths: readonly (string | undefined)[] = [globalThis.process?.argv?.[1], globalThis.process?.execPath],
): PadroneInstaller {
  for (const path of paths) {
    const installer = path ? installerFromPath(path) : undefined;
    if (installer) return installer;
  }
  return 'npm';
}

function installerCommand(
  installer: PadroneInstaller,
  packageName: string,
  version: string,
  brewFormula?: string,
  pinned?: boolean,
): string[] {
  const spec = `${packageName}@${version}`;
  switch (installer) {
    case 'bun':
      return ['bun', 'add', '-g', spec];
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
    case 'brew':
      if (pinned)
        throw new ActionError('Homebrew can only upgrade to the latest version of the formula; --to and --channel are not supported');
      return ['brew', 'upgrade', brewFormula ?? packageName];
    default:
      return ['npm', 'install', '-g', spec];
  }
}

/** The script path with symlinks resolved (npm's global `bin` links into `lib/node_modules`), then the executable. */
async function installPaths(): Promise<(string | undefined)[]> {
  const script = globalThis.process?.argv?.[1];
  const real = script ? await import('node:fs').then((fs) => fs.promises.realpath(script)).catch(() => script) : undefined;
  return [real, globalThis.process?.execPath];
}

/** Versions and dist-tags end up in the installer's arguments, so they can't look like options */
const VERSION_PATTERN = /^[\w+][\w.+-]*$/;
/** An npm package name, or a Homebrew formula (`tap/name`) */
const PACKAGE_PATTERN = /^(@[\w.-]+\/)?[\w][\w.-]*(\/[\w][\w.-]*)*$/;
const normalizeVersion = (version: string) => version.replace(/^v(?=\d)/, '');

/** Runs the installer found on `PATH` without a shell (Windows `.cmd` shims get an escaped `cmd.exe` line). */
async function spawnCommand(command: readonly string[]): Promise<number> {
  const env = globalThis.process?.env ?? {};
  const file = await findExecutable(command[0]!, pathDirs(env), { env });
  if (!file) throw new ActionError(`"${command[0]}" was not found on PATH`);
  return spawnInherited(file, command.slice(1));
}

const stateFile = (programName: string, runtime: ResolvedPadroneRuntime) =>
  `${getProgramDirs(programName, runtime.env()).state}${globalThis.process?.platform === 'win32' ? '\\' : '/'}upgrade.json`;

/** The version the last upgrade replaced, for `--rollback` */
async function previousVersion(programName: string, runtime: ResolvedPadroneRuntime): Promise<string> {
  let previous: unknown;
  try {
    previous = JSON.parse(await readTextFile(stateFile(programName, runtime))).previous;
  } catch {
    // No record
  }
  if (typeof previous !== 'string' || !VERSION_PATTERN.test(previous))
    throw new ActionError('No previous version is recorded to roll back to');
  return previous;
}

const recordPreviousVersion = (programName: string, runtime: ResolvedPadroneRuntime, previous: string) => {
  const env = runtime.env();
  // Without a home directory the state directory would be relative to cwd
  if (!env.XDG_STATE_HOME && !env.HOME && !env.USERPROFILE) return;
  return writeTextFileAtomic(
    stateFile(programName, runtime),
    `${JSON.stringify({ previous, upgradedAt: new Date().toISOString() })}\n`,
  ).catch(() => {});
};

/** On the upgrade command, so `padroneUpdateCheck()` doesn't suggest upgrading right after it ran. */
const UPGRADE_ID = 'padrone:upgrade';
/** On the program, so `padroneUpdateCheck()` and `version --check` find the command and package without loading it. */
const UPGRADE_CONFIG_ID = 'padrone:upgrade-config';

/** Whether `command` is the one `padroneUpgrade()` adds. */
export function isUpgradeCommand(command: AnyPadroneCommand): boolean {
  return !!command.interceptors?.some((interceptor) => interceptor.meta.id === UPGRADE_ID);
}

type UpgradeConfig = { command: string; packageName?: string; registry?: string; channel?: string };
const upgradeConfigs = new WeakMap<object, UpgradeConfig>();

/** The command name, package and registry of the `padroneUpgrade()` registered on `root`. */
export function getUpgradeConfig(root: AnyPadroneCommand): UpgradeConfig | undefined {
  const registered = root.interceptors?.findLast((interceptor) => interceptor.meta.id === UPGRADE_CONFIG_ID);
  return registered && upgradeConfigs.get(registered.factory);
}

type UpgradeArgs = { check?: boolean; exitCode?: boolean; to?: string; channel?: string; force?: boolean; rollback?: boolean };
type Plan = PadroneUpgradePlan & { upToDate: boolean; pinned: boolean };

/** The exit code of `upgrade --check --exit-code` when a newer version exists, like `npm outdated`. */
const UPDATE_AVAILABLE_EXIT_CODE = 1;

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds a self-update command, like oclif's plugin-update or cliffy's `UpgradeCommand`:
 * - `my-cli upgrade` installs the latest version with the package manager it was installed with
 * - `--check` only reports whether a newer version exists, and with `--exit-code` exits with 1 when one does;
 *   `--to 2.1.0` installs a given version (also a downgrade); `--channel next` follows another dist-tag;
 *   `--force` reinstalls when up to date
 * - `--dry-run` shows the command without running it; the command is a `mutation`, so `padroneConfirm()` asks first,
 *   once the registry says there's something to install
 * - `verify` checks the release before installing it, and refuses the upgrade when it resolves `false`
 * - `--rollback` installs the version the last upgrade replaced
 *
 * `padroneUpdateCheck()` suggests running it in its notice.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneUpgrade({ packageName: '@acme/my-cli' }))
 * ```
 */
export function padroneUpgrade(options: PadroneUpgradeOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const exec = options.exec ?? spawnCommand;
  const commandName = options.command ?? 'upgrade';

  const plan = async (args: UpgradeArgs, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime): Promise<Plan> => {
    const root = getRootCommand(command);
    const packageName = options.packageName ?? root.name;
    if (!PACKAGE_PATTERN.test(packageName)) throw new ActionError(`Invalid package name "${packageName}"`);
    const current = await getVersion(root.version);
    const channel = args.channel ?? options.channel ?? 'latest';
    if (args.rollback && (args.to || args.channel)) throw new ActionError("--rollback can't be combined with --to or --channel");
    const to = args.rollback ? await previousVersion(root.name, runtime) : args.to;
    if (!VERSION_PATTERN.test(channel)) throw new ActionError(`Invalid channel "${channel}"`);
    const found = to ?? (await fetchLatestVersion(packageName, options.registry ?? 'npm', channel));
    if (!found) throw new ActionError(`Couldn't find the ${channel} version of ${packageName}; check your connection or the registry`);
    if (!VERSION_PATTERN.test(found)) throw new ActionError(`Invalid version ${JSON.stringify(found)}`);
    const version = normalizeVersion(found);
    // A channel other than `latest` may point at a pre-release, which is what the user asked for
    const upToDate = to ? version === normalizeVersion(current) : !isNewerVersion(current, version, { prerelease: channel !== 'latest' });
    return { packageName, current, version, upToDate, runtime, pinned: !!to || channel !== 'latest' };
  };

  /** The plan, with the message to return instead when there's nothing to install (`--check`, up to date). */
  const decide = async (args: UpgradeArgs, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime) => {
    const p = await plan(args, command, runtime);
    const upToDate = `${p.packageName} is up to date (${p.current})`;
    if (args.check || args.exitCode) return { plan: p, message: p.upToDate ? upToDate : `Update available: ${p.current} → ${p.version}` };
    return { plan: p, message: p.upToDate && !args.force ? upToDate : undefined };
  };

  const describe = async (installer: PadroneUpgradeOptions['installer'], p: Plan) =>
    typeof installer === 'function'
      ? undefined
      : installerCommand(installer ?? detectInstaller(await installPaths()), p.packageName, p.version, options.brewFormula, p.pinned);

  /** Plans decided by the interceptor, so the action doesn't ask the registry again. */
  const plans = new WeakMap<object, Plan>();

  // Checks before `padroneConfirm()` (order -998) asks, so it only asks when there's something to install
  const planner = defineInterceptor({ id: UPGRADE_ID, name: UPGRADE_ID, order: -999 }, () => {
    let exitCode: number | undefined;
    return {
      async execute(ctx, next) {
        const args = ctx.args as UpgradeArgs;
        const { plan: p, message } = await decide(args, ctx.command, ctx.runtime);
        if (message === undefined) {
          plans.set(args, p);
          return next();
        }
        if (args.exitCode && !p.upToDate) exitCode = UPDATE_AVAILABLE_EXIT_CODE;
        return { result: message };
      },
      shutdown(ctx, next) {
        if (exitCode && ctx.result && typeof ctx.result === 'object') (ctx.result as { exitCode?: number }).exitCode = exitCode;
        return next();
      },
    };
  });

  /** The plan for the action; `run()` without the interceptor chain still gets the message. */
  const resolvePlan = async (args: UpgradeArgs, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime) => {
    const planned = plans.get(args);
    return planned ? { plan: planned, message: undefined } : decide(args, command, runtime);
  };

  const configMarker = defineInterceptor({ id: UPGRADE_CONFIG_ID, name: UPGRADE_CONFIG_ID }, () => ({}));
  upgradeConfigs.set(configMarker, {
    command: commandName,
    packageName: options.packageName,
    registry: options.registry,
    channel: options.channel,
  });

  return ((builder: AnyPadroneBuilder) =>
    builder.intercept(configMarker).command(commandName, (c) =>
      c
        .configure({ description: 'Upgrade to the latest version', mutation: true, builtin: true })
        .intercept(planner)
        .arguments(
          passthroughSchema({
            check: { type: 'boolean', description: 'Only check whether a newer version is available' },
            exitCode: { type: 'boolean', description: 'With --check, exit with 1 when a newer version is available' },
            to: { type: 'string', description: 'Install this version instead of the latest' },
            channel: { type: 'string', description: 'Dist-tag to upgrade to (e.g. next)' },
            force: { type: 'boolean', description: 'Reinstall even when up to date' },
            rollback: { type: 'boolean', description: 'Go back to the version the last upgrade replaced' },
          }),
        )
        .async()
        .action(async (args, ctx) => {
          const { plan: p, message } = await resolvePlan(args, ctx.command, ctx.runtime);
          if (message !== undefined) return message;

          const planned = await describe(options.installer, p);
          const target: PadroneUpgradePlan = {
            packageName: p.packageName,
            current: p.current,
            version: p.version,
            runtime: p.runtime,
            command: planned,
          };
          if (options.verify && (await options.verify(target)) === false) {
            throw new ActionError(`Couldn't verify ${p.packageName} ${p.version}; nothing was installed`);
          }
          ctx.runtime.error(`Upgrading ${p.packageName} ${p.current} → ${p.version}…`);
          const command = typeof options.installer === 'function' ? await options.installer(target) : planned;
          if (command?.length) {
            const code = await exec(command);
            if (code !== 0) throw new ActionError(`"${command.join(' ')}" failed with exit code ${code}`, { exitCode: code });
          }
          if (p.current !== p.version) await recordPreviousVersion(getRootCommand(ctx.command).name, ctx.runtime, p.current);
          return `${args.rollback ? 'Rolled back' : 'Upgraded'} ${p.packageName} to ${p.version}`;
        })
        .dryRun(async (args, ctx) => {
          const { plan: p, message } = await resolvePlan(args, ctx.command, ctx.runtime);
          if (message !== undefined) return message;
          const command = await describe(options.installer, p);
          return command
            ? `Would upgrade ${p.packageName} ${p.current} → ${p.version} with: ${command.join(' ')}`
            : `Would upgrade ${p.packageName} ${p.current} → ${p.version}`;
        }),
    )) as any;
}
