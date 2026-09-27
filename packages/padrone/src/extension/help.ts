import { resolveAllCommands, resolveCommand } from '../core/commands.ts';
import { RoutingError, ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { HelpDetail, HelpFormat, HelpInfo } from '../output/formatter.ts';
import { generateHelp } from '../output/help.ts';
import type {
  AnyPadroneBuilder,
  AnyPadroneCommand,
  CommandTypesBase,
  InterceptorParseResult,
  PadroneCommand,
  PadroneCommandConfig,
  PadroneInput,
} from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { findCommandInTree, frameworkFlags, isErrorReported, markErrorReported, passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type HelpArgs = { command?: string[]; detail?: HelpDetail; format?: HelpFormat; all?: boolean };

/** Help text, or the help as an object when output is JSON (e.g. `--json`). */
export type HelpCommand = PadroneCommand<'help', '', PadroneSchema<HelpArgs>, string | HelpInfo, [], ['h', ''], false>;

export type WithHelp<T> = WithCommand<T, 'help', HelpCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

export type PadroneHelpOptions = {
  /**
   * Print the full help of the failing command after a routing or validation error in `cli()`.
   * Defaults to `false`: the error is followed by a one-line hint pointing to `--help`.
   */
  showHelpOnError?: boolean;
  /**
   * Flags that show help: long names (`'help'` → `--help`) and single characters (`'h'` → `-h`).
   * Defaults to `['help', 'h']`. Pass `[]` to keep only the `help` command.
   */
  flags?: readonly string[];
};

const DEFAULT_HELP_FLAGS = ['help', 'h'] as const;

/** The input without a trailing `help` token, or `undefined` when it doesn't end with one after a command. */
function withoutTrailingHelp(input: PadroneInput | undefined): PadroneInput | undefined {
  if (Array.isArray(input)) return input.length > 1 && input.at(-1) === 'help' ? input.slice(0, -1) : undefined;
  return input?.match(/^(.*\S)\s+help\s*$/s)?.[1];
}

/** Formats a flag name as typed: `help` → `--help`, `h` → `-h`. */
export function flagDisplay(name: string): string {
  return name.length > 1 ? `--${name}` : `-${name}`;
}

/** The one-line hint shown after an error: `Run "my-cli build --help" for usage.` */
function helpHint(rootCommand: AnyPadroneCommand, command: AnyPadroneCommand, flags: readonly string[]): string {
  const path = command === rootCommand ? '' : command.path;
  const flag = flags.find((f) => f.length > 1) ?? flags[0];
  const invocation = flag ? [rootCommand.name, path, flagDisplay(flag)] : [rootCommand.name, 'help', path];
  return `Run "${invocation.filter(Boolean).join(' ')}" for usage.`;
}

type HelpRequest = { detail?: HelpDetail; format?: HelpFormat; all?: boolean };

/**
 * Renders help for `command` with the runtime's settings at the time it's shown, so flags read later in
 * parsing (`--no-color`, `--json`) apply. Under JSON output the help is returned parsed, so it's printed once as JSON.
 */
function renderHelp(runtime: ResolvedPadroneRuntime, command: AnyPadroneCommand, request: HelpRequest = {}): string | HelpInfo {
  const rootCommand = getRootCommand(command);
  resolveAllCommands(rootCommand);
  const format = request.format ?? runtime.format;
  const text = generateHelp(rootCommand, command, {
    detail: request.detail,
    format,
    theme: runtime.theme,
    all: request.all,
    terminal: runtime.terminal,
    env: runtime.env(),
  });
  if (format !== 'json' || runtime.format !== 'json') return text;
  try {
    return JSON.parse(text) as HelpInfo;
  } catch {
    return text;
  }
}

const createHelpInterceptor = (options: PadroneHelpOptions) => {
  const helpFlags = options.flags ?? DEFAULT_HELP_FLAGS;
  return defineInterceptor(
    {
      id: 'padrone:help',
      name: 'padrone:help',
      order: -1000,
      options: {
        ...Object.fromEntries(helpFlags.map((flag) => [flag, 'flag' as const])),
        all: 'flag',
        detail: 'value',
        d: 'value',
        format: 'value',
        f: 'value',
      },
    },
    () => {
      let helpRequest: HelpRequest | undefined;
      let showDefaultHelp = false;

      return {
        parse(ctx, next) {
          const handle = (res: InterceptorParseResult, reverseHelp = false) => {
            const flags = frameworkFlags(res.rawArgs, res.command);
            const hasHelpFlag = helpFlags.some((flag) => flags.get(flag));

            if (hasHelpFlag || reverseHelp) {
              helpRequest = {
                detail: (flags.get('detail') ?? flags.get('d')) as HelpDetail | undefined,
                format: (flags.get('format') ?? flags.get('f')) as HelpFormat | undefined,
                all: flags.get('all') as boolean | undefined,
              };
              flags.delete(...helpFlags, 'detail', 'format', 'all', 'd', 'f');
              return res;
            }

            // Track whether the parsed command has no action (for default help in execute phase)
            if (helpRequest === undefined) {
              const { command } = res;
              const hasSubcommands = command.commands && command.commands.length > 0;
              const hasSchema = command.argsSchema != null;
              const hasUnmatchedTerms = res.positionalArgs?.length > 0 && !command.meta?.positional?.length;
              if (!command.action && (hasSubcommands || !hasSchema) && !hasUnmatchedTerms) {
                showDefaultHelp = true;
              }
            }

            return res;
          };

          // `<cmd> help`: a trailing `help` the command can't take as a positional shows the command's help
          const retryAsHelp = (err: unknown) => {
            const input = err instanceof RoutingError ? withoutTrailingHelp(ctx.input) : undefined;
            if (input === undefined) throw err;
            return thenMaybe(next({ input }), (res) => handle(res, true));
          };

          let parsed: InterceptorParseResult | Promise<InterceptorParseResult>;
          try {
            parsed = next();
          } catch (err) {
            return retryAsHelp(err);
          }
          return parsed instanceof Promise ? parsed.then((res) => handle(res), retryAsHelp) : handle(parsed);
        },
        validate(_ctx, next) {
          if (helpRequest !== undefined) return { args: undefined as any, argsResult: { value: undefined } as any };
          return next();
        },
        execute(ctx, next) {
          if (helpRequest !== undefined || showDefaultHelp) return { result: renderHelp(ctx.runtime, ctx.command, helpRequest) };
          return next();
        },
        error(ctx, next) {
          return thenMaybe(next(), (er) => {
            // Under JSON output, auto-output prints the error as JSON
            if (ctx.caller !== 'cli' || !er.error || isErrorReported(er.error) || ctx.runtime.format === 'json') return er;
            if (!(er.error instanceof RoutingError) && !(er.error instanceof ValidationError)) return er;

            const rootCommand = getRootCommand(ctx.command);
            const targetPath = er.error.command;
            const sourceCmd = (targetPath ? findCommandInTree(targetPath, rootCommand) : undefined) ?? rootCommand;

            if (er.error instanceof RoutingError) {
              ctx.runtime.error(er.error.message);
              const visibleCommands = (sourceCmd.commands ?? []).filter((c: AnyPadroneCommand) => !c.hidden && c.name);
              if (!options.showHelpOnError && visibleCommands.length > 0) {
                for (const cmd of visibleCommands) resolveCommand(cmd);
                ctx.runtime.error(`\nAvailable commands: ${visibleCommands.map((c: AnyPadroneCommand) => c.name).join(', ')}`);
              }
            } else {
              ctx.runtime.error(`Validation error:\n${formatIssueMessages(er.error.issues)}`);
            }

            if (options.showHelpOnError) {
              resolveAllCommands(rootCommand);
              ctx.runtime.error(
                generateHelp(rootCommand, sourceCmd, {
                  format: ctx.runtime.format,
                  theme: ctx.runtime.theme,
                  terminal: ctx.runtime.terminal,
                  env: ctx.runtime.env(),
                }),
              );
            } else {
              ctx.runtime.error(`\n${helpHint(rootCommand, sourceCmd, helpFlags)}`);
            }

            markErrorReported(er.error);
            return er;
          });
        },
      };
    },
  );
};

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds help support:
 * - `help` command with aliases `h` and `` (empty = executes on root when no subcommand matches)
 * - `--help` / `-h` flags
 * - `<cmd> help` reverse syntax
 * - Default help display when a command has no action
 * - A `--help` hint after routing and validation errors (or the full help, with `showHelpOnError`)
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneHelp())
 * ```
 */
export function padroneHelp(options: PadroneHelpOptions = {}): <T extends CommandTypesBase>(builder: T) => WithHelp<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder
      .command(['help', 'h'], (c) =>
        c
          .configure({
            description: 'Display help for a command',
            hidden: true,
            flagNames: options.flags ?? DEFAULT_HELP_FLAGS,
          } as PadroneCommandConfig)
          .arguments(
            passthroughSchema({
              command: { type: 'string[]', description: 'The command to show help for' },
              detail: { type: 'string', description: 'How much detail to show', enum: ['minimal', 'standard', 'full'] },
              format: { type: 'string', description: 'Output format', enum: ['text', 'ansi', 'console', 'markdown', 'html', 'json'] },
              all: { type: 'boolean', description: 'Show all global commands and options' },
            }),
            { positional: ['...command'], fields: { detail: { flags: 'd' }, format: { flags: 'f' } } },
          )
          .action((args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            resolveAllCommands(rootCommand);
            const commandName = args.command?.join(' ');
            const targetCommand = (commandName ? findCommandInTree(commandName, rootCommand) : undefined) ?? rootCommand;
            return renderHelp(ctx.runtime, targetCommand, {
              detail: args.detail as HelpDetail,
              format: args.format as HelpFormat,
              all: args.all,
            });
          }),
      )
      .intercept(createHelpInterceptor(options))) as any;
}
