import type { ShellType } from '#src/util/shell-utils.ts';
import { resolveAllCommands } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { withDrain } from '../core/results.ts';
import { COMPLETE_COMMAND, COMPLETE_DESCRIBED_COMMAND, formatCompletionResult, getCompletionResult } from '../feature/complete.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { localOnlyInterceptor, passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type CompletionArgs = { shell?: string; setup?: boolean; instructions?: boolean; static?: boolean; descriptions?: boolean };

export type PadroneCompletionOptions = {
  /**
   * The scripts `completion <shell>` prints: `'dynamic'` (default) ask the program on each tab press (`__complete2`),
   * so `complete` callbacks and per-command values work; `'static'` list the commands, options and enum values up front,
   * without running the program. `completion <shell> --static` / `--no-static` override it.
   */
  mode?: 'dynamic' | 'static';
  /** Show descriptions next to candidates where the shell supports it. Defaults to `true`; `--no-descriptions` overrides it. */
  descriptions?: boolean;
};

type CompletionCommand = PadroneCommand<'completion', '', PadroneSchema<CompletionArgs>, string, [], [], true>;

export type WithCompletion<T> = WithCommand<T, 'completion', CompletionCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

/**
 * Answers `<program> __complete2 <words...>`, which the generated shell scripts call on each tab press, before any
 * parsing so option-like words aren't taken as flags: prints `value<TAB>description` lines and a directive line.
 * `__complete` (called by scripts from older versions) prints one candidate per line, and its result is the values.
 */
const completeInterceptor = defineInterceptor({ id: 'padrone:completion', name: 'padrone:completion', order: -3000 }, () => ({
  start(ctx, next) {
    const words = typeof ctx.input === 'string' ? ctx.input.split(/\s+/).filter((w, i) => w || i > 0) : ctx.input;
    const described = words?.[0] === COMPLETE_DESCRIBED_COMMAND;
    if (!described && words?.[0] !== COMPLETE_COMMAND) return next();

    resolveAllCommands(ctx.command);
    return getCompletionResult(ctx.command, words!.slice(1), { runtime: ctx.runtime, context: ctx.context }).then((completion) => {
      const values = completion.items.map((item) => item.value);
      if (described) ctx.runtime.output(formatCompletionResult(completion));
      else if (values.length > 0) ctx.runtime.output(values.join('\n'));
      return withDrain({ command: ctx.command, args: undefined, result: described ? completion : values });
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
export function padroneCompletion(options: PadroneCompletionOptions = {}): <T extends CommandTypesBase>(builder: T) => WithCompletion<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command('completion', (c) =>
        c
          .configure({ description: 'Generate shell completion scripts', hidden: true, builtin: true })
          .intercept(localOnlyInterceptor())
          .arguments(
            passthroughSchema({
              shell: {
                type: 'string',
                description: 'Shell to generate the script for (detected when omitted)',
                enum: ['bash', 'zsh', 'fish', 'powershell'],
              },
              setup: { type: 'boolean', description: "Install the script into the shell's config file" },
              instructions: { type: 'boolean', description: 'Print how to install the script instead of the script' },
              static: { type: 'boolean', description: 'Print a script that lists the candidates up front instead of asking the program' },
              descriptions: { type: 'boolean', description: 'Show descriptions next to candidates (--no-descriptions to leave them out)' },
            }),
            { positional: ['shell'] },
          )
          .async()
          .action(async (args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            resolveAllCommands(rootCommand);
            const { detectShellFromEnv, generateCompletionOutput, getCompletionInstallInstructions, setupCompletions } = await import(
              '../feature/completion.ts'
            );
            const shell = args.shell as ShellType;
            const env = ctx.runtime.env();
            const script = {
              mode: args.static === undefined ? options.mode : args.static ? 'static' : 'dynamic',
              descriptions: args.descriptions ?? options.descriptions,
            } as const;
            if (args.instructions) return getCompletionInstallInstructions(rootCommand.name, shell ?? (await detectShellFromEnv(env)));
            if (args.setup) {
              const resolvedShell = shell ?? (await detectShellFromEnv(env));
              if (!resolvedShell) throw new Error('Could not detect shell. Specify one: completion bash --setup');
              // The installed snippet runs `completion <shell>` with the flags given here, so they stick
              const flags = [...(args.static === undefined ? [] : [args.static ? '--static' : '--no-static'])];
              if (args.descriptions !== undefined) flags.push(args.descriptions ? '--descriptions' : '--no-descriptions');
              const setupResult = await setupCompletions(rootCommand.name, resolvedShell, { env, flags });
              return `${setupResult.updated ? 'Updated' : 'Added'} ${rootCommand.name} completions in ${setupResult.file}`;
            }
            return generateCompletionOutput(rootCommand, shell, env, script);
          }),
      )
      .intercept(completeInterceptor)) as any;
}
