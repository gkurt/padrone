import type { ShellType } from '#src/util/shell-utils.ts';
import { resolveAllCommands } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { withDrain } from '../core/results.ts';
import { COMPLETE_COMMAND, getCompletions } from '../feature/complete.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type CompletionArgs = { shell?: string; setup?: boolean };

type CompletionCommand = PadroneCommand<'completion', '', PadroneSchema<CompletionArgs>, string, [], [], true>;

export type WithCompletion<T> = WithCommand<T, 'completion', CompletionCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

/**
 * Answers `<program> __complete <words...>`, which the generated shell scripts call on each tab press:
 * prints one candidate per line, before any parsing so option-like words aren't taken as flags.
 */
const completeInterceptor = defineInterceptor({ id: 'padrone:completion', name: 'padrone:completion', order: -3000 }, () => ({
  start(ctx, next) {
    const words = typeof ctx.input === 'string' ? ctx.input.split(/\s+/).filter((w, i) => w || i > 0) : ctx.input;
    if (words?.[0] !== COMPLETE_COMMAND) return next();

    resolveAllCommands(ctx.command);
    return getCompletions(ctx.command, words.slice(1)).then((candidates) => {
      if (candidates.length > 0) ctx.runtime.output(candidates.join('\n'));
      return withDrain({ command: ctx.command, args: undefined, result: candidates });
    });
  },
}));

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds the `completion` command for shell completion script generation.
 *
 * Usage:
 * ```ts
 * import { createPadrone } from 'padrone';
 * import { padroneCompletion } from 'padrone/completion';
 *
 * createPadrone('my-cli').extend(padroneCompletion())
 * ```
 */
export function padroneCompletion(): <T extends CommandTypesBase>(builder: T) => WithCompletion<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command('completion', (c) =>
        c
          .configure({ description: 'Generate shell completion scripts', hidden: true })
          .arguments(
            passthroughSchema({
              shell: {
                type: 'string',
                description: 'Shell to generate the script for (detected when omitted)',
                enum: ['bash', 'zsh', 'fish', 'powershell'],
              },
              setup: { type: 'boolean', description: "Install the script into the shell's config file" },
            }),
            { positional: ['shell'] },
          )
          .async()
          .action(async (args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            resolveAllCommands(rootCommand);
            const { detectShell, generateCompletionOutput, setupCompletions } = await import('../feature/completion.ts');
            const shell = args.shell as ShellType;
            const setup = args.setup;
            if (setup) {
              const resolvedShell = shell ?? (await detectShell());
              if (!resolvedShell) throw new Error('Could not detect shell. Specify one: completion bash --setup');
              const setupResult = await setupCompletions(rootCommand.name, resolvedShell);
              return `${setupResult.updated ? 'Updated' : 'Added'} ${rootCommand.name} completions in ${setupResult.file}`;
            }
            return generateCompletionOutput(rootCommand, shell);
          }),
      )
      .intercept(completeInterceptor)) as any;
}
