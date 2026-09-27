import { getCommandRuntime } from '#src/core/commands.ts';
import { thenMaybe } from '#src/core/results.ts';
import type { ResolvedPadroneRuntime } from '#src/core/runtime.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import {
  createUpdateChecker,
  fetchLatestVersion,
  formatUpdateNotice,
  isNewerVersion,
  isVersion,
  type UpdateCheckConfig,
  updateInfo,
} from '../feature/update-check.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { getRootCommand, readScriptVersion } from '../util/utils.ts';
import { getUpgradeConfig, isUpgradeCommand } from './upgrade.ts';
import { frameworkFlags } from './utils.ts';

const UPDATE_CHECK_ID = 'padrone:update-check';
const configs = new WeakMap<object, UpdateCheckConfig>();

/**
 * Where to look for updates: `padroneUpdateCheck()`'s settings, then `padroneUpgrade()`'s (whose command is the suggested
 * update command), then the npm registry with the program name.
 */
function updateSettings(
  root: AnyPadroneCommand,
  config = configs.get(root.interceptors?.findLast((interceptor) => interceptor.meta.id === UPDATE_CHECK_ID)?.factory ?? {}) ?? {},
): UpdateCheckConfig & { packageName: string; registry: string } {
  const upgrade = getUpgradeConfig(root);
  return {
    ...config,
    packageName: config.packageName ?? upgrade?.packageName ?? root.name,
    registry: config.registry ?? upgrade?.registry ?? 'npm',
    updateCommand: config.updateCommand ?? (upgrade && `${root.name} ${upgrade.command}`),
  };
}

/** Asks the registry for the latest version of the program, as `version --check` does. */
export async function checkForUpdate(
  root: AnyPadroneCommand,
  current: string,
): Promise<{ latest?: string; updateAvailable: boolean; message?: string }> {
  const settings = updateSettings(root);
  const found = await fetchLatestVersion(settings.packageName, settings.registry);
  const latest = isVersion(found) ? found : undefined;
  if (!latest || !isNewerVersion(current, latest)) return { latest, updateAvailable: false };
  return {
    latest,
    updateAvailable: true,
    message: formatUpdateNotice(updateInfo(settings.packageName, current, latest, settings, getCommandRuntime(root)), settings).trimEnd(),
  };
}

// ── Interceptor ─────────────────────────────────────────────────────────

function createUpdateCheckInterceptor(config: UpdateCheckConfig) {
  const interceptor = defineInterceptor(
    { id: UPDATE_CHECK_ID, name: UPDATE_CHECK_ID, order: 1000, options: { 'update-check': 'flag' } },
    () => {
      let check: Promise<(() => void) | undefined> | undefined;
      let flagsRead = false;

      const readFlags = (
        ctx: { caller: string; runtime: ResolvedPadroneRuntime },
        rawArgs: Record<string, unknown>,
        command: AnyPadroneCommand,
      ) => {
        flagsRead = true;
        const flags = frameworkFlags(rawArgs, command);
        const suppressed = flags.flag('update-check') === false;
        flags.delete('update-check');
        // Only people running the CLI see the notice, never right after upgrading; `--no-update-check` skips the request too
        if (suppressed || ctx.caller !== 'cli' || isUpgradeCommand(command)) return;

        const rootCommand = getRootCommand(command);
        const runtime = ctx.runtime;
        check = Promise.resolve(rootCommand.version ?? readScriptVersion())
          .then((version) =>
            version ? createUpdateChecker(rootCommand.name, version, updateSettings(rootCommand, config), runtime) : undefined,
          )
          .then((started) => started?.notify)
          .catch(() => undefined);
      };

      return {
        parse(ctx, next) {
          return thenMaybe(next(), (res) => {
            readFlags(ctx, res.rawArgs, res.command);
            return res;
          });
        },
        // Registered on a command: its parse handler doesn't run
        validate(ctx, next) {
          if (!flagsRead) readFlags(ctx, ctx.rawArgs, ctx.command);
          return next();
        },
        shutdown(_ctx, next) {
          // Printed after the command's own output; the check only reads the cache, so it settles right away
          return thenMaybe(next(), () => {
            check?.then((notify) => notify?.());
          });
        },
      };
    },
  );
  configs.set(interceptor, config);
  return interceptor;
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds background update checking, like update-notifier:
 * - Shows an update notice after the command, from the latest version cached by an earlier run
 * - Refreshes a stale cache (`interval`) in a detached process, so a slow registry never delays the exit
 * - Respects `--no-update-check`, `NO_UPDATE_NOTIFIER`, CI and non-TTY output; `shouldNotify` can suppress it further
 * - `format` rewords the notice
 * - Uses the program's `version`, or that of the package its script belongs to; without one nothing is checked
 * - Suggests `<program> upgrade` when `padroneUpgrade()` is registered
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneUpdateCheck({ packageName: 'my-cli' }))
 * ```
 */
export function padroneUpdateCheck(config: UpdateCheckConfig = {}): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(createUpdateCheckInterceptor(config))) as any;
}
