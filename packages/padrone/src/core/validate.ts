import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AnyPadroneCommand, InterceptorValidateResult, PadroneInput } from '../types/index.ts';
import { camelToKebab } from '../util/shell-utils.ts';
import {
  coerceArgs,
  createOptionArityLookup,
  detectUnknownArgs,
  extractSchemaMetadata,
  getJsonSchema,
  getOptionArity,
  parsePositionalConfig,
  preprocessArgs,
} from './args.ts';
import { getCommandRuntime } from './commands.ts';
import type { OptionArity, ParseResolver } from './parse.ts';
import { getNestedValue, parseCliInputToParts, setNestedValue } from './parse.ts';
import { thenMaybe } from './results.ts';

/** Options the command's interceptors (and its ancestors') read from `rawArgs`, keyed by name or flag. */
function collectInterceptorOptions(command: AnyPadroneCommand): Record<string, OptionArity> {
  const options: Record<string, OptionArity> = {};
  for (let current: AnyPadroneCommand | undefined = command; current; current = current.parent) {
    for (const { meta } of current.interceptors ?? []) {
      if (meta.disabled || !meta.options) continue;
      for (const [key, arity] of Object.entries(meta.options)) options[key] ??= arity;
    }
  }
  return options;
}

type CommandOptionInfo = ReturnType<typeof extractSchemaMetadata> & {
  arity: (key: string[], short: boolean) => OptionArity | undefined;
  arrayArguments: Set<string>;
};

function getCommandOptionInfo(command: AnyPadroneCommand): CommandOptionInfo {
  const metadata = command.argsSchema
    ? extractSchemaMetadata(command.argsSchema, command.meta?.fields, command.meta?.autoAlias)
    : { flags: {}, aliases: {}, negatives: {}, customNegation: new Set<string>() };
  const schemaArity = createOptionArityLookup(command.argsSchema, metadata);
  const interceptorOptions = collectInterceptorOptions(command);

  const arrayArguments = new Set<string>();
  if (command.argsSchema) {
    try {
      const jsonSchema = getJsonSchema(command.argsSchema) as Record<string, any>;
      if (jsonSchema.type === 'object' && jsonSchema.properties) {
        for (const [key, prop] of Object.entries(jsonSchema.properties as Record<string, any>)) {
          if (getOptionArity(prop) === 'array') arrayArguments.add(key);
        }
      }
    } catch {
      // Ignore schema parsing errors
    }
  }

  return {
    ...metadata,
    arrayArguments,
    arity: (key, short) => schemaArity(key, short) ?? (key.length === 1 ? interceptorOptions[key[0]!] : undefined),
  };
}

/**
 * A resolver that follows routing while tokenizing, so each option's arity is looked up
 * on the command it appears under.
 */
export function createParseResolver(
  rootCommand: AnyPadroneCommand,
  findCommandByName: FindCommandFn,
  skipRootName: boolean,
): ParseResolver {
  let current = rootCommand;
  let routing = true;
  let first = true;
  const cache = new Map<AnyPadroneCommand, CommandOptionInfo>();
  const info = (command: AnyPadroneCommand) => {
    let entry = cache.get(command);
    if (!entry) cache.set(command, (entry = getCommandOptionInfo(command)));
    return entry;
  };

  return {
    arity: (key, short) => info(current).arity(key, short),
    isCommand: (term) => routing && !!findCommandByName(term, current.commands),
    enter(term) {
      const isFirst = first;
      first = false;
      if (!routing) return;
      if (isFirst && skipRootName && term === rootCommand.name) return;
      const found = findCommandByName(term, current.commands);
      if (found) current = found;
      else routing = false;
    },
  };
}

/**
 * Parses CLI input to find the command and extract raw arguments without validation.
 * A string is tokenized; an array (argv) is taken as already tokenized. Without input, reads the runtime's argv.
 *
 * A string input may start with the program name (`eval('my-cli build')`); argv never does.
 */
export function parseCommand(input: PadroneInput | undefined, rootCommand: AnyPadroneCommand, findCommandByName: FindCommandFn) {
  input ??= getCommandRuntime(rootCommand).argv();
  const empty = { rawArgs: {} as Record<string, unknown>, args: [] as string[], unmatchedTerms: [] as string[], issues: undefined };
  if (!input.length) {
    const defaultCommand = findCommandByName('', rootCommand.commands);
    return { command: defaultCommand ?? rootCommand, ...empty };
  }

  const skipRootName = typeof input === 'string';
  const parts = parseCliInputToParts(input, createParseResolver(rootCommand, findCommandByName, skipRootName));

  const terms = parts.filter((p) => p.type === 'term').map((p) => p.value);
  const argTokens = parts.filter((p) => p.type === 'arg').map((p) => p.value);

  let curCommand: AnyPadroneCommand = rootCommand;
  let unmatchedTerms: string[] = [];

  if (skipRootName && terms[0] === rootCommand.name) terms.shift();

  for (let i = 0; i < terms.length; i++) {
    const found = findCommandByName(terms[i]!, curCommand.commands);
    if (found) {
      curCommand = found;
    } else {
      unmatchedTerms = terms.slice(i);
      argTokens.unshift(...unmatchedTerms);
      break;
    }
  }

  if (unmatchedTerms.length === 0 && curCommand.commands?.length) {
    const defaultCommand = findCommandByName('', curCommand.commands);
    if (defaultCommand) curCommand = defaultCommand;
  }

  const { flags, aliases, negatives, customNegation, arrayArguments } = getCommandOptionInfo(curCommand);

  const rawArgs: Record<string, unknown> = {};
  let issues: StandardSchemaV1.Issue[] | undefined;

  for (const arg of parts) {
    if (arg.type !== 'named' && arg.type !== 'alias') continue;

    let key: string[];
    const [head] = arg.key;
    const single = arg.key.length === 1 ? head! : undefined;
    if (arg.type === 'alias' && single !== undefined && Object.hasOwn(flags, single)) {
      key = [flags[single]!];
    } else if (arg.type === 'named' && head !== undefined && Object.hasOwn(aliases, head)) {
      key = [aliases[head]!, ...arg.key.slice(1)];
    } else if (arg.type === 'named' && !arg.negated && single !== undefined && Object.hasOwn(negatives, single)) {
      // Negative keyword: --remote sets local to false
      setNestedValue(rawArgs, [negatives[single]!], false);
      continue;
    } else {
      key = arg.key;
    }

    const rootKey = key[0]!;

    if (arg.missing) {
      const display = arg.type === 'alias' ? `-${arg.key[0]}` : `--${arg.key.join('.')}`;
      (issues ??= []).push({ path: key, message: `Option "${display}" requires a value` });
      continue;
    }

    if (arg.type === 'named' && arg.negated) {
      // Skip --no- prefix negation for args with custom negation
      if (customNegation.has(rootKey)) {
        // Treat as unknown: put it back as `no-<key>` so detectUnknownArgs catches it
        setNestedValue(rawArgs, [`no-${key.join('.')}`], false);
        continue;
      }
      setNestedValue(rawArgs, key, false);
      continue;
    }

    const value = arg.value ?? true;

    if (arrayArguments.has(rootKey)) {
      // Array options accumulate across repeats: --tag a --tag b. A single value stays as given;
      // coercion wraps it when the schema only accepts arrays.
      const existing = getNestedValue(rawArgs, key);
      const values = Array.isArray(value) ? value : [value];
      if (existing === undefined) setNestedValue(rawArgs, key, value);
      else if (Array.isArray(existing)) existing.push(...values);
      else setNestedValue(rawArgs, key, [existing, ...values]);
    } else {
      // Other options take the last value given, like most CLIs: --name a --name b → "b"
      setNestedValue(rawArgs, key, value);
    }
  }

  return { command: curCommand, rawArgs, args: argTokens, unmatchedTerms, issues };
}

/**
 * Warnings for a deprecated command, and for each deprecated option set in `rawArgs`
 * (from `.meta({ deprecated })` or the `fields` config).
 */
export function getDeprecationWarnings(command: AnyPadroneCommand, rawArgs: Record<string, unknown>): string[] {
  const suffix = (deprecated: unknown) => (typeof deprecated === 'string' && deprecated ? `: ${deprecated}` : '');
  const warnings: string[] = [];
  if (command.deprecated) warnings.push(`Warning: command "${command.path || command.name}" is deprecated${suffix(command.deprecated)}`);

  let properties: Record<string, any> = {};
  if (command.argsSchema) {
    try {
      const jsonSchema = getJsonSchema(command.argsSchema);
      if (jsonSchema.type === 'object' && jsonSchema.properties) properties = jsonSchema.properties;
    } catch {}
  }

  for (const key of Object.keys(rawArgs)) {
    const deprecated = command.meta?.fields?.[key]?.deprecated ?? properties[key]?.deprecated;
    if (deprecated) warnings.push(`Warning: option "--${camelToKebab(key) ?? key}" is deprecated${suffix(deprecated)}`);
  }
  return warnings;
}

type FindCommandFn = (name: string, commands?: AnyPadroneCommand[]) => AnyPadroneCommand | undefined;

/**
 * Preprocesses raw arguments: maps positional arguments and performs auto-coercion.
 * External data sources (stdin, env, config) are handled by extensions before this runs.
 */
export function buildCommandArgs(
  command: AnyPadroneCommand,
  rawArgs: Record<string, unknown>,
  positionalArgs: string[],
): { args: Record<string, unknown>; issues?: StandardSchemaV1.Issue[] } {
  let preprocessedArgs = preprocessArgs(rawArgs, { flags: {}, aliases: {} });
  let issues: StandardSchemaV1.Issue[] | undefined;

  const positionalConfig = command.meta?.positional ? parsePositionalConfig(command.meta.positional) : [];
  let argIndex = 0;

  if (positionalConfig.length > 0) {
    for (let i = 0; i < positionalConfig.length; i++) {
      const { name, variadic } = positionalConfig[i]!;
      if (argIndex >= positionalArgs.length) break;

      // Detect ambiguity: same arg provided both positionally and as a named option
      if (name in preprocessedArgs) {
        issues ??= [];
        issues.push({ path: [name], message: `Ambiguous argument "${name}": provided both positionally and as a named option` });
        continue;
      }

      if (variadic) {
        const remainingPositionals = positionalConfig.slice(i + 1);
        const nonVariadicAfter = remainingPositionals.filter((p) => !p.variadic).length;
        const variadicEnd = positionalArgs.length - nonVariadicAfter;
        preprocessedArgs[name] = positionalArgs.slice(argIndex, variadicEnd);
        argIndex = variadicEnd;
      } else {
        preprocessedArgs[name] = positionalArgs[argIndex];
        argIndex++;
      }
    }
  }

  const excess = positionalArgs.slice(argIndex);
  if (excess.length > 0 && !issues) {
    issues = [
      {
        path: [],
        message:
          positionalConfig.length > 0
            ? `Too many arguments: expected at most ${positionalConfig.length}, got ${positionalArgs.length} (unexpected: ${excess.join(' ')})`
            : `Unexpected argument${excess.length > 1 ? 's' : ''}: ${excess.join(' ')}`,
      },
    ];
  }

  if (command.argsSchema) {
    preprocessedArgs = coerceArgs(preprocessedArgs, command.argsSchema);
  }

  return { args: preprocessedArgs, issues };
}

/**
 * Detects unknown options in args that aren't defined in the schema.
 * Returns unknown key info with suggestions, or empty array if schema is loose.
 */
export function checkUnknownArgs(command: AnyPadroneCommand, preprocessedArgs: Record<string, unknown>): { key: string }[] {
  if (!command.argsSchema) {
    const unknowns: { key: string }[] = [];
    for (const key of Object.keys(preprocessedArgs)) {
      unknowns.push({ key });
    }
    return unknowns;
  }

  const argsMeta = command.meta?.fields;
  const { flags, aliases, negatives } = extractSchemaMetadata(command.argsSchema, argsMeta, command.meta?.autoAlias);

  return detectUnknownArgs(preprocessedArgs, command.argsSchema, flags, aliases, negatives);
}

/**
 * Validates preprocessed arguments against the command's schema.
 * First checks for unknown args (strict by default), then runs schema validation.
 * Returns sync or async result depending on the schema's validate method.
 */
export function validateCommandArgs(command: AnyPadroneCommand, preprocessedArgs: Record<string, unknown>) {
  const unknownArgs = checkUnknownArgs(command, preprocessedArgs);
  if (unknownArgs.length > 0) {
    const issues: StandardSchemaV1.Issue[] = unknownArgs.map(({ key }) => ({
      path: [key],
      message: `Unknown option: "${key}"`,
    }));
    return { args: undefined, argsResult: { issues } as any };
  }

  const argsParsed = command.argsSchema ? command.argsSchema['~standard'].validate(preprocessedArgs) : { value: {} };

  const buildResult = (parsed: StandardSchemaV1.Result<unknown>) => ({
    args: parsed.issues ? undefined : (parsed.value as any),
    argsResult: parsed as any,
  });

  return thenMaybe(argsParsed, buildResult);
}

/**
 * Returns the list of known option names from a command's schema (for fuzzy suggestion).
 */
export function getKnownOptionNames(command: AnyPadroneCommand): string[] {
  if (!command.argsSchema) return [];
  try {
    const js = getJsonSchema(command.argsSchema) as Record<string, any>;
    if (js.type === 'object' && js.properties) return Object.keys(js.properties);
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Formats validation issue messages for display.
 */
export function formatIssueMessages(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((i) => {
      const path = i.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.');
      return path ? `  - ${path}: ${i.message}` : `  - ${i.message}`;
    })
    .join('\n');
}

/**
 * Core validate function for parse() — preprocesses and validates CLI args.
 * Used by the parse program method (lighter weight than the full exec pipeline).
 * External data sources (stdin, env, config) are not resolved here — use eval() for that.
 */
export function coreValidateForParse(
  command: AnyPadroneCommand,
  rawArgs: Record<string, unknown>,
  positionalArgs: string[],
): InterceptorValidateResult | Promise<InterceptorValidateResult> {
  const { args: preprocessedArgs, issues } = buildCommandArgs(command, rawArgs, positionalArgs);
  if (issues) return { args: undefined, argsResult: { issues } as any };
  const validated = validateCommandArgs(command, preprocessedArgs);
  return thenMaybe(validated, (v) => v as InterceptorValidateResult);
}
