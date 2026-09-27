import { ActionError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { frameworkFlags } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneConfirmOptions = {
  /**
   * The question asked before running. Defaults to `Run "<command path>"?`.
   * A function receives the command and its validated args.
   */
  message?: string | ((command: AnyPadroneCommand, args: unknown) => string);
  /** Which commands ask for confirmation. Defaults to those configured with `mutation: true`. */
  when?: (command: AnyPadroneCommand, args: unknown) => boolean;
  /** Flags that skip the question: long names and single characters. Defaults to `['yes', 'y']`. */
  flags?: readonly string[];
};

const DEFAULT_CONFIRM_FLAGS = ['yes', 'y'] as const;

/** People type these commands; `eval()`, `run()`, serve, MCP and tool calls have their own approval flows. */
const CONFIRM_CALLERS = new Set<string>(['cli', 'repl']);

const flagDisplay = (name: string) => (name.length > 1 ? `--${name}` : `-${name}`);

// ── Interceptor ─────────────────────────────────────────────────────────

function createConfirmInterceptor(options: PadroneConfirmOptions) {
  const confirmFlags = options.flags ?? DEFAULT_CONFIRM_FLAGS;
  const when = options.when ?? ((command: AnyPadroneCommand) => !!command.mutation);

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
          if (confirmed || ctx.dryRun || !CONFIRM_CALLERS.has(ctx.caller) || !when(ctx.command, ctx.args)) return next();

          const { runtime, command } = ctx;
          const path = command.path || command.name;
          const canPrompt =
            !!runtime.prompt && runtime.interactive !== 'unsupported' && (ctx.evalInteractive ?? runtime.interactive !== 'disabled');
          const flag = confirmFlags.find((f) => f.length > 1) ?? confirmFlags[0];
          if (!canPrompt) {
            throw new ActionError(`"${path}" needs confirmation${flag ? `: pass ${flagDisplay(flag)} to run it without a prompt` : ''}`, {
              command: path,
              suggestions: flag ? [`Add ${flagDisplay(flag)}`] : [],
            });
          }

          const message =
            typeof options.message === 'function' ? options.message(command, ctx.args) : (options.message ?? `Run "${path}"?`);
          return runtime.prompt!({ name: 'confirm', message, type: 'confirm', default: false }).then((answer) => {
            if (answer !== true) throw new ActionError('Aborted', { command: path });
            return next();
          });
        },
      };
    },
  );
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that asks for confirmation before running commands that change things
 * (`.configure({ mutation: true })`, or those picked by `when`), like `rm -i` or `terraform apply`.
 *
 * - `--yes` / `-y` skips the question.
 * - Without a terminal to ask in (CI, piped output, `interactive: 'unsupported'`), the command fails unless `--yes` is passed.
 * - Only `cli()` and the REPL ask; `eval()`, `run()`, serve, MCP and `tool()` run the command directly.
 *
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneConfirm())
 *   .command('drop', (c) => c.configure({ mutation: true }).action(() => dropDatabase()))
 * // my-cli drop      → Run "drop"? (y/N)
 * // my-cli drop -y   → runs without asking
 * ```
 */
export function padroneConfirm(options: PadroneConfirmOptions = {}): <T extends CommandTypesBase>(builder: T) => WithAsync<T> {
  return ((builder: AnyPadroneBuilder) => builder.intercept(createConfirmInterceptor(options))) as any;
}
