import { resolveCommand, suggestSimilar } from '../core/commands.ts';
import { RoutingError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { getKnownOptionNames } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, InterceptorParseContext, PadroneInput } from '../types/index.ts';
import { camelToKebab } from '../util/shell-utils.ts';

function formatSuggestions(names: string[], prefix = ''): string {
  if (names.length === 0) return '';
  const quoted = names.map((n) => `"${prefix}${n}"`);
  if (quoted.length === 1) return `Did you mean ${quoted[0]}?`;
  return `Did you mean ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}?`;
}

function findSourceCommand(commandPath: string | undefined, root: AnyPadroneCommand): AnyPadroneCommand {
  if (!commandPath || commandPath === root.name || commandPath === root.path) return root;
  const parts = commandPath.split(' ');
  let current = root;
  for (const part of parts) {
    const found = current.commands?.find((c) => {
      resolveCommand(c);
      return c.name === part || c.aliases?.includes(part);
    });
    if (found) current = found;
    else break;
  }
  return current;
}

/** The mistyped command term of a routing error and the commands it may have meant. */
function similarCommands(err: RoutingError, rootCommand: AnyPadroneCommand): { term: string; similar: string[] } | undefined {
  const unknownMatch = err.message.match(/^Unknown command: (\S+)/);
  const unexpectedMatch = err.message.match(/^Unexpected arguments for '[^']+': (\S+)/);
  const term = unknownMatch?.[1] ?? unexpectedMatch?.[1];
  if (!term) return undefined;

  const sourceCmd = findSourceCommand(err.command, rootCommand);

  const candidateNames: string[] = [];
  if (sourceCmd.commands) {
    for (const cmd of sourceCmd.commands) {
      resolveCommand(cmd);
      if (!cmd.hidden) {
        candidateNames.push(cmd.name);
        if (cmd.aliases) candidateNames.push(...cmd.aliases);
      }
    }
  }

  return { term, similar: suggestSimilar(term, candidateNames) };
}

function enrichRoutingError(err: unknown, rootCommand: AnyPadroneCommand): unknown {
  if (!(err instanceof RoutingError)) return err;
  const found = similarCommands(err, rootCommand);
  const suggestionText = found ? formatSuggestions(found.similar) : '';
  if (!suggestionText) return err;

  const suggestions = [suggestionText];
  const enrichedMsg = `${err.message}\n\n  ${suggestionText}`;
  return new RoutingError(enrichedMsg, { suggestions, command: err.command });
}

function enrichIssuesWithSuggestions(
  issues: readonly { path?: readonly unknown[]; message: string }[],
  knownOptions: () => string[],
): typeof issues {
  return issues.map((i: any) => {
    // Handle direct unknown option detection (from checkUnknownArgs)
    const unknownMatch = i.message?.match(/^Unknown option: "([^"]+)"$/);
    if (unknownMatch) {
      const similar = suggestSimilar(unknownMatch[1], knownOptions());
      if (similar.length) {
        const hint = formatSuggestions(similar, '--');
        return { ...i, message: `${i.message} ${hint}` };
      }
      return i;
    }

    // Handle Zod strict schema errors (Unrecognized key(s) in object: "foo")
    const keys: string[] | undefined = i.keys ?? i.message?.match(/[Uu]nrecognized key(?:s)?[^"]*"([^"]+)"/)?.slice(1);
    if (!keys?.length) return i;
    const hints = keys.flatMap((k: string) => {
      const similar = suggestSimilar(k, knownOptions());
      return similar.length ? [formatSuggestions(similar, '--')] : [];
    });
    if (!hints.length) return i;
    return { ...i, message: `${i.message} ${hints.join(' ')}` };
  });
}

/** `input` with the first `term` token replaced by `replacement`, or `undefined` when there's no such token. */
function replaceTerm(input: PadroneInput | undefined, term: string, replacement: string): PadroneInput | undefined {
  if (Array.isArray(input)) {
    const index = input.indexOf(term);
    return index === -1 ? undefined : input.with(index, replacement);
  }
  if (typeof input !== 'string') return undefined;
  const pattern = new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  return pattern.test(input) ? input.replace(pattern, `$1${replacement}`) : undefined;
}

/** People type commands in `cli()` and the REPL; there the runtime must be able to ask. */
function canAsk(ctx: InterceptorParseContext): boolean {
  const { runtime } = ctx;
  return (
    (ctx.caller === 'cli' || ctx.caller === 'repl') &&
    !!runtime.prompt &&
    runtime.interactive !== 'unsupported' &&
    runtime.interactive !== 'disabled'
  );
}

function createSuggestionsInterceptor(options: PadroneSuggestionsOptions) {
  return defineInterceptor({ id: 'padrone:suggestions', name: 'padrone:suggestions', order: -500 }, () => ({
    parse(ctx, next) {
      // Each accepted suggestion fixes one term, so a few attempts cover typos at several levels
      const attempt = (overrides: { input?: PadroneInput } | undefined, tries: number): ReturnType<typeof next> => {
        const fail = (err: unknown) => {
          const enriched = enrichRoutingError(err, ctx.command);
          if (options.run !== 'prompt' || tries >= 5 || !(err instanceof RoutingError) || !canAsk(ctx)) throw enriched;
          const suggestion = similarCommands(err, ctx.command);
          const replacement = suggestion?.similar[0];
          const input = replacement && replaceTerm(overrides?.input ?? ctx.input, suggestion.term, replacement);
          if (!input) throw enriched;
          const message = `Unknown command "${suggestion.term}". Run "${replacement}" instead?`;
          return ctx.runtime.prompt!({ name: 'suggestion', message, type: 'confirm', default: true }).then((yes) => {
            if (yes !== true) throw enriched;
            return attempt({ input }, tries + 1);
          });
        };
        try {
          const result = next(overrides);
          return result instanceof Promise ? result.catch(fail) : result;
        } catch (err) {
          return fail(err);
        }
      };
      return attempt(undefined, 0);
    },
    validate(ctx, next) {
      const result = next();
      return thenMaybe(result, (v) => {
        if (!v.argsResult?.issues?.length) return v;
        // Suggested as help shows them: `--out-dir` for `outDir`, unless kebab-case aliases are turned off
        const optionNames = () => {
          const names = getKnownOptionNames(ctx.command);
          return ctx.command.meta?.autoAlias === false ? names : [...new Set(names.map((name) => camelToKebab(name) ?? name))];
        };
        const enriched = enrichIssuesWithSuggestions(v.argsResult.issues, optionNames);
        return { ...v, argsResult: { ...v.argsResult, issues: enriched } } as typeof v;
      });
    },
  }));
}

export type PadroneSuggestionsOptions = {
  /**
   * `'prompt'`: after an unknown command in `cli()` or the REPL, ask whether to run the closest match instead
   * ("Unknown command "dpeloy". Run "deploy" instead?"), like oclif's plugin-not-found. Needs a terminal to ask in;
   * otherwise (and when declined) the error is reported with its "Did you mean" hint.
   */
  run?: 'prompt';
};

/** Extension that adds "Did you mean?" hints to unknown commands and options, and optionally offers to run the closest command. */
export function padroneSuggestions(options: PadroneSuggestionsOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = createSuggestionsInterceptor(options);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
