import { resolveAllCommands, resolveCommand } from '../core/commands.ts';
import { RoutingError, ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { pageText, resolvePager } from '../feature/pager.ts';
import type { HelpDetail, HelpFormat, HelpInfo } from '../output/formatter.ts';
import { generateHelp, getHelpTopics } from '../output/help.ts';
import { formatHelpSearch, type HelpSearchResult, searchHelp } from '../output/help-search.ts';
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

type HelpArgs = { command?: string[]; detail?: HelpDetail; format?: HelpFormat; all?: boolean; search?: string };

/** A help topic as JSON: `help <topic> --format json`. */
export type HelpTopicInfo = { topic: string; title?: string; content: string };

/** Help text, or the help as an object when output is JSON (e.g. `--json`). */
export type HelpCommand = PadroneCommand<
  'help',
  '',
  PadroneSchema<HelpArgs>,
  string | HelpInfo | HelpTopicInfo | HelpSearchResult,
  [],
  ['h', ''],
  false
>;

export type WithHelp<T> = WithCommand<T, 'help', HelpCommand>;

// ── Interceptor ─────────────────────────────────────────────────────────

export type PadroneHelpTopicContext = {
  runtime: ResolvedPadroneRuntime;
  /** The format the topic is shown in (`--format`, else the runtime's). */
  format: HelpFormat | 'auto';
};

/** A guide `help <topic>` shows, like `gh help environment`. */
export type PadroneHelpTopic = {
  /** The topic's heading, used in JSON output and generated docs. */
  title?: string;
  /** A one-line summary shown next to the topic's name in the program's help. */
  description?: string;
  /** The topic's text, printed as is (Markdown reads well in a terminal too), or a function that returns it. */
  content: string | ((ctx: PadroneHelpTopicContext) => string);
};

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
  /**
   * Show help that's taller than the terminal through a pager, like git: `$PAGER`, or else `less -FRX`
   * (quits right away when the help fits, keeps colors; no default on Windows). A string sets the pager used when
   * `$PAGER` isn't set; `PAGER=cat` or an empty `PAGER` turns paging off. Only in `cli()` with stdout on a terminal.
   * `--no-pager` prints the help directly, and `--pager` pages it even when it fits. Defaults to `false`.
   */
  pager?: boolean | string;
  /**
   * When a command that only groups subcommands runs without one (`my-cli db`), ask which subcommand to run
   * with a select prompt instead of showing help, like `gh`. Only in `cli()` and the REPL, when the runtime can prompt;
   * `--help` still shows help. Defaults to `false`.
   */
  pickSubcommand?: boolean;
  /**
   * Additional help topics, keyed by name: `my-cli help environment` prints the topic, and the program's help lists them
   * under "Additional help topics". A command of the same name takes precedence.
   */
  topics?: Record<string, PadroneHelpTopic>;
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

const topicLookupErrors = new WeakSet<object>();

/** Whether `error` is `help <name>` not finding a top-level command or topic, so topic names can be suggested. */
export function isTopicLookupError(error: unknown): boolean {
  return !!error && typeof error === 'object' && topicLookupErrors.has(error);
}

/** A topic's text, or `{ topic, title, content }` under JSON output (as a string unless the runtime's format is JSON). */
function renderTopic(
  runtime: ResolvedPadroneRuntime,
  name: string,
  topic: PadroneHelpTopic,
  requested?: HelpFormat,
): string | HelpTopicInfo {
  const format = requested ?? runtime.format;
  const content = typeof topic.content === 'function' ? topic.content({ runtime, format }) : topic.content;
  if (format !== 'json') return content;
  const info: HelpTopicInfo = { topic: name, title: topic.title, content };
  return runtime.format === 'json' ? info : JSON.stringify(info, null, 2);
}

/** `help --search <term>`: the matches as text, or as `{ commands, topics }` under JSON output (like `renderTopic`). */
function renderSearch(
  runtime: ResolvedPadroneRuntime,
  rootCommand: AnyPadroneCommand,
  term: string,
  requested?: HelpFormat,
): string | HelpSearchResult {
  const result = searchHelp(rootCommand, term);
  if ((requested ?? runtime.format) !== 'json') return formatHelpSearch(result, term);
  return runtime.format === 'json' ? result : JSON.stringify(result, null, 2);
}

/**
 * Pages help text when paging is on and it doesn't fit the terminal (or `--pager` forces it).
 * Resolves `true` once the pager exits; `false` means the help should be printed as usual.
 */
function pageHelp(
  runtime: ResolvedPadroneRuntime,
  caller: string,
  help: unknown,
  pager: boolean | string | undefined,
  flag: boolean | undefined,
): false | Promise<boolean> {
  if (typeof help !== 'string' || flag === false || (!pager && flag !== true)) return false;
  if (caller !== 'cli' || runtime.terminal?.isTTY !== true) return false;
  const rows = runtime.terminal.rows;
  if (flag !== true && (!rows || help.split('\n').length < rows)) return false;
  const env = runtime.env();
  const command = resolvePager(env, typeof pager === 'string' ? pager : undefined);
  if (!command) return false;
  return pageText(help, command, env);
}

/** The `help` command added by this extension (a user's own `help` command has no `flagNames`). */
const isHelpCommand = (command: AnyPadroneCommand) =>
  command.name === 'help' && command.flagNames !== undefined && !!command.parent && !command.parent.parent;

const createHelpInterceptor = (options: PadroneHelpOptions) => {
  const helpFlags = options.flags ?? DEFAULT_HELP_FLAGS;
  return defineInterceptor(
    {
      id: 'padrone:help',
      name: 'padrone:help',
      // Outside stdin (-1001), so `--help` answers without reading piped input
      order: -1001.5,
      options: {
        ...Object.fromEntries(helpFlags.map((flag) => [flag, 'flag' as const])),
        all: 'flag',
        detail: 'value',
        d: 'value',
        format: 'value',
        f: 'value',
        ...(options.pager && { pager: 'flag' as const }),
      },
    },
    () => {
      let helpRequest: HelpRequest | undefined;
      let showDefaultHelp = false;
      let pagerFlag: boolean | undefined;

      /** Shows `result` through the pager when it applies; a paged result isn't printed again. */
      const withPager = (ctx: { runtime: ResolvedPadroneRuntime; caller: string }, result: unknown) => {
        const paged = pageHelp(ctx.runtime, ctx.caller, result, options.pager, pagerFlag);
        if (paged === false) return { result };
        return paged.then((done) => ({ result: done ? undefined : result }));
      };

      return {
        parse(ctx, next) {
          /** `pickSubcommand`: asks which subcommand of `command` to run, then parses again with it appended to the input. */
          const pick = (command: AnyPadroneCommand, input: PadroneInput | undefined) => {
            const choices = (command.commands ?? [])
              .map((c) => resolveCommand(c))
              .filter((c) => !c.hidden && c.name)
              .map((c) => ({ label: c.description ? `${c.name} — ${c.title ?? c.description}` : c.name, value: c.name }));
            const label = command.path || command.name;
            return ctx.runtime.prompt!({ name: 'command', message: `Which "${label}" command?`, type: 'select', choices }).then(
              (picked) => {
                const name = String(picked);
                const withPicked = Array.isArray(input) ? [...input, name] : input ? `${input} ${name}` : [name];
                return thenMaybe(next({ input: withPicked }), (res) => handle(res, false, withPicked));
              },
            );
          };
          const canPick = (command: AnyPadroneCommand) =>
            !!options.pickSubcommand &&
            (ctx.caller === 'cli' || ctx.caller === 'repl') &&
            !!ctx.runtime.prompt &&
            ctx.runtime.interactive !== 'unsupported' &&
            ctx.runtime.interactive !== 'disabled' &&
            (command.commands ?? []).some((c) => !c.hidden && c.name);

          const handle = (
            res: InterceptorParseResult,
            reverseHelp = false,
            input = ctx.input,
          ): InterceptorParseResult | Promise<InterceptorParseResult> => {
            const flags = frameworkFlags(res.rawArgs, res.command);
            if (options.pager && flags.has('pager')) {
              pagerFlag = flags.flag('pager');
              flags.delete('pager');
            }
            const hasHelpFlag = helpFlags.some((flag) => flags.flag(flag));
            // `--help=false` / `--no-help` is consumed without showing help
            if (!hasHelpFlag) flags.delete(...helpFlags);

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
                if (canPick(command) && flags.flag('interactive') !== false) return pick(command, input);
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
          if (helpRequest !== undefined || showDefaultHelp) return withPager(ctx, renderHelp(ctx.runtime, ctx.command, helpRequest));
          if (!options.pager || !isHelpCommand(ctx.command)) return next();
          return thenMaybe(next(), (res) => thenMaybe(res.result, (result) => withPager(ctx, result)));
        },
        error(ctx, next) {
          return thenMaybe(next(), (er) => {
            // Under JSON output, auto-output prints the error as JSON
            if (ctx.caller !== 'cli' || !er.error || isErrorReported(er.error) || ctx.runtime.format === 'json') return er;
            if (!(er.error instanceof RoutingError) && !(er.error instanceof ValidationError)) return er;

            const rootCommand = getRootCommand(ctx.command);
            const targetPath = er.error.command;
            const sourceCmd = resolveCommand((targetPath ? findCommandInTree(targetPath, rootCommand) : undefined) ?? rootCommand);

            if (er.error instanceof RoutingError) {
              ctx.runtime.error(er.error.message);
              // Resolved first: a lazily defined command's `hidden` is only known once it's resolved
              const visibleCommands = (sourceCmd.commands ?? []).map((c) => resolveCommand(c)).filter((c) => !c.hidden && c.name);
              if (!options.showHelpOnError && visibleCommands.length > 0) {
                ctx.runtime.error(`\nAvailable commands: ${visibleCommands.map((c) => c.name).join(', ')}`);
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
 * - Long help through a pager, with `pager: true`
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
            helpTopics: options.topics,
          } as PadroneCommandConfig)
          .arguments(
            passthroughSchema({
              command: { type: 'string[]', description: 'The command to show help for' },
              detail: { type: 'string', description: 'How much detail to show', enum: ['minimal', 'standard', 'full'] },
              format: { type: 'string', description: 'Output format', enum: ['text', 'ansi', 'console', 'markdown', 'html', 'json'] },
              all: { type: 'boolean', description: 'Show all global commands and options' },
              search: { type: 'string', description: 'Search commands and help topics' },
            }),
            { positional: ['...command'], fields: { detail: { flags: 'd' }, format: { flags: 'f' }, search: { flags: 's' } } },
          )
          .action((args, ctx) => {
            const rootCommand = getRootCommand(ctx.command);
            resolveAllCommands(rootCommand);
            if (args.search !== undefined) return renderSearch(ctx.runtime, rootCommand, args.search, args.format as HelpFormat);
            const commandName = args.command?.join(' ');
            const targetCommand = commandName ? findCommandInTree(commandName, rootCommand) : rootCommand;
            if (!targetCommand) {
              const parts = args.command ?? [];
              const topic = parts.length === 1 && getHelpTopics(rootCommand).find(([name]) => name === parts[0])?.[1];
              if (topic) return renderTopic(ctx.runtime, parts[0]!, topic, args.format as HelpFormat);
              // Reported like a mistyped command: the deepest command that matched lists its subcommands
              let known = 0;
              while (known < parts.length && findCommandInTree(parts.slice(0, known + 1).join(' '), rootCommand)) known++;
              const parent = findCommandInTree(parts.slice(0, known).join(' '), rootCommand) ?? rootCommand;
              const error = new RoutingError(`Unknown command: ${parts.slice(0, known + 1).join(' ')}`, {
                command: parent.path || undefined,
              });
              if (known === 0) topicLookupErrors.add(error);
              throw error;
            }
            return renderHelp(ctx.runtime, targetCommand, {
              detail: args.detail as HelpDetail,
              format: args.format as HelpFormat,
              all: args.all,
            });
          }),
      )
      .intercept(createHelpInterceptor(options))) as any;
}
