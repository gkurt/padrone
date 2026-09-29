import type {
  AnyPadroneCommand,
  InterceptorParseContext,
  PadroneActionContext,
  PadroneEventContext,
  PadroneInput,
} from '../types/index.ts';
import { findCommandByName, getExtraCommands, suggestSubcommands } from './commands.ts';
import { defineEvent, eventHandlers, withEmit } from './events.ts';
import { parseCliInputToParts, tokenizeInput } from './parse.ts';
import { createParseResolver } from './validate.ts';

/** The payload of the `commandNotFound` event: an input named a command that doesn't exist. */
export type PadroneCommandNotFound = {
  /** The name that matched no command (`deploi` in `my-cli deploi --prod`). */
  readonly name: string;
  /** The words typed after it, as typed, options included (`['--prod']`). */
  readonly args: readonly string[];
  /** The command it was looked up in: the program for a top-level name. */
  readonly command: AnyPadroneCommand;
  /** The run's whole input. */
  readonly input: PadroneInput | undefined;
  /** Similar command names, as "Did you mean" lists them. */
  readonly suggestions: readonly string[];
  /** Whether a handler has called `handle()` or `reroute()`; the handlers after it don't run. */
  readonly handled: boolean;
  /**
   * Handles the name: `action` runs in its place, through the execute phase of the interceptors on `command`'s chain
   * (not the `.hook()` hooks), with no args to validate. Its return value is the run's result.
   */
  handle(action: (ctx: PadroneActionContext) => unknown): void;
  /** Runs `input` instead (e.g. the closest match, or an expanded alias), routed again; the parse interceptors don't run again. */
  reroute(input: PadroneInput): void;
};

/**
 * Emitted when routing finds no command for a name: at the top level (`my-cli deploi`) or under a command that has
 * subcommands and takes no positionals (`my-cli db migrat`). A handler can `handle()` it (run something in its place, e.g. an
 * external `my-cli-deploi` executable) or `reroute()` it; otherwise the usual "Unknown command" error follows, with
 * "Did you mean" suggestions. Handlers are those of the interceptors on the chain of the command the name was looked up in.
 * Only emitted when a handler is registered, so a program without one stays synchronous.
 *
 * ```ts
 * createPadrone('my-cli').intercept(
 *   defineInterceptor({ name: 'fallback' }, () => ({})).on(commandNotFound, (event) => {
 *     if (event.name === 'hello') event.handle(() => 'Hello!');
 *   }),
 * );
 * ```
 */
export const commandNotFound = defineEvent<PadroneCommandNotFound>('padrone:command-not-found');

const MARKER = 'padrone0unrouted0term';

/** The first term of the input that doesn't route to a subcommand. */
function unroutedTerm(tokens: readonly string[], rootCommand: AnyPadroneCommand, skipRootName: boolean): string | undefined {
  const parts = parseCliInputToParts(tokens, createParseResolver(rootCommand, findCommandByName, skipRootName));
  const terms = parts.filter((p) => p.type === 'term').map((p) => p.value);
  if (skipRootName && terms[0] === rootCommand.name) terms.shift();
  let command = rootCommand;
  for (const term of terms) {
    const found = findCommandByName(term, command.commands);
    if (!found) return term;
    command = found;
  }
  return undefined;
}

/**
 * The index in `tokens` of `term` where routing stopped at it, or -1: not an option value or positional spelled the same.
 * `skipRootName`: the tokens come from a string input, which may start with the program name.
 */
export function unroutedTermIndex(tokens: readonly string[], term: string, rootCommand: AnyPadroneCommand, skipRootName: boolean): number {
  return tokens.findIndex((token, i) => token === term && unroutedTerm(tokens.with(i, MARKER), rootCommand, skipRootName) === MARKER);
}

const notFoundCommands = new WeakSet<AnyPadroneCommand>();

/** Whether `command` stands in for a name a `commandNotFound` handler handled. */
export function isNotFoundCommand(command: AnyPadroneCommand): boolean {
  return notFoundCommands.has(command);
}

type ParseOutcome = { command: AnyPadroneCommand } | { input: PadroneInput } | undefined;

/**
 * Runs the `commandNotFound` handlers when the parse result names an unknown command and a handler is registered
 * (otherwise `undefined`, so the caller throws the routing error synchronously). Resolves with a stand-in command whose
 * action is the handler's, an input to route instead, or nothing when no handler took it.
 */
export function emitCommandNotFound(
  parsed: { command: AnyPadroneCommand; unmatchedTerms: string[] },
  rootCommand: AnyPadroneCommand,
  ctx: InterceptorParseContext,
): Promise<ParseOutcome> | undefined {
  const { command, unmatchedTerms } = parsed;
  const name = unmatchedTerms[0];
  if (name === undefined || command.meta?.positional?.length) return undefined;
  if (command !== rootCommand && !command.commands?.length) return undefined;
  const handlers = eventHandlers(command, ctx.caller, commandNotFound.id);
  if (handlers.length === 0) return undefined;

  const input = ctx.input;
  const tokens = input === undefined ? [] : [...tokenizeInput(input)];
  const index = unroutedTermIndex(tokens, name, rootCommand, typeof input === 'string');
  let outcome: { action: (ctx: PadroneActionContext) => unknown } | { input: PadroneInput } | undefined;
  const payload: PadroneCommandNotFound = {
    name,
    args: index === -1 ? unmatchedTerms.slice(1) : tokens.slice(index + 1),
    command,
    input,
    suggestions: suggestSubcommands(
      name,
      command,
      getExtraCommands(command).map((c) => c.name),
    ),
    get handled() {
      return outcome !== undefined;
    },
    handle: (action) => {
      outcome ??= { action };
    },
    reroute: (next) => {
      outcome ??= { input: next };
    },
  };
  const { signal, context, runtime, program, caller } = ctx;
  const eventCtx: PadroneEventContext = withEmit({ command, signal, context, runtime, program, caller });

  return (async (): Promise<ParseOutcome> => {
    for (const handler of handlers) {
      await handler(payload, eventCtx);
      if (outcome) break;
    }
    if (!outcome) return undefined;
    if ('input' in outcome) return { input: outcome.input };
    const { action } = outcome;
    const standIn = {
      name,
      path: command.path ? `${command.path} ${name}` : name,
      parent: command,
      action: (_args: unknown, actionCtx: PadroneActionContext) => action(actionCtx),
      '~types': {},
    } as AnyPadroneCommand;
    notFoundCommands.add(standIn);
    return { command: standIn };
  })();
}
