import { resolveCommand, suggestSimilar } from '../core/commands.ts';
import { RoutingError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { getKnownOptionNames } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
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

function enrichRoutingError(err: unknown, rootCommand: AnyPadroneCommand): unknown {
  if (!(err instanceof RoutingError)) return err;

  const unknownMatch = err.message.match(/^Unknown command: (\S+)/);
  const unexpectedMatch = err.message.match(/^Unexpected arguments for '[^']+': (\S+)/);
  const term = unknownMatch?.[1] ?? unexpectedMatch?.[1];
  if (!term) return err;

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

  const similar = suggestSimilar(term, candidateNames);
  const suggestionText = formatSuggestions(similar);
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

const suggestionsInterceptor = defineInterceptor({ id: 'padrone:suggestions', name: 'padrone:suggestions', order: -500 }, () => ({
  parse(ctx, next) {
    try {
      const result = next();
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          throw enrichRoutingError(err, ctx.command);
        });
      }
      return result;
    } catch (err) {
      throw enrichRoutingError(err, ctx.command);
    }
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

export function padroneSuggestions(): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(suggestionsInterceptor)) as any;
}
