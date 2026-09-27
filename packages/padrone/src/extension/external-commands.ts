import { getCommandRuntime } from '../core/commands.ts';
import { defineInterceptor, LOCAL_CALLERS } from '../core/interceptors.ts';
import { commandNotFound } from '../core/not-found.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, PadroneExtraCommand } from '../types/index.ts';
import { findExecutable, listExecutables, pathDirs, spawnInherited } from '../util/spawn.ts';

export type PadroneExternalCommandsOptions = {
  /** What an executable's name starts with: `my-cli foo` runs `<prefix>foo`. Defaults to the program name and a dash (`my-cli-`). */
  prefix?: string;
  /** Directories to look in, in order. Defaults to the `PATH` of `runtime.env()`. */
  path?: readonly string[];
  /** List the external commands found in the program's help (under "External Commands") and in shell completion. Defaults to `true`. */
  list?: boolean;
  /**
   * Runs an external command and resolves with its exit code. Defaults to spawning `file` with `args` (no shell) with the
   * terminal's stdio; on Windows a `.cmd` / `.bat` file runs under `cmd.exe`, its arguments escaped.
   */
  spawn?: (file: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => Promise<number>;
};

const EXTERNAL_ID = 'padrone:external-commands';

/**
 * Extension for git-style external subcommands, like clap's `allow_external_subcommands` or cargo: a top-level command the
 * program doesn't have (`my-cli foo --bar`) runs the executable `my-cli-foo` from `PATH` with the words after it (`--bar`),
 * with the terminal's stdio, and the run ends with its exit code. Found ones are listed in help and offered by completion.
 * Only for `cli()`, `eval()`, `run()` and the REPL: serve, MCP and `tool()` never run them. Built on the `commandNotFound`
 * event, so when there's no such executable the usual "Unknown command" error (with suggestions) follows.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneExternalCommands())
 * // my-cli foo --bar   → my-cli-foo --bar
 * ```
 */
export function padroneExternalCommands(options: PadroneExternalCommandsOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const spawn = options.spawn ?? ((file, args, { env }) => spawnInherited(file, args, { env }));
  const prefixOf = (root: AnyPadroneCommand) => options.prefix ?? `${root.name}-`;
  const dirsOf = (env: Record<string, string | undefined>) => options.path ?? pathDirs(env);
  /** Exit codes of the external commands run, by their stand-in command, for the result */
  const exitCodes = new WeakMap<AnyPadroneCommand, number>();

  const extraCommands = (command: AnyPadroneCommand): PadroneExtraCommand[] => {
    if (command.parent) return [];
    const env = getCommandRuntime(command).env();
    const prefix = prefixOf(command);
    return listExecutables(prefix, dirsOf(env), { env }).map(({ name }) => ({
      name,
      description: `Runs ${prefix}${name}`,
      group: 'External Commands',
    }));
  };

  const interceptor = defineInterceptor(
    {
      id: EXTERNAL_ID,
      name: EXTERNAL_ID,
      callers: LOCAL_CALLERS,
      ...(options.list !== false && { extraCommands }),
    },
    () => ({
      // A non-zero exit code of the external command becomes the run's, which `cli()` exits with
      shutdown(ctx, next) {
        const result = ctx.result as { command?: AnyPadroneCommand; exitCode?: number } | undefined;
        const code = result?.command && exitCodes.get(result.command);
        if (code) result.exitCode = code;
        return next();
      },
    }),
  ).on(commandNotFound, async (event, ctx) => {
    if (event.command.parent) return;
    const env = ctx.runtime.env();
    const file = await findExecutable(`${prefixOf(event.command)}${event.name}`, dirsOf(env), { env });
    if (!file) return;
    event.handle(async (actionCtx) => {
      const code = await spawn(file, event.args, { env: actionCtx.runtime.env() });
      if (code !== 0) exitCodes.set(actionCtx.command, code);
    });
  });

  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
