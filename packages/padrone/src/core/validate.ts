import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AnyPadroneCommand, InterceptorValidateResult, PadroneInput } from '../types/index.ts';
import { coerceArgs, detectUnknownArgs, extractSchemaMetadata, getJsonSchema, parsePositionalConfig, preprocessArgs } from './args.ts';
import { getCommandRuntime } from './commands.ts';
import { getNestedValue, parseCliInputToParts, setNestedValue } from './parse.ts';
import { thenMaybe } from './results.ts';

/**
 * Parses CLI input to find the command and extract raw arguments without validation.
 * A string is tokenized; an array (argv) is taken as already tokenized. Without input, reads the runtime's argv.
 */
export function parseCommand(input: PadroneInput | undefined, rootCommand: AnyPadroneCommand, findCommandByName: FindCommandFn) {
  input ??= getCommandRuntime(rootCommand).argv();
  if (!input.length) {
    const defaultCommand = findCommandByName('', rootCommand.commands);
    if (defaultCommand) {
      return { command: defaultCommand, rawArgs: {} as Record<string, unknown>, args: [] as string[], unmatchedTerms: [] as string[] };
    }
    return { command: rootCommand, rawArgs: {} as Record<string, unknown>, args: [] as string[], unmatchedTerms: [] as string[] };
  }

  const parts = parseCliInputToParts(input);

  const terms = parts.filter((p) => p.type === 'term').map((p) => p.value);
  const argTokens = parts.filter((p) => p.type === 'arg').map((p) => p.value);

  let curCommand: AnyPadroneCommand | undefined = rootCommand;
  let unmatchedTerms: string[] = [];

  if (terms[0] === rootCommand.name) terms.shift();

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i] || '';
    const found = findCommandByName(term, curCommand.commands);

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

  if (!curCommand) return { command: rootCommand, rawArgs: {} as Record<string, unknown>, args: argTokens, unmatchedTerms };

  const argsMeta = curCommand.meta?.fields;
  const schemaMetadata = curCommand.argsSchema
    ? extractSchemaMetadata(curCommand.argsSchema, argsMeta, curCommand.meta?.autoAlias)
    : { flags: {}, aliases: {}, negatives: {}, customNegation: new Set<string>() };
  const { flags, aliases, negatives, customNegation } = schemaMetadata;

  const arrayArguments = new Set<string>();
  if (curCommand.argsSchema) {
    try {
      const jsonSchema = getJsonSchema(curCommand.argsSchema) as Record<string, any>;
      if (jsonSchema.type === 'object' && jsonSchema.properties) {
        for (const [key, prop] of Object.entries(jsonSchema.properties as Record<string, any>)) {
          if (prop?.type === 'array') arrayArguments.add(key);
        }
      }
    } catch {
      // Ignore schema parsing errors
    }
  }

  const argParts = parts.filter((p) => p.type === 'named' || p.type === 'alias');
  const rawArgs: Record<string, unknown> = {};

  for (const arg of argParts) {
    let key: string[];
    if (arg.type === 'alias' && arg.key.length === 1 && flags[arg.key[0]!]) {
      key = [flags[arg.key[0]!]!];
    } else if (arg.type === 'named' && arg.key.length === 1 && aliases[arg.key[0]!]) {
      key = [aliases[arg.key[0]!]!];
    } else if (arg.type === 'named' && arg.key.length === 1 && negatives[arg.key[0]!]) {
      // Negative keyword: --remote sets local to false
      setNestedValue(rawArgs, [negatives[arg.key[0]!]!], false);
      continue;
    } else {
      key = arg.key;
    }

    const rootKey = key[0]!;

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
      const existing = getNestedValue(rawArgs, key);
      if (existing !== undefined) {
        if (Array.isArray(existing)) {
          if (Array.isArray(value)) existing.push(...value);
          else existing.push(value);
        } else {
          if (Array.isArray(value)) setNestedValue(rawArgs, key, [existing, ...value]);
          else setNestedValue(rawArgs, key, [existing, value]);
        }
      } else {
        setNestedValue(rawArgs, key, Array.isArray(value) ? value : [value]);
      }
    } else {
      const existing = getNestedValue(rawArgs, key);
      if (existing !== undefined) {
        if (Array.isArray(existing)) {
          if (Array.isArray(value)) existing.push(...value);
          else existing.push(value);
        } else {
          if (Array.isArray(value)) setNestedValue(rawArgs, key, [existing, ...value]);
          else setNestedValue(rawArgs, key, [existing, value]);
        }
      } else {
        setNestedValue(rawArgs, key, value);
      }
    }
  }

  return { command: curCommand, rawArgs, args: argTokens, unmatchedTerms };
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

  if (positionalConfig.length > 0) {
    let argIndex = 0;
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
      } else if (i === positionalConfig.length - 1 && positionalArgs.length > argIndex + 1) {
        preprocessedArgs[name] = positionalArgs.slice(argIndex).join(' ');
        argIndex = positionalArgs.length;
      } else {
        preprocessedArgs[name] = positionalArgs[argIndex];
        argIndex++;
      }
    }
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
  return issues.map((i) => `  - ${i.path?.join('.') || 'root'}: ${i.message}`).join('\n');
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
