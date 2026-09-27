import { ActionError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { askRuntime, canPrompt, isPromptCancel } from '../feature/prompt.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { frameworkFlags, programEnvVar, toFlag } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneConfirmOptions = {
  /**
   * The question asked before running. Defaults to `Run "<command path>"?`.
   * A function receives the command and its validated args. A command's `.configure({ confirm: 'Drop all tables?' })` wins.
   */
  message?: string | ((command: AnyPadroneCommand, args: unknown) => string);
  /**
   * Which commands ask for confirmation. Defaults to those configured with `mutation: true`.
   * A command's `.configure({ confirm })` overrides it (`false` never asks).
   * `padroneUpgrade()`'s command only gets here when there's something to install (not `--check`, not up to date).
   */
  when?: (command: AnyPadroneCommand, args: unknown) => boolean;
  /** Flags that skip the question: long names and single characters. Defaults to `['yes', 'y']`. */
  flags?: readonly string[];
  /**
   * Environment variable that answers yes for every command, like `--yes`, for scripts and CI (any value but `''`, `0`, `false`,
   * `no` and `off`). Defaults to `<PROGRAM>_YES` (`my-cli` → `MY_CLI_YES`); `false` for none.
   */
  env?: string | false;
  /**
   * What happens when a confirmation is needed but there's no terminal to ask in (CI, piped input, `--no-interactive`):
   * `'fail'` (default) throws an error that names `--yes`, `'yes'` runs the command, `'no'` aborts it as if answered no.
   */
  nonInteractive?: 'fail' | 'yes' | 'no';
};

const DEFAULT_CONFIRM_FLAGS = ['yes', 'y'] as const;

/** People type these commands; `eval()`, `run()`, serve, MCP and tool calls have their own approval flows. */
const CONFIRM_CALLERS = new Set<string>(['cli', 'repl']);

const flagDisplay = (name: string) => (name.length > 1 ? `--${name}` : `-${name}`);

// ── Interceptor ─────────────────────────────────────────────────────────

function createConfirmInterceptor(options: PadroneConfirmOptions) {
  const confirmFlags = options.flags ?? DEFAULT_CONFIRM_FLAGS;
  const when = options.when ?? ((command: AnyPadroneCommand) => !!command.mutation);
  const asks = (command: AnyPadroneCommand, args: unknown) =>
    command.confirm === undefined ? when(command, args) : command.confirm !== false;

  return defineInterceptor(
    {
      id: 'padrone:confirm',
      name: 'padrone:confirm',
      order: -998,
      options: Object.fromEntries(confirmFlags.map((flag) => [flag, 'flag' as const])),
    },
    () => {
      let confirmed = false;

      return {
        validate(ctx, next) {
          const flags = frameworkFlags(ctx.rawArgs, ctx.command);
          confirmed = confirmFlags.some((flag) => flags.flag(flag) === true);
          flags.delete(...confirmFlags);
          return next();
        },
        execute(ctx, next) {
          if (confirmed || ctx.dryRun || !CONFIRM_CALLERS.has(ctx.caller) || !asks(ctx.command, ctx.args)) return next();

          const { runtime, command } = ctx;
          const envVar = options.env === false ? undefined : (options.env ?? programEnvVar(getRootCommand(command).name, 'YES'));
          const envValue = envVar ? runtime.env()[envVar] : undefined;
          if (envValue && toFlag(envValue)) return next();

          const path = command.path || command.name;
          const aborted = () => new ActionError('Aborted', { command: path });
          // `--interactive` / `--no-interactive` (from the interactive extension) or eval's `interactive` option decide first;
          // otherwise prompts need an interactive runtime whose stdin isn't piped
          if (!canPrompt(ctx)) {
            if (options.nonInteractive === 'yes') return next();
            if (options.nonInteractive === 'no') throw aborted();
            const flag = confirmFlags.find((f) => f.length > 1) ?? confirmFlags[0];
            const setEnv = envVar && `set ${envVar}=1`;
            const how = flag ? `pass ${flagDisplay(flag)}${setEnv ? ` (or ${setEnv})` : ''}` : setEnv;
            throw new ActionError(`"${path}" needs confirmation${how ? `: ${how} to run it without a prompt` : ''}`, {
              command: path,
              suggestions: flag ? [`Add ${flagDisplay(flag)}`] : [],
            });
          }

          const own = command.confirm;
          const message =
            typeof own === 'string'
              ? own
              : typeof own === 'function'
                ? own(ctx.args)
                : typeof options.message === 'function'
                  ? options.message(command, ctx.args)
                  : (options.message ?? `Run "${path}"?`);
          return askRuntime(runtime, { name: 'confirm', message, type: 'confirm', default: false }).then(
            (answer) => {
              if (answer !== true) throw aborted();
              return next();
            },
            (err: unknown) => {
              throw isPromptCancel(err) ? aborted() : err;
            },
          );
        },
      };
    },
  );
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that asks for confirmation before running commands that change things
 * (`.configure({ mutation: true })`, those picked by `when`, or `.configure({ confirm })`), like `rm -i` or `terraform apply`.
 *
 * - `--yes` / `-y` skips the question, and so does `<PROGRAM>_YES=1` in the environment (`env` renames it).
 * - Without a terminal to ask in (CI, piped input or output, `interactive: 'unsupported'`, `--no-interactive`), the command fails
 *   unless `--yes` is passed (or the variable set); `nonInteractive: 'yes' | 'no'` runs or aborts it instead.
 * - Only `cli()` and the REPL ask; `eval()`, `run()`, serve, MCP and `tool()` run the command directly.
 * - Cancelling the question (Ctrl+C, Esc) aborts like answering no.
 *
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneConfirm())
 *   .command('drop', (c) => c.configure({ mutation: true, confirm: 'Drop all tables?' }).action(() => dropDatabase()))
 * // my-cli drop      → Drop all tables? (y/N)
 * // my-cli drop -y   → runs without asking
 * ```
 */
export function padroneConfirm(options: PadroneConfirmOptions = {}): <T extends CommandTypesBase>(builder: T) => WithAsync<T> {
  return ((builder: AnyPadroneBuilder) => builder.intercept(createConfirmInterceptor(options))) as any;
}
