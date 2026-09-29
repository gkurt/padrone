import { findCommandByName } from '../core/commands.ts';
import { ActionError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { parseCliInputToParts } from '../core/parse.ts';
import { thenMaybe } from '../core/results.ts';
import { createParseResolver, getKnownOptionNames } from '../core/validate.ts';
import type {
  AnyPadroneBuilder,
  AnyPadroneCommand,
  CommandTypesBase,
  InterceptorStartContext,
  PadroneCommand,
  PadroneInput,
  PadroneReplPreferences,
} from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { releaseProcessSignals } from './signal.ts';
import { frameworkFlags, isRemoteCaller, passthroughSchema, toFlag } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type ReplArgs = { scope?: string };

type ReplCommand = PadroneCommand<'repl', '', PadroneSchema<ReplArgs>, void, [], [], true>;

export type WithRepl<T> = WithCommand<T, 'repl', ReplCommand>;

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds REPL support:
 * - `repl` command that starts an interactive REPL
 * - `--repl` flag that starts the REPL from any invocation
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneRepl())
 * ```
 */
export function padroneRepl(
  defaults?: PadroneReplPreferences & { disabled?: boolean },
): <T extends CommandTypesBase>(builder: T) => WithRepl<T> {
  const disabled = defaults?.disabled;
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command('repl', (c) =>
        c
          // Remote callers get the interceptor's "The REPL needs a terminal" below, as `--repl` does
          .configure({ description: 'Start an interactive REPL', hidden: true, builtin: true, expose: true })
          .arguments(passthroughSchema({ scope: { type: 'string', description: 'Command to scope the REPL to' } }), {
            positional: ['scope'],
          })
          .async()
          // `cli()` and `eval()` start the session from the interceptor below; this runs for `run('repl')`
          .action(async (args, ctx) => {
            await ctx.program.repl(replPreferences(defaults, args.scope, ctx.runtime, ctx.context)).drain();
          }),
      )
      .intercept(createReplInterceptor(defaults, disabled))) as any;
}

/**
 * The session uses the runtime this run was given (e.g. `cli({ runtime })`) and the caller's context,
 * which each command in the session resolves through its own `.context()` transforms.
 */
function replPreferences(
  defaults: PadroneReplPreferences | undefined,
  scope: string | undefined,
  runtime: PadroneReplPreferences['runtime'],
  context: unknown,
): PadroneReplPreferences {
  return { ...defaults, scope: scope ?? defaults?.scope, runtime, context };
}

function createReplInterceptor(defaults?: PadroneReplPreferences, disabled?: boolean) {
  return defineInterceptor({ id: 'padrone:repl', name: 'padrone:repl', order: -1000, disabled, options: { repl: 'flag' } }, () => {
    let root: AnyPadroneCommand | undefined;
    // The context given to `cli()` / `eval()`, before any `.context()` transform
    let callerContext: unknown;

    return {
      start(ctx: InterceptorStartContext, next: () => unknown) {
        root = ctx.command;
        callerContext = ctx.context;
        // Remote callers (serve, MCP, AI tools) have no terminal: `--repl` stays in the input and is reported as an unknown option
        if (isRemoteCaller(ctx.caller)) return next();
        const replInfo = checkReplFlag(ctx.input, ctx.command);
        if (!replInfo) return next();

        const program = ctx.program;
        if (!program?.repl) return next();

        releaseProcessSignals(ctx.signal);
        // Return a Promise so the pipeline awaits the REPL result (skipping execute, so auto-output doesn't print it)
        return program
          .repl(replPreferences(defaults, replInfo.scope, ctx.runtime, callerContext))
          .drain()
          .then((r: any) => ({ command: ctx.command, args: undefined, result: r.value }));
      },
      // The `repl` command: nothing is returned, so auto-output doesn't print the session's results when it ends
      execute(ctx, next) {
        if (!root || ctx.command !== findCommandByName('repl', root.commands)) return next();
        if (isRemoteCaller(ctx.caller)) throw new ActionError('The REPL needs a terminal');
        const { scope } = ctx.args as ReplArgs;
        releaseProcessSignals(ctx.signal);
        return ctx.program
          .repl(replPreferences(defaults, scope, ctx.runtime, callerContext))
          .drain()
          .then(() => ({ result: undefined }));
      },
      // `--no-repl` / `--repl=false` reach parsing: consume them
      parse(ctx, next) {
        if (isRemoteCaller(ctx.caller)) return next();
        return thenMaybe(next(), (res) => {
          frameworkFlags(res.rawArgs, res.command).delete('repl');
          return res;
        });
      },
    };
  });
}

function checkReplFlag(input: PadroneInput | undefined, rootCommand: AnyPadroneCommand): { scope?: string } | null {
  if (!input) return null;

  const skipRootName = typeof input === 'string';
  const parts = parseCliInputToParts(input, createParseResolver(rootCommand, findCommandByName, skipRootName));
  // The last `--repl` / `--no-repl` / `--repl=false` decides
  const replParts = parts.filter((p) => p.type === 'named' && p.key.length === 1 && p.key[0] === 'repl');
  const last = replParts.at(-1) as { value?: unknown; negated?: boolean } | undefined;
  if (!last || last.negated || toFlag(last.value ?? true) === false) return null;

  const terms = parts.filter((p) => p.type === 'term').map((p) => p.value);
  if (skipRootName && terms[0] === rootCommand.name) terms.shift();

  let command = rootCommand;
  const path: string[] = [];
  for (const term of terms) {
    const subcommand = findCommandByName(term, command.commands);
    if (!subcommand) break;
    command = subcommand;
    path.push(term);
  }
  if (getKnownOptionNames(command).includes('repl')) return null;

  return { scope: path.length > 0 ? path.join(' ') : undefined };
}
