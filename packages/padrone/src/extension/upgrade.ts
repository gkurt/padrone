import { ActionError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { fetchLatestVersion, isNewerVersion } from '../feature/update-check.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
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
};

// ── Helpers ──────────────────────────────────────────────────────────────

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

/** Versions and dist-tags end up in a shell command on Windows */
const VERSION_PATTERN = /^[\w.+-]+$/;
const normalizeVersion = (version: string) => version.replace(/^v(?=\d)/, '');

async function spawnCommand(command: readonly string[]): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    // Package managers are `.cmd` shims on Windows
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', shell: globalThis.process?.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** On the upgrade command, so `padroneUpdateCheck()` doesn't suggest upgrading right after it ran. */
const UPGRADE_ID = 'padrone:upgrade';
/** On the program, so `padroneUpdateCheck()` and `version --check` find the command and package without loading it. */
const UPGRADE_CONFIG_ID = 'padrone:upgrade-config';

/** Whether `command` is the one `padroneUpgrade()` adds. */
export function isUpgradeCommand(command: AnyPadroneCommand): boolean {
  return !!command.interceptors?.some((interceptor) => interceptor.meta.id === UPGRADE_ID);
}

type UpgradeConfig = { command: string; packageName?: string; registry?: string };
const upgradeConfigs = new WeakMap<object, UpgradeConfig>();

/** The command name, package and registry of the `padroneUpgrade()` registered on `root`. */
export function getUpgradeConfig(root: AnyPadroneCommand): UpgradeConfig | undefined {
  const registered = root.interceptors?.findLast((interceptor) => interceptor.meta.id === UPGRADE_CONFIG_ID);
  return registered && upgradeConfigs.get(registered.factory);
}

type UpgradeArgs = { check?: boolean; exitCode?: boolean; to?: string; channel?: string; force?: boolean };
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
    const current = await getVersion(root.version);
    const channel = args.channel ?? options.channel ?? 'latest';
    if (!VERSION_PATTERN.test(channel)) throw new ActionError(`Invalid channel "${channel}"`);
    const found = args.to ?? (await fetchLatestVersion(packageName, options.registry ?? 'npm', channel));
    if (!found) throw new ActionError(`Couldn't find the ${channel} version of ${packageName}; check your connection or the registry`);
    if (!VERSION_PATTERN.test(found)) throw new ActionError(`Invalid version "${found}"`);
    const version = normalizeVersion(found);
    // A channel other than `latest` may point at a pre-release, which is what the user asked for
    const upToDate = args.to
      ? version === normalizeVersion(current)
      : !isNewerVersion(current, version, { prerelease: channel !== 'latest' });
    return { packageName, current, version, upToDate, runtime, pinned: !!args.to || channel !== 'latest' };
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
  upgradeConfigs.set(configMarker, { command: commandName, packageName: options.packageName, registry: options.registry });

  return ((builder: AnyPadroneBuilder) =>
    builder.intercept(configMarker).command(commandName, (c) =>
      c
        .configure({ description: 'Upgrade to the latest version', mutation: true })
        .intercept(planner)
        .arguments(
          passthroughSchema({
            check: { type: 'boolean', description: 'Only check whether a newer version is available' },
            exitCode: { type: 'boolean', description: 'With --check, exit with 1 when a newer version is available' },
            to: { type: 'string', description: 'Install this version instead of the latest' },
            channel: { type: 'string', description: 'Dist-tag to upgrade to (e.g. next)' },
            force: { type: 'boolean', description: 'Reinstall even when up to date' },
          }),
        )
        .async()
        .action(async (args, ctx) => {
          const { plan: p, message } = await resolvePlan(args, ctx.command, ctx.runtime);
          if (message !== undefined) return message;

          const planned = await describe(options.installer, p);
          ctx.runtime.error(`Upgrading ${p.packageName} ${p.current} → ${p.version}…`);
          const command = typeof options.installer === 'function' ? await options.installer(p) : planned;
          if (command?.length) {
            const code = await exec(command);
            if (code !== 0) throw new ActionError(`"${command.join(' ')}" failed with exit code ${code}`, { exitCode: code });
          }
          return `Upgraded ${p.packageName} to ${p.version}`;
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
