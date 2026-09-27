import { ActionError } from '../core/errors.ts';
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
   * How the program is installed. Detected from where it runs by default (a Homebrew cellar, `~/.bun`, pnpm's or
   * yarn's global directory, otherwise npm). A function returns the command to run (`['npm', 'i', '-g', ...]`), or performs
   * the upgrade itself (e.g. downloading a standalone binary) and returns nothing.
   */
  installer?: PadroneInstaller | ((plan: PadroneUpgradePlan) => readonly string[] | undefined | Promise<readonly string[] | undefined>);
  /** Homebrew formula, when installed with `brew`. Defaults to the package name. */
  brewFormula?: string;
  /** Name of the command. Defaults to `'upgrade'`. */
  command?: string;
  /** Runs an installer command and resolves with its exit code. Defaults to spawning it with inherited stdio. */
  exec?: (command: readonly string[]) => Promise<number>;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** How the running program was installed, from its script path (`process.argv[1]`) and the runtime's path. */
export function detectInstaller(
  paths: readonly (string | undefined)[] = [globalThis.process?.argv?.[1], globalThis.process?.execPath],
): PadroneInstaller {
  const joined = paths.filter(Boolean).join('\n').replace(/\\/g, '/').toLowerCase();
  if (/\/cellar\/|\/homebrew\/|\/linuxbrew\//.test(joined)) return 'brew';
  if (joined.includes('/.bun/')) return 'bun';
  if (/\/pnpm\/|\/pnpm-global\//.test(joined)) return 'pnpm';
  if (/\/\.yarn\/|\/yarn\/global\//.test(joined)) return 'yarn';
  return 'npm';
}

function installerCommand(installer: PadroneInstaller, packageName: string, version: string, brewFormula?: string): string[] {
  const spec = `${packageName}@${version}`;
  switch (installer) {
    case 'bun':
      return ['bun', 'add', '-g', spec];
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
    case 'brew':
      return ['brew', 'upgrade', brewFormula ?? packageName];
    default:
      return ['npm', 'install', '-g', spec];
  }
}

async function spawnCommand(command: readonly string[]): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    // Package managers are `.cmd` shims on Windows
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', shell: globalThis.process?.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

type UpgradeArgs = { check?: boolean; to?: string; channel?: string; force?: boolean };

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds a self-update command, like oclif's plugin-update or cliffy's `UpgradeCommand`:
 * - `my-cli upgrade` installs the latest version with the package manager it was installed with
 * - `--check` only reports whether a newer version exists; `--to 2.1.0` installs a given version (also a downgrade);
 *   `--channel next` follows another dist-tag; `--force` reinstalls when up to date
 * - `--dry-run` shows the command without running it; the command is a `mutation`, so `padroneConfirm()` asks first
 *
 * Pairs with `padroneUpdateCheck({ updateCommand: 'my-cli upgrade' })`.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneUpgrade({ packageName: '@acme/my-cli' }))
 * ```
 */
export function padroneUpgrade(options: PadroneUpgradeOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const exec = options.exec ?? spawnCommand;

  /** Resolves what to install, or a message when there's nothing to do. */
  const plan = async (args: UpgradeArgs, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime) => {
    const root = getRootCommand(command);
    const packageName = options.packageName ?? root.name;
    const current = await getVersion(root.version);
    const channel = args.channel ?? options.channel ?? 'latest';
    const version = args.to ?? (await fetchLatestVersion(packageName, options.registry ?? 'npm', channel));
    if (!version) throw new ActionError(`Couldn't find the ${channel} version of ${packageName}; check your connection or the registry`);
    // A channel other than `latest` may point at a pre-release, which is what the user asked for
    const upToDate = args.to ? version === current : !isNewerVersion(current, version, { prerelease: channel !== 'latest' });
    return { packageName, current, version, upToDate, runtime };
  };

  const describe = (installer: PadroneUpgradeOptions['installer'], packageName: string, version: string) =>
    typeof installer === 'function'
      ? undefined
      : installerCommand(installer ?? detectInstaller(), packageName, version, options.brewFormula);

  return ((builder: AnyPadroneBuilder) =>
    builder.command(options.command ?? 'upgrade', (c) =>
      c
        .configure({ description: 'Upgrade to the latest version', mutation: true })
        .arguments(
          passthroughSchema({
            check: { type: 'boolean', description: 'Only check whether a newer version is available' },
            to: { type: 'string', description: 'Install this version instead of the latest' },
            channel: { type: 'string', description: 'Dist-tag to upgrade to (e.g. next)' },
            force: { type: 'boolean', description: 'Reinstall even when up to date' },
          }),
        )
        .async()
        .action(async (args, ctx) => {
          const p = await plan(args, ctx.command, ctx.runtime);
          if (args.check)
            return p.upToDate ? `${p.packageName} is up to date (${p.current})` : `Update available: ${p.current} → ${p.version}`;
          if (p.upToDate && !args.force) return `${p.packageName} is up to date (${p.current})`;

          ctx.runtime.error(`Upgrading ${p.packageName} ${p.current} → ${p.version}…`);
          const command =
            typeof options.installer === 'function' ? await options.installer(p) : describe(options.installer, p.packageName, p.version);
          if (command?.length) {
            const code = await exec(command);
            if (code !== 0) throw new ActionError(`"${command.join(' ')}" failed with exit code ${code}`, { exitCode: code });
          }
          return `Upgraded ${p.packageName} to ${p.version}`;
        })
        .dryRun(async (args, ctx) => {
          const p = await plan(args, ctx.command, ctx.runtime);
          if (p.upToDate && !args.force) return `${p.packageName} is up to date (${p.current})`;
          const command = describe(options.installer, p.packageName, p.version);
          return command
            ? `Would upgrade ${p.packageName} ${p.current} → ${p.version} with: ${command.join(' ')}`
            : `Would upgrade ${p.packageName} ${p.current} → ${p.version}`;
        }),
    )) as any;
}
