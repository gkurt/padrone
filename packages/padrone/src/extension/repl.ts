import { findCommandByName } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { parseCliInputToParts } from '../core/parse.ts';
import { withDrain } from '../core/results.ts';
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
import { passthroughSchema } from './utils.ts';

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
          .configure({ description: 'Start an interactive REPL', hidden: true })
          .arguments(passthroughSchema({ scope: 'string' }), { positional: ['scope'] })
          .async()
          .action(async (args, ctx) => {
            const prefs: PadroneReplPreferences = { ...defaults, scope: args.scope ?? defaults?.scope };
            const repl = ctx.program.repl(prefs);
            const { value } = await repl.drain();
            return value;
          }),
      )
      .intercept(createReplInterceptor(defaults, disabled))) as any;
}

function createReplInterceptor(defaults?: PadroneReplPreferences, disabled?: boolean) {
  return defineInterceptor({ id: 'padrone:repl', name: 'padrone:repl', order: -1000, disabled, options: { repl: 'flag' } }, () => ({
    start(ctx: InterceptorStartContext, next: () => unknown) {
      const replInfo = checkReplFlag(ctx.input, ctx.command);
      if (!replInfo) return next();

      const program = ctx.program;
      if (!program?.repl) return next();

      const prefs: PadroneReplPreferences = { ...defaults, scope: replInfo.scope ?? defaults?.scope };

      // Return a Promise so the pipeline awaits the REPL result
      return program
        .repl(prefs)
        .drain()
        .then((r: any) => withDrain({ command: ctx.command, args: undefined, result: r.value }));
    },
  }));
}

/** Check for --repl flag in input. The scope is the command path it follows; a command's own `--repl` option wins. */
function checkReplFlag(input: PadroneInput | undefined, rootCommand: AnyPadroneCommand): { scope?: string } | null {
  if (!input) return null;

  const skipRootName = typeof input === 'string';
  const parts = parseCliInputToParts(input, createParseResolver(rootCommand, findCommandByName, skipRootName));
  const hasReplFlag = parts.some((p) => p.type === 'named' && p.key.length === 1 && p.key[0] === 'repl');
  if (!hasReplFlag) return null;

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
